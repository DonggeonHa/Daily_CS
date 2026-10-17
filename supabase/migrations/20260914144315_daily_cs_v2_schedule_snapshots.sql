create table daily_cs_private.schedule_state (
  singleton boolean primary key default true check (singleton),
  cycle integer not null default 1 check (cycle > 0),
  last_frozen_date date not null
);
insert into daily_cs_private.schedule_state(singleton, last_frozen_date)
select true, coalesce(max(d.snapshot_date), s.start_date - 1)
from daily_cs_private.settings s left join daily_cs_private.day_snapshots d on true
where s.singleton group by s.start_date;

create table daily_cs_private.schedule_catalog_order (
  lesson_id uuid primary key references daily_cs_private.lessons(id) on delete cascade,
  position bigint not null unique
);
create table daily_cs_private.schedule_queue (
  id bigint generated always as identity primary key,
  cycle integer not null check (cycle > 0),
  lesson_id uuid not null references daily_cs_private.lessons(id) on delete cascade,
  position bigint not null,
  consumed_date date,
  unique(cycle, lesson_id)
);
create index schedule_queue_pending_idx on daily_cs_private.schedule_queue(cycle, position, id)
where consumed_date is null;

create table daily_cs_private.settings_time_events (
  effective_date date primary key,
  send_time time not null,
  created_at timestamptz not null default now()
);
insert into daily_cs_private.settings_time_events(effective_date, send_time)
select start_date, send_time from daily_cs_private.settings where singleton;

alter table daily_cs_private.day_snapshots
  add column send_eligible_at timestamptz,
  add column cycle integer not null default 1,
  add column is_review boolean not null default false,
  add column override_reason text;
update daily_cs_private.day_snapshots d
set send_eligible_at = (d.snapshot_date + s.send_time) at time zone s.timezone
from daily_cs_private.settings s where s.singleton;
alter table daily_cs_private.day_snapshots alter column send_eligible_at set not null;

create table daily_cs_private.manual_snapshots (
  id uuid primary key default gen_random_uuid(),
  preview_date date not null,
  lesson_id uuid,
  revision_id uuid,
  legacy_id integer,
  title text not null,
  category text not null,
  document_kind daily_cs_private.document_kind not null,
  document jsonb not null,
  content_hash text not null,
  created_at timestamptz not null default now()
);
alter table daily_cs_private.mail_outbox
  add column if not exists manual_snapshot_id uuid;
alter table daily_cs_private.mail_outbox add constraint mail_manual_snapshot_fk
  foreign key(manual_snapshot_id) references daily_cs_private.manual_snapshots(id) on delete restrict;

create table daily_cs_private.mail_render_requests (
  id uuid primary key default gen_random_uuid(),
  kind daily_cs_private.mail_kind not null,
  snapshot_id uuid references daily_cs_private.day_snapshots(id) on delete restrict,
  manual_snapshot_id uuid references daily_cs_private.manual_snapshots(id) on delete restrict,
  supersedes_message_id uuid references daily_cs_private.mail_outbox(id) on delete restrict,
  supersedes_request_id uuid references daily_cs_private.mail_render_requests(id) on delete restrict,
  scheduled_date date not null,
  send_after timestamptz not null,
  command_id uuid unique,
  request_hash text,
  suspended boolean not null default false,
  created_at timestamptz not null default now(),
  check (num_nonnulls(snapshot_id, manual_snapshot_id) = 1),
  check ((kind = 'daily' and command_id is null) or (kind <> 'daily' and command_id is not null))
);
create unique index render_daily_date_idx on daily_cs_private.mail_render_requests(scheduled_date) where kind = 'daily';
create index render_pending_idx on daily_cs_private.mail_render_requests(send_after, id);

create function daily_cs_private.reject_snapshot_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using errcode='55000',message='immutable snapshot cannot be changed';
end $$;
create trigger immutable_day_snapshot before update or delete on daily_cs_private.day_snapshots
for each row execute function daily_cs_private.reject_snapshot_change();
create trigger immutable_manual_snapshot before update or delete on daily_cs_private.manual_snapshots
for each row execute function daily_cs_private.reject_snapshot_change();
revoke insert,update,delete on daily_cs_private.day_snapshots,daily_cs_private.mail_outbox from authenticated;
revoke all on function daily_cs_private.reject_snapshot_change() from public,anon,authenticated,service_role;

alter table daily_cs_private.schedule_state enable row level security;
alter table daily_cs_private.schedule_catalog_order enable row level security;
alter table daily_cs_private.schedule_queue enable row level security;
alter table daily_cs_private.settings_time_events enable row level security;
alter table daily_cs_private.manual_snapshots enable row level security;
alter table daily_cs_private.mail_render_requests enable row level security;
revoke all on daily_cs_private.schedule_state, daily_cs_private.schedule_catalog_order,
  daily_cs_private.schedule_queue, daily_cs_private.settings_time_events,
  daily_cs_private.manual_snapshots, daily_cs_private.mail_render_requests
from public, anon, authenticated, service_role;

create function daily_cs_private.schedule_now()
returns timestamptz language sql stable set search_path = '' as $$ select now() $$;

create function daily_cs_private.schedule_at(day date)
returns timestamptz language sql stable set search_path = '' as $$
  select (day + coalesce((select e.send_time from daily_cs_private.settings_time_events e
    where e.effective_date <= day order by e.effective_date desc limit 1), time '09:00'))
    at time zone 'Asia/Seoul'
$$;

create function daily_cs_private.sync_schedule_catalog()
returns void language plpgsql volatile set search_path = '' as $$
declare current_cycle integer; next_position bigint;
begin
  select cycle into current_cycle from daily_cs_private.schedule_state where singleton for update;
  select coalesce(max(position),0) into next_position from daily_cs_private.schedule_catalog_order;
  insert into daily_cs_private.schedule_catalog_order(lesson_id,position)
  select l.id, next_position + row_number() over(order by l.legacy_id nulls last,l.created_at,l.id)
  from daily_cs_private.lessons l
  where l.state = 'published' and l.published_revision is not null
    and not exists(select 1 from daily_cs_private.schedule_catalog_order o where o.lesson_id=l.id);
  delete from daily_cs_private.schedule_queue q using daily_cs_private.lessons l
  where q.lesson_id=l.id and q.consumed_date is null and (l.state <> 'published' or l.published_revision is null);
  select coalesce(max(position),0) into next_position from daily_cs_private.schedule_queue where cycle=current_cycle;
  insert into daily_cs_private.schedule_queue(cycle,lesson_id,position)
  select current_cycle,l.id,next_position+row_number() over(order by o.position,l.id)
  from daily_cs_private.lessons l join daily_cs_private.schedule_catalog_order o on o.lesson_id=l.id
  where l.state='published' and l.published_revision is not null
    and not exists(select 1 from daily_cs_private.schedule_queue q where q.cycle=current_cycle and q.lesson_id=l.id);
end $$;

create function daily_cs_private.snapshot_day(d daily_cs_private.day_snapshots)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('date',d.snapshot_date,'status',case when d.document is null then 'empty' else 'frozen' end,
    'lessonId',d.lesson_id,'legacyId',d.legacy_id,'snapshotId',d.id,'revisionId',d.revision_id,
    'title',d.title,'category',d.category,'documentKind',d.document_kind,'document',d.document,
    'contentHash',d.content_hash,'sendEligibleAt',d.send_eligible_at,'cycle',d.cycle,
    'isReview',d.is_review,'emptyReason',d.empty_reason,'overrideReason',d.override_reason)
$$;

create function daily_cs_private.plan_schedule(through_date date, persist_days boolean default false)
returns setof jsonb language plpgsql volatile set search_path = '' as $$
declare
  s daily_cs_private.schedule_state;
  configured daily_cs_private.settings;
  d date;
  pending uuid[];
  active_ids uuid[];
  chosen uuid;
  override_row daily_cs_private.schedule_overrides;
  r daily_cs_private.lesson_revisions;
  snap daily_cs_private.day_snapshots;
  chosen_legacy integer;
  reviewed boolean;
  reason text;
  result jsonb;
  candidate uuid;
begin
  perform daily_cs_private.sync_schedule_catalog();
  select * into s from daily_cs_private.schedule_state where singleton;
  select * into configured from daily_cs_private.settings where singleton;
  select coalesce(array_agg(q.lesson_id order by q.position,q.id),'{}'::uuid[]) into pending
  from daily_cs_private.schedule_queue q where q.cycle=s.cycle and q.consumed_date is null;
  select coalesce(array_agg(l.id order by o.position,l.id),'{}'::uuid[]) into active_ids
  from daily_cs_private.lessons l join daily_cs_private.schedule_catalog_order o on o.lesson_id=l.id
  where l.state='published' and l.published_revision is not null;
  d := greatest(s.last_frozen_date+1,configured.start_date);
  while d <= through_date loop
    chosen := null; reviewed := false; reason := null; r := null; chosen_legacy := null;
    select * into override_row from daily_cs_private.schedule_overrides where schedule_date=d;
    if override_row.mode = 'empty' then
      reason := 'override_empty';
    else
      if cardinality(pending)=0 and cardinality(active_ids)>0 then
        s.cycle := s.cycle+1;
        pending := active_ids;
        if persist_days then
          insert into daily_cs_private.schedule_queue(cycle,lesson_id,position)
          select s.cycle,x.id,x.ordinality from unnest(active_ids) with ordinality x(id,ordinality)
          on conflict(cycle,lesson_id) do nothing;
        end if;
      end if;
      if override_row.mode='lesson' and override_row.lesson_id=any(active_ids) then
        chosen := override_row.lesson_id;
        reviewed := not (chosen=any(pending)) or exists(
          select 1 from daily_cs_private.day_snapshots h where h.lesson_id=chosen);
      else
        foreach candidate in array pending loop
          if not exists(select 1 from daily_cs_private.schedule_overrides later
            where later.schedule_date>d and later.mode='lesson' and later.lesson_id=candidate) then
            chosen := candidate;
            exit;
          end if;
        end loop;
      end if;
      if chosen is not null then
        pending := array_remove(pending,chosen);
        select rr.* into r
        from daily_cs_private.lessons l join daily_cs_private.lesson_revisions rr
          on rr.lesson_id=l.id and rr.revision_number=l.published_revision where l.id=chosen;
        select legacy_id into chosen_legacy from daily_cs_private.lessons where id=chosen;
        if persist_days then
          update daily_cs_private.schedule_queue set consumed_date=d
          where cycle=s.cycle and lesson_id=chosen and consumed_date is null;
        end if;
      else
        reason := case when cardinality(active_ids)=0 then 'no_published_lessons' else 'awaiting_override' end;
      end if;
    end if;
    if persist_days then
      insert into daily_cs_private.day_snapshots(snapshot_date,lesson_id,revision_id,legacy_id,title,category,
        document_kind,document,content_hash,empty_reason,send_eligible_at,cycle,is_review,override_reason,frozen_at)
      values(d,chosen,r.id,chosen_legacy,r.title,r.category,r.document_kind,r.document,r.content_hash,
        reason,daily_cs_private.schedule_at(d),s.cycle,reviewed,override_row.reason,daily_cs_private.schedule_now())
      returning * into snap;
      result := daily_cs_private.snapshot_day(snap);
    else
      result := jsonb_build_object('date',d,'status',case when chosen is null then 'empty' else 'scheduled' end,
        'lessonId',chosen,'legacyId',chosen_legacy,'snapshotId',null,'revisionId',r.id,'title',r.title,
        'category',r.category,'documentKind',r.document_kind,'document',r.document,'contentHash',r.content_hash,
        'sendEligibleAt',daily_cs_private.schedule_at(d),'cycle',s.cycle,'isReview',reviewed,
        'emptyReason',reason,'overrideReason',override_row.reason);
    end if;
    return next result;
    d := d+1;
  end loop;
  if persist_days and through_date>=greatest(s.last_frozen_date+1,configured.start_date) then
    update daily_cs_private.schedule_state set cycle=s.cycle,last_frozen_date=through_date where singleton;
  end if;
end $$;

create function daily_cs_private.freeze_schedule_internal()
returns void language plpgsql volatile set search_path = '' as $$
declare today date := (daily_cs_private.schedule_now() at time zone 'Asia/Seoul')::date; through_day date;
begin
  perform daily_cs_private.take_owner_lock();
  through_day := case when daily_cs_private.schedule_now() >= daily_cs_private.schedule_at(today)
    then today else today-1 end;
  perform * from daily_cs_private.plan_schedule(through_day,true);
end $$;

create or replace function daily_cs_private.freeze_elapsed_days()
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  perform daily_cs_private.require_active_owner();
  perform daily_cs_private.freeze_schedule_internal();
end $$;

create function daily_cs_private.on_catalog_change(lesson_id uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  perform daily_cs_private.require_active_owner();
  perform daily_cs_private.take_owner_lock();
  perform daily_cs_private.sync_schedule_catalog();
  update daily_cs_private.schedule_overrides o set mode='auto',lesson_id=null,reason=null,revision=revision+1
  where o.lesson_id=on_catalog_change.lesson_id
    and o.schedule_date>(select last_frozen_date from daily_cs_private.schedule_state where singleton)
    and not exists(select 1 from daily_cs_private.lessons l where l.id=o.lesson_id and l.state='published');
  update daily_cs_private.settings set schedule_revision=schedule_revision+1 where singleton;
end $$;

create function daily_cs_private.schedule_day(day date)
returns jsonb language plpgsql volatile set search_path = '' as $$
declare result jsonb; start_day date;
begin
  select start_date into start_day from daily_cs_private.settings where singleton;
  if day<start_day then
    return jsonb_build_object('date',day,'status','not_started','snapshotId',null,'lessonId',null,
      'document',null,'sendEligibleAt',daily_cs_private.schedule_at(start_day));
  end if;
  select daily_cs_private.snapshot_day(d) into result from daily_cs_private.day_snapshots d where snapshot_date=day;
  if result is not null then return result; end if;
  select planned into result from daily_cs_private.plan_schedule(day,false) planned where (planned->>'date')::date=day;
  return result;
end $$;

create function daily_cs_private.schedule_settings()
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('ownerUid',(select owner_uid from daily_cs_private.owner_profile where singleton),
    'timezone',s.timezone,'startDate',s.start_date,'sendTime',to_char(s.send_time,'HH24:MI'),
    'mailPaused',s.mail_paused,'revision',s.revision,'scheduleRevision',s.schedule_revision,
    'timeEffectiveDate',(select max(effective_date) from daily_cs_private.settings_time_events))
  from daily_cs_private.settings s where singleton
$$;

create function daily_cs_private.ensure_mail_due()
returns void language plpgsql volatile set search_path = '' as $$
declare today date := (daily_cs_private.schedule_now() at time zone 'Asia/Seoul')::date;
begin
  perform daily_cs_private.freeze_schedule_internal();
  insert into daily_cs_private.mail_render_requests(kind,snapshot_id,scheduled_date,send_after)
  select 'daily',d.id,d.snapshot_date,d.send_eligible_at
  from daily_cs_private.day_snapshots d cross join daily_cs_private.settings s
  where s.singleton and not s.mail_paused and d.snapshot_date=today and d.document is not null
    and daily_cs_private.schedule_now()>=d.send_eligible_at
    and daily_cs_private.schedule_now()<=d.send_eligible_at+interval '1 hour'
    and not exists(select 1 from daily_cs_private.mail_outbox m where m.kind='daily' and m.scheduled_date=today)
  on conflict (scheduled_date) where kind='daily' do nothing;
end $$;

create or replace function daily_cs_private.mail_schedule_api(action text,payload jsonb)
returns jsonb language plpgsql volatile set search_path = '' as $$
declare c daily_cs_private.mail_render_requests; source jsonb; existing daily_cs_private.mail_outbox;
begin
  perform daily_cs_private.take_owner_lock();
  if action='mail.prepareDue' then
    perform daily_cs_private.ensure_mail_due();
    select req.* into c from daily_cs_private.mail_render_requests req
    where not req.suspended and not exists(select 1 from daily_cs_private.mail_outbox m where m.id=req.id)
      and req.send_after<=daily_cs_private.schedule_now()
      and (req.kind<>'daily' or (req.scheduled_date=(daily_cs_private.schedule_now() at time zone 'Asia/Seoul')::date
        and daily_cs_private.schedule_now()<=req.send_after+interval '1 hour'
        and not (select mail_paused from daily_cs_private.settings where singleton)))
    order by req.send_after,req.created_at,req.id limit 1;
    if not found then return daily_cs_private.api_ok(jsonb_build_object('candidate',null)); end if;
  elsif action='mail.materialize' then
    select * into c from daily_cs_private.mail_render_requests where id=(payload->>'candidateId')::uuid for update;
    if not found then return daily_cs_private.api_error('not_found','mail candidate not found'); end if;
  else
    return daily_cs_private.api_error('bad_request','unknown materialization action');
  end if;
  if c.snapshot_id is not null then
    select daily_cs_private.snapshot_day(d) into source from daily_cs_private.day_snapshots d where id=c.snapshot_id;
  else
    select jsonb_build_object('date',m.preview_date,'snapshotId',m.id,'lessonId',m.lesson_id,
      'legacyId',m.legacy_id,'title',m.title,'category',m.category,'documentKind',m.document_kind,
      'document',m.document,'contentHash',m.content_hash,'revisionId',m.revision_id) into source
    from daily_cs_private.manual_snapshots m where id=c.manual_snapshot_id;
  end if;
  if action='mail.prepareDue' then
    return daily_cs_private.api_ok(jsonb_build_object('candidate',jsonb_build_object(
      'id',c.id,'kind',c.kind,'date',c.scheduled_date,'snapshotId',coalesce(c.snapshot_id,c.manual_snapshot_id),
      'contentHash',source->>'contentHash','lesson',source,'commandId',c.command_id)));
  end if;
  if payload->>'contentHash' is distinct from source->>'contentHash'
    or length(trim(coalesce(payload->>'text','')))=0 or length(trim(coalesce(payload->>'html','')))=0
    or length(coalesce(payload->>'text',''))>2000000 or length(coalesce(payload->>'html',''))>2000000 then
    return daily_cs_private.api_error('validation_failed','complete rendered content and matching snapshot hash required');
  end if;
  select * into existing from daily_cs_private.mail_outbox where id=c.id;
  if found then return daily_cs_private.api_ok(jsonb_build_object('messageId',existing.id,'state',existing.state)); end if;
  if c.suspended then
    return daily_cs_private.api_error('conflict','restored mail requires explicit mailbox confirmation');
  end if;
  if c.kind='daily' and (daily_cs_private.schedule_now()>c.send_after+interval '1 hour'
    or (select mail_paused from daily_cs_private.settings where singleton)) then
    return daily_cs_private.api_error('conflict','daily mail is outside its active send window');
  end if;
  insert into daily_cs_private.mail_outbox(id,kind,snapshot_id,manual_snapshot_id,supersedes_message_id,
    scheduled_date,send_after,subject,text_body,html_body,command_id)
  values(c.id,c.kind,c.snapshot_id,c.manual_snapshot_id,c.supersedes_message_id,c.scheduled_date,c.send_after,
    case when c.kind='test' then '[TEST] ' when c.kind='resend' then '[RESEND] ' else '' end
      || '매일매일 CS · ' || c.scheduled_date || ' · ' || (source->>'title'),
    payload->>'text',payload->>'html',c.command_id);
  return daily_cs_private.api_ok(jsonb_build_object('messageId',c.id,'state','queued'));
end $$;

create function daily_cs_private.owner_schedule_api(action text,payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  today date := (daily_cs_private.schedule_now() at time zone 'Asia/Seoul')::date;
  day date; finish date; amount integer; offset_count integer;
  s daily_cs_private.settings; result jsonb; days jsonb; item jsonb;
  chosen uuid; current_lesson daily_cs_private.lessons;
  revision daily_cs_private.lesson_revisions; manual_id uuid; command uuid; fingerprint text;
  candidate daily_cs_private.mail_render_requests; original_candidate daily_cs_private.mail_render_requests;
  original daily_cs_private.mail_outbox;
  ordered uuid[]; lookup_id text; date_field text;
begin
  perform daily_cs_private.require_active_owner();
  perform daily_cs_private.take_owner_lock();
  if jsonb_typeof(payload) is distinct from 'object' then
    return daily_cs_private.api_error('bad_request','payload must be an object');
  end if;
  foreach date_field in array array['date','from','to'] loop
    if payload->>date_field is not null and ((payload->>date_field)!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or to_char((payload->>date_field)::date,'YYYY-MM-DD')<>payload->>date_field) then
      return daily_cs_private.api_error('validation_failed','dates must use YYYY-MM-DD');
    end if;
  end loop;
  perform daily_cs_private.freeze_schedule_internal();
  select * into s from daily_cs_private.settings where singleton for update;
  if action='settings.get' then return daily_cs_private.api_ok(daily_cs_private.schedule_settings()); end if;
  if action='settings.update' then
    if (payload->>'expectedRevision')::integer is distinct from s.revision then
      return daily_cs_private.api_error('conflict','settings revision changed');
    end if;
    if payload ? 'sendTime' then
      if (payload->>'sendTime') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
        return daily_cs_private.api_error('validation_failed','sendTime must be HH:MM');
      end if;
      insert into daily_cs_private.settings_time_events(effective_date,send_time)
      values(greatest(today+1,s.start_date),(payload->>'sendTime')::time)
      on conflict(effective_date) do update set send_time=excluded.send_time,created_at=daily_cs_private.schedule_now();
    end if;
    update daily_cs_private.settings updated set send_time=coalesce((payload->>'sendTime')::time,updated.send_time),
      mail_paused=coalesce((payload->>'mailPaused')::boolean,updated.mail_paused),revision=updated.revision+1,schedule_revision=updated.schedule_revision+1
    where updated.singleton;
    return daily_cs_private.api_ok(daily_cs_private.schedule_settings());
  end if;
  if action='dashboard.get' then
    day := case when daily_cs_private.schedule_now()>=daily_cs_private.schedule_at(today) then today else today-1 end;
    return daily_cs_private.api_ok(jsonb_build_object('today',daily_cs_private.schedule_day(day),
      'tomorrow',daily_cs_private.schedule_day(greatest(today+1,s.start_date)),
      'settings',daily_cs_private.schedule_settings(),'counts',jsonb_build_object(
        'draft',(select count(*) from daily_cs_private.lessons where state='draft'),
        'published',(select count(*) from daily_cs_private.lessons where state='published'),
        'trash',(select count(*) from daily_cs_private.lessons where state='trash'),
        'queuedMail',(select count(*) from daily_cs_private.mail_render_requests r where not exists(
          select 1 from daily_cs_private.mail_outbox m where m.id=r.id and m.state not in ('queued','claimed'))),
        'uncertainMail',(select count(*) from daily_cs_private.mail_outbox where state in ('sending','uncertain')))));
  end if;
  if action='reader.snapshot' then
    select daily_cs_private.snapshot_day(d)||jsonb_build_object('kind','daily') into result
    from daily_cs_private.day_snapshots d where d.id=(payload->>'snapshotId')::uuid;
    if result is null then
      select jsonb_build_object('date',m.preview_date,'status','frozen','kind','manual','snapshotId',m.id,
        'lessonId',m.lesson_id,'legacyId',m.legacy_id,'revisionId',m.revision_id,'title',m.title,
        'category',m.category,'documentKind',m.document_kind,'document',m.document,'contentHash',m.content_hash)
      into result from daily_cs_private.manual_snapshots m where m.id=(payload->>'snapshotId')::uuid;
    end if;
    if result is null then return daily_cs_private.api_error('not_found','snapshot not found'); end if;
    return daily_cs_private.api_ok(jsonb_build_object('day',result));
  end if;
  if action in ('reader.today','reader.lesson') then
    if payload ? 'lessonId' or action='reader.lesson' then
      lookup_id:=coalesce(payload->>'lessonId',payload->>'id');
      select * into current_lesson from daily_cs_private.lessons l where l.state='published'
        and case when lookup_id~'^[0-9]+$' then l.legacy_id=lookup_id::integer else l.id::text=lower(lookup_id) end;
      if not found then return daily_cs_private.api_error('not_found','published lesson not found'); end if;
      select * into revision from daily_cs_private.lesson_revisions
      where lesson_id=current_lesson.id and revision_number=current_lesson.published_revision;
      return daily_cs_private.api_ok(jsonb_build_object('day',jsonb_build_object('status','library','date',null,
        'snapshotId',null,'lessonId',current_lesson.id,'legacyId',current_lesson.legacy_id,'revisionId',revision.id,
        'title',revision.title,'category',revision.category,'documentKind',revision.document_kind,
        'document',revision.document,'contentHash',revision.content_hash)));
    end if;
    day := coalesce((payload->>'date')::date,case when daily_cs_private.schedule_now()>=daily_cs_private.schedule_at(today) then today else today-1 end);
    if day>today+3660 then return daily_cs_private.api_error('validation_failed','date is too far in the future'); end if;
    return daily_cs_private.api_ok(jsonb_build_object('day',daily_cs_private.schedule_day(day)));
  end if;
  if action in ('schedule.get','reader.history') then
    day := coalesce((payload->>'from')::date,s.start_date);
    if action='reader.history' then finish := coalesce((payload->>'to')::date,today);
    else
      amount := coalesce((payload->>'days')::integer,31);
      if amount<1 or amount>366 then return daily_cs_private.api_error('validation_failed','days must be 1 through 366'); end if;
      finish := day+amount-1;
    end if;
    if finish<day or finish-day>3660 or finish>today+3660 then
      return daily_cs_private.api_error('validation_failed','invalid date range');
    end if;
    days := '[]'::jsonb;
    for item in select daily_cs_private.snapshot_day(d) from daily_cs_private.day_snapshots d
      where d.snapshot_date between day and finish order by d.snapshot_date loop
      if not(payload ? 'category') or item->>'category'=payload->>'category' then days:=days||jsonb_build_array(item); end if;
    end loop;
    if action='schedule.get' then
      for item in select p from daily_cs_private.plan_schedule(finish,false) p where (p->>'date')::date>=day loop
        days:=days||jsonb_build_array(item);
      end loop;
    end if;
    return daily_cs_private.api_ok(jsonb_build_object('days',days,'scheduleRevision',s.schedule_revision));
  end if;
  if action='reader.search' then
    amount := coalesce((payload->>'limit')::integer,50);
    offset_count := coalesce(nullif(payload->>'cursor','')::integer,0);
    if amount<1 or amount>100 or offset_count<0 then return daily_cs_private.api_error('validation_failed','invalid pagination'); end if;
    select coalesce(jsonb_agg(x.body order by x.sort_title,x.id),'[]') into days from (
      select l.id,r.title sort_title,jsonb_build_object('kind','lesson','id',l.id,'lessonId',l.id,'legacyId',l.legacy_id,
        'title',r.title,'category',r.category,'publishedRevision',r.revision_number,'documentKind',r.document_kind,
        'document',r.document,'contentHash',r.content_hash,'summary',r.document->>'summary','keywords',r.document->'keywords') body
      from daily_cs_private.lessons l join daily_cs_private.lesson_revisions r
        on r.lesson_id=l.id and r.revision_number=l.published_revision
      where l.state='published' and (not(payload ? 'category') or r.category=payload->>'category')
        and (coalesce(payload->>'query','')='' or position(lower(payload->>'query') in lower(r.title||' '||r.category||' '||r.document::text))>0)
      order by r.title,l.id limit amount+1 offset offset_count
    ) x;
    result := jsonb_build_object('items',case when jsonb_array_length(days)>amount then days-(jsonb_array_length(days)-1) else days end,
      'nextCursor',case when jsonb_array_length(days)>amount then (offset_count+amount)::text else null end);
    return daily_cs_private.api_ok(result);
  end if;
  if action in ('schedule.setOverride','schedule.rebuildFuture') then
    if (payload->>'expectedScheduleRevision')::integer is distinct from s.schedule_revision then
      return daily_cs_private.api_error('conflict','schedule revision changed');
    end if;
    day := coalesce((payload->>'date')::date,(payload->>'from')::date,greatest(today+1,s.start_date));
    if day<greatest(today+1,s.start_date) then
      return daily_cs_private.api_error('validation_failed','only tomorrow or later can change');
    end if;
    if action='schedule.setOverride' then
      if payload->>'mode'='lesson' then
        chosen := (payload->>'lessonId')::uuid;
        if not exists(select 1 from daily_cs_private.lessons where id=chosen and state='published' and published_revision is not null) then
          return daily_cs_private.api_error('validation_failed','override requires a published lesson');
        end if;
        delete from daily_cs_private.schedule_overrides where lesson_id=chosen and schedule_date>=greatest(today+1,s.start_date) and schedule_date<>day;
      elsif payload->>'mode' in ('auto','empty') then chosen:=null;
      else return daily_cs_private.api_error('validation_failed','invalid override mode'); end if;
      insert into daily_cs_private.schedule_overrides(schedule_date,mode,lesson_id,reason)
      values(day,(payload->>'mode')::daily_cs_private.override_mode,chosen,nullif(left(payload->>'reason',200),''))
      on conflict(schedule_date) do update set mode=excluded.mode,lesson_id=excluded.lesson_id,reason=excluded.reason,
        revision=daily_cs_private.schedule_overrides.revision+1,updated_at=daily_cs_private.schedule_now();
    elsif payload ? 'orderedLessonIds' then
      select array_agg(x::uuid) into ordered from jsonb_array_elements_text(payload->'orderedLessonIds') x;
      if coalesce(cardinality(ordered),0)<>(select count(*) from daily_cs_private.lessons where state='published')
        or coalesce(cardinality(ordered),0)<>(select count(distinct x) from unnest(ordered) x)
        or exists(select 1 from unnest(ordered) x where not exists(select 1 from daily_cs_private.lessons l where l.id=x and l.state='published')) then
        return daily_cs_private.api_error('validation_failed','order must contain every published lesson exactly once');
      end if;
      delete from daily_cs_private.schedule_catalog_order;
      insert into daily_cs_private.schedule_catalog_order(lesson_id,position)
      select x.id,x.ordinality from unnest(ordered) with ordinality x(id,ordinality);
      update daily_cs_private.schedule_queue q set position=o.position
      from daily_cs_private.schedule_catalog_order o where q.lesson_id=o.lesson_id and q.consumed_date is null;
    end if;
    update daily_cs_private.settings set schedule_revision=schedule_revision+1 where singleton returning * into s;
    return daily_cs_private.api_ok(jsonb_build_object('scheduleRevision',s.schedule_revision,'day',daily_cs_private.schedule_day(day)));
  end if;
  if action='mail.status' then
    day := coalesce((payload->>'from')::date,s.start_date); amount:=coalesce((payload->>'days')::integer,14);
    if amount<1 or amount>3660 then return daily_cs_private.api_error('validation_failed','invalid mail range'); end if;
    select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'date',r.scheduled_date,'kind',r.kind,
      'state',coalesce(m.state::text,case when r.suspended then 'uncertain' else 'queued' end),'renderPending',m.id is null,
      'snapshotId',coalesce(r.snapshot_id,r.manual_snapshot_id),'scheduledFor',r.send_after,
      'claimedUntil',m.claim_expires_at,'sentAt',m.sent_at,'lastError',coalesce(m.last_error,
        case when r.suspended then 'Restored mail requires mailbox confirmation' end)) order by r.send_after,r.id),'[]')
    into days from daily_cs_private.mail_render_requests r left join daily_cs_private.mail_outbox m on m.id=r.id
    where r.scheduled_date between day and day+amount-1;
    return daily_cs_private.api_ok(jsonb_build_object('items',days));
  end if;
  if action in ('mail.enqueueTest','mail.retryUncertain') then
    command := (payload->>'commandId')::uuid;
    if command is null then return daily_cs_private.api_error('validation_failed','commandId is required'); end if;
    fingerprint := daily_cs_private.document_hash(jsonb_build_object('action',action,
      'date',payload->>'date','lessonId',payload->>'lessonId','messageId',payload->>'messageId',
      'expectedState',payload->>'expectedState','mailboxChecked',payload->'mailboxChecked'));
    select * into candidate from daily_cs_private.mail_render_requests where command_id=command;
    if found then
      if candidate.request_hash is distinct from fingerprint then return daily_cs_private.api_error('conflict','commandId was used for a different request'); end if;
      return daily_cs_private.api_ok(jsonb_build_object('messageId',candidate.id,'state',coalesce(
        (select state::text from daily_cs_private.mail_outbox where id=candidate.id),
        case when candidate.suspended then 'uncertain' else 'queued' end),'kind',candidate.kind));
    end if;
    if exists(select 1 from daily_cs_private.mail_outbox where command_id=command) then
      return daily_cs_private.api_error('conflict','commandId already exists');
    end if;
    if action='mail.retryUncertain' then
      if payload->>'expectedState' is distinct from 'uncertain' or coalesce((payload->>'mailboxChecked')::boolean,false) is not true then
        return daily_cs_private.api_error('validation_failed','uncertain state and mailbox confirmation are required');
      end if;
      select * into original from daily_cs_private.mail_outbox where id=(payload->>'messageId')::uuid and state='uncertain' for update;
      if found then
        insert into daily_cs_private.mail_render_requests(kind,snapshot_id,manual_snapshot_id,supersedes_message_id,
          scheduled_date,send_after,command_id,request_hash)
        values('resend',original.snapshot_id,original.manual_snapshot_id,original.id,original.scheduled_date,
          daily_cs_private.schedule_now(),command,fingerprint) returning * into candidate;
      else
        select * into original_candidate from daily_cs_private.mail_render_requests
        where id=(payload->>'messageId')::uuid and suspended for update;
        if not found then return daily_cs_private.api_error('conflict','message is no longer uncertain'); end if;
        insert into daily_cs_private.mail_render_requests(kind,snapshot_id,manual_snapshot_id,supersedes_request_id,
          scheduled_date,send_after,command_id,request_hash)
        values('resend',original_candidate.snapshot_id,original_candidate.manual_snapshot_id,original_candidate.id,
          original_candidate.scheduled_date,daily_cs_private.schedule_now(),command,fingerprint) returning * into candidate;
      end if;
    else
      day:=coalesce((payload->>'date')::date,greatest(today,s.start_date));
      if payload ? 'lessonId' then
        select * into current_lesson from daily_cs_private.lessons where id=(payload->>'lessonId')::uuid and state='published';
        if not found then return daily_cs_private.api_error('not_found','published lesson not found'); end if;
        select * into revision from daily_cs_private.lesson_revisions where lesson_id=current_lesson.id and revision_number=current_lesson.published_revision;
        result:=jsonb_build_object('lessonId',current_lesson.id,'legacyId',current_lesson.legacy_id,'revisionId',revision.id,
          'title',revision.title,'category',revision.category,'documentKind',revision.document_kind,'document',revision.document,'contentHash',revision.content_hash);
      else result:=daily_cs_private.schedule_day(day); end if;
      if result->'document' is null or result->'document'='null'::jsonb then
        return daily_cs_private.api_error('not_found','no published lesson available for the test');
      end if;
      insert into daily_cs_private.manual_snapshots(preview_date,lesson_id,revision_id,legacy_id,title,category,document_kind,document,content_hash)
      values(day,(result->>'lessonId')::uuid,(result->>'revisionId')::uuid,(result->>'legacyId')::integer,
        result->>'title',result->>'category',(result->>'documentKind')::daily_cs_private.document_kind,result->'document',result->>'contentHash') returning id into manual_id;
      insert into daily_cs_private.mail_render_requests(kind,manual_snapshot_id,scheduled_date,send_after,command_id,request_hash)
      values('test',manual_id,day,daily_cs_private.schedule_now(),command,fingerprint) returning * into candidate;
    end if;
    return daily_cs_private.api_ok(jsonb_build_object('messageId',candidate.id,'state','queued','kind',candidate.kind,'renderPending',true));
  end if;
  return daily_cs_private.api_error('bad_request','unknown schedule action');
exception when insufficient_privilege then return daily_cs_private.api_error('forbidden','active owner session required');
  when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range or not_null_violation or check_violation then
    return daily_cs_private.api_error('validation_failed','payload failed validation');
end $$;

create function daily_cs_private.export_schedule_state()
returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('schemaVersion',1,
    'state',(select to_jsonb(s) from daily_cs_private.schedule_state s where singleton),
    'catalogOrder',coalesce((select jsonb_agg(to_jsonb(o) order by position) from daily_cs_private.schedule_catalog_order o),'[]'),
    'queue',coalesce((select jsonb_agg(to_jsonb(q) order by cycle,position,id) from daily_cs_private.schedule_queue q),'[]'),
    'timeEvents',coalesce((select jsonb_agg(to_jsonb(e) order by effective_date) from daily_cs_private.settings_time_events e),'[]'),
    'manualSnapshots',coalesce((select jsonb_agg(to_jsonb(m) order by created_at,id) from daily_cs_private.manual_snapshots m),'[]'),
    'renderRequests',coalesce((select jsonb_agg(to_jsonb(r) order by created_at,id) from daily_cs_private.mail_render_requests r),'[]'),
    'mailOutbox',coalesce((select jsonb_agg(to_jsonb(m)-'claim_token_hash'-'claimed_by'-'claim_expires_at'-'sending_command_id'
      order by created_at,id) from daily_cs_private.mail_outbox m),'[]'))
$$;

create function daily_cs_private.restore_schedule_state(schedule_export jsonb)
returns void language plpgsql volatile security definer set search_path='' as $$
declare restored_state daily_cs_private.schedule_state; last_snapshot date; start_day date; part text;
begin
  perform daily_cs_private.require_active_owner();
  perform daily_cs_private.take_owner_lock();
  if schedule_export->>'schemaVersion' is distinct from '1' or jsonb_typeof(schedule_export->'state') is distinct from 'object' then
    raise exception using errcode='22023',message='validation_failed: invalid schedule export';
  end if;
  foreach part in array array['catalogOrder','queue','timeEvents','manualSnapshots','renderRequests','mailOutbox'] loop
    if jsonb_typeof(schedule_export->part) is distinct from 'array' then
      raise exception using errcode='22023',message='validation_failed: incomplete schedule export';
    end if;
  end loop;
  select * into restored_state from jsonb_populate_record(null::daily_cs_private.schedule_state,schedule_export->'state');
  select start_date into start_day from daily_cs_private.settings where singleton;
  select coalesce(max(snapshot_date),(select start_date-1 from daily_cs_private.settings where singleton))
    into last_snapshot from daily_cs_private.day_snapshots;
  if restored_state.last_frozen_date is distinct from last_snapshot or restored_state.cycle is null or restored_state.cycle<1 then
    raise exception using errcode='22023',message='conflict: restored cursor must match preserved date snapshots';
  end if;
  if restored_state.cycle is distinct from coalesce((select cycle from daily_cs_private.day_snapshots
      order by snapshot_date desc limit 1),1)
    or (last_snapshot>=start_day and (select count(*) from daily_cs_private.day_snapshots
      where snapshot_date between start_day and last_snapshot)<>last_snapshot-start_day+1) then
    raise exception using errcode='22023',message='conflict: restored history must be contiguous with its cycle';
  end if;
  if exists(select 1 from jsonb_populate_recordset(null::daily_cs_private.schedule_queue,schedule_export->'queue') q
    where q.cycle>restored_state.cycle or (q.consumed_date is null and q.cycle<>restored_state.cycle)) then
    raise exception using errcode='22023',message='conflict: restored queue cycle is invalid';
  end if;
  if exists(select 1 from jsonb_populate_recordset(null::daily_cs_private.manual_snapshots,schedule_export->'manualSnapshots') incoming
    where incoming.content_hash is distinct from daily_cs_private.document_hash(incoming.document)
      or exists(select 1 from daily_cs_private.manual_snapshots existing where existing.id=incoming.id
        and (existing.preview_date,existing.lesson_id,existing.revision_id,existing.title,existing.category,
          existing.document_kind,existing.document,existing.content_hash)
          is distinct from (incoming.preview_date,incoming.lesson_id,incoming.revision_id,incoming.title,incoming.category,
          incoming.document_kind,incoming.document,incoming.content_hash))) then
    raise exception using errcode='22023',message='conflict: immutable manual snapshot differs';
  end if;
  if exists(select 1 from jsonb_populate_recordset(null::daily_cs_private.settings_time_events,schedule_export->'timeEvents') incoming
    join daily_cs_private.settings_time_events existing using(effective_date)
    where incoming.effective_date<=last_snapshot and incoming.send_time<>existing.send_time) then
    raise exception using errcode='22023',message='conflict: historical schedule time differs';
  end if;
  if exists(select 1 from jsonb_populate_recordset(null::daily_cs_private.schedule_queue,schedule_export->'queue') q
    where q.consumed_date is not null and not exists(select 1 from daily_cs_private.day_snapshots d
      where d.snapshot_date=q.consumed_date and d.lesson_id=q.lesson_id and d.cycle=q.cycle)) then
    raise exception using errcode='22023',message='conflict: consumed queue does not match immutable history';
  end if;
  insert into daily_cs_private.manual_snapshots
  select * from jsonb_populate_recordset(null::daily_cs_private.manual_snapshots,schedule_export->'manualSnapshots')
  on conflict(id) do nothing;
  insert into daily_cs_private.mail_outbox(id,kind,supersedes_message_id,snapshot_id,manual_snapshot_id,
    scheduled_date,send_after,state,subject,text_body,html_body,sending_started_at,sent_at,
    provider_message_id,command_id,last_error,created_at,updated_at)
  select m.id,m.kind,m.supersedes_message_id,m.snapshot_id,m.manual_snapshot_id,m.scheduled_date,m.send_after,
    case when m.state='sent' then 'sent'::daily_cs_private.mail_state else 'uncertain'::daily_cs_private.mail_state end,
    m.subject,m.text_body,m.html_body,m.sending_started_at,m.sent_at,m.provider_message_id,m.command_id,
    case when m.state='sent' then m.last_error else 'Restored mail requires mailbox confirmation' end,m.created_at,daily_cs_private.schedule_now()
  from jsonb_populate_recordset(null::daily_cs_private.mail_outbox,schedule_export->'mailOutbox') m
  on conflict(id) do nothing;
  insert into daily_cs_private.mail_render_requests(id,kind,snapshot_id,manual_snapshot_id,supersedes_message_id,
    supersedes_request_id,scheduled_date,send_after,command_id,request_hash,suspended,created_at)
  select r.id,r.kind,r.snapshot_id,r.manual_snapshot_id,r.supersedes_message_id,r.supersedes_request_id,
    r.scheduled_date,r.send_after,r.command_id,r.request_hash,true,r.created_at
  from jsonb_populate_recordset(null::daily_cs_private.mail_render_requests,schedule_export->'renderRequests') r
  on conflict(id) do nothing;
  delete from daily_cs_private.schedule_queue;
  insert into daily_cs_private.schedule_queue(id,cycle,lesson_id,position,consumed_date) overriding system value
  select id,cycle,lesson_id,position,consumed_date
  from jsonb_populate_recordset(null::daily_cs_private.schedule_queue,schedule_export->'queue');
  perform pg_catalog.setval(pg_catalog.pg_get_serial_sequence('daily_cs_private.schedule_queue','id'),
    greatest(1,coalesce((select max(id) from daily_cs_private.schedule_queue),0)),true);
  delete from daily_cs_private.schedule_catalog_order;
  insert into daily_cs_private.schedule_catalog_order
  select * from jsonb_populate_recordset(null::daily_cs_private.schedule_catalog_order,schedule_export->'catalogOrder');
  delete from daily_cs_private.settings_time_events where effective_date>last_snapshot;
  insert into daily_cs_private.settings_time_events
  select * from jsonb_populate_recordset(null::daily_cs_private.settings_time_events,schedule_export->'timeEvents')
  on conflict(effective_date) do nothing;
  update daily_cs_private.schedule_state set cycle=restored_state.cycle,last_frozen_date=restored_state.last_frozen_date where singleton;
end $$;

revoke all on function daily_cs_private.schedule_now(),daily_cs_private.schedule_at(date),
  daily_cs_private.sync_schedule_catalog(),daily_cs_private.snapshot_day(daily_cs_private.day_snapshots),
  daily_cs_private.plan_schedule(date,boolean),daily_cs_private.freeze_schedule_internal(),
  daily_cs_private.freeze_elapsed_days(),daily_cs_private.on_catalog_change(uuid),
  daily_cs_private.schedule_day(date),daily_cs_private.schedule_settings(),
  daily_cs_private.ensure_mail_due(),daily_cs_private.mail_schedule_api(text,jsonb),
  daily_cs_private.owner_schedule_api(text,jsonb),daily_cs_private.export_schedule_state(),
  daily_cs_private.restore_schedule_state(jsonb)
from public,anon,authenticated,service_role;
grant execute on function daily_cs_private.owner_schedule_api(text,jsonb),
  daily_cs_private.freeze_elapsed_days(),daily_cs_private.on_catalog_change(uuid) to authenticated;
