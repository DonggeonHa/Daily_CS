-- Run against a fully migrated database. Synthetic fixtures and clock changes roll back.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
select daily_cs_private.take_owner_lock();

create or replace function daily_cs_private.schedule_now() returns timestamptz
language sql stable set search_path='' as $$ select current_setting('daily_cs_test.now')::timestamptz $$;
create or replace function daily_cs_private.mail_now() returns timestamptz
language sql stable set search_path='' as $$ select daily_cs_private.schedule_now() $$;

do $test$
declare
  token text := 'synthetic-weekday-' || gen_random_uuid();
  lesson uuid := gen_random_uuid();
  actor uuid := gen_random_uuid();
  candidate jsonb;
  response jsonb;
  message jsonb;
  request jsonb;
  snapshot uuid;
  stale_id uuid;
  manual_id uuid;
  boundary_id uuid;
  day date;
  manual_kind text;
  old_history text;
begin
  -- Given synthetic Friday through Tuesday, with no competing manual work.
  if exists(select 1 from daily_cs_private.day_snapshots where snapshot_date >= date '2038-01-01')
    or exists(select 1 from daily_cs_private.mail_outbox where kind <> 'daily' and state in ('queued','claimed'))
    or exists(select 1 from daily_cs_private.mail_render_requests r where r.kind <> 'daily' and not r.suspended
      and not exists(select 1 from daily_cs_private.mail_outbox m where m.id=r.id)) then
    raise exception 'weekday test requires unused 2038 dates and no pending manual commands';
  end if;
  select md5(coalesce(string_agg(to_jsonb(d)::text,'' order by d.snapshot_date),'')) into old_history
  from daily_cs_private.day_snapshots d;
  insert into daily_cs_private.api_credentials(scope,token_hash,label)
    values('mail',daily_cs_private.sha256_text(token),'synthetic weekday regression');
  insert into daily_cs_private.lessons(id,owner_uid,title,category,state,document_kind,draft_document,published_revision)
    values(lesson,actor,'Synthetic weekday lesson','synthetic','published','markdown',
      '{"markdown":"## Synthetic\nComplete synthetic learning content for weekday delivery."}',1);
  insert into daily_cs_private.lesson_revisions(lesson_id,revision_number,title,category,document_kind,document,content_hash,created_by)
    values(lesson,1,'Synthetic weekday lesson','synthetic','markdown',
      '{"markdown":"## Synthetic\nComplete synthetic learning content for weekday delivery."}','synthetic-weekday-hash',actor);
  update daily_cs_private.settings set start_date='2038-01-01',send_time='09:00',mail_paused=false;
  update daily_cs_private.schedule_state set last_frozen_date='2037-12-31';
  insert into daily_cs_private.settings_time_events(effective_date,send_time) values('2038-01-01','09:00');
  insert into daily_cs_private.schedule_overrides(schedule_date,mode,lesson_id)
    select date '2038-01-01'+i,'lesson',lesson from generate_series(0,4) i;

  foreach day in array array[date '2038-01-01',date '2038-01-02',date '2038-01-03',date '2038-01-04',date '2038-01-05'] loop
    perform set_config('daily_cs_test.now',day::text || 'T00:05:00Z',true);
    -- When regular preparation runs at 09:05 KST.
    response := public.daily_cs_mail_api('mail.prepareDue','{}',token);
    candidate := response #> '{data,candidate}';
    select id into snapshot from daily_cs_private.day_snapshots where snapshot_date=day;
    -- Then web learning freezes every calendar date, including the weekend.
    if snapshot is null or not exists(select 1 from daily_cs_private.day_snapshots
      where id=snapshot and lesson_id=lesson and document is not null) then
      raise exception 'web learning must continue on %',day;
    end if;
    if extract(isodow from day) in (6,7) then
      if candidate is distinct from 'null'::jsonb then raise exception 'weekend daily candidate must be absent: %',day; end if;
      if exists(select 1 from daily_cs_private.mail_render_requests where kind='daily' and scheduled_date=day) then
        raise exception 'ensure_mail_due must not create a weekend request';
      end if;
      -- Given a weekend request/outbox left over from before the policy change.
      stale_id := gen_random_uuid();
      insert into daily_cs_private.mail_render_requests(id,kind,snapshot_id,scheduled_date,send_after)
        values(stale_id,'daily',snapshot,day,(day+time '09:00') at time zone 'Asia/Seoul');
      response := public.daily_cs_mail_api('mail.prepareDue','{}',token);
      if response #> '{data,candidate}' is distinct from 'null'::jsonb then raise exception 'preexisting weekend request must stay idle'; end if;
      response := public.daily_cs_mail_api('mail.materialize',jsonb_build_object('candidateId',stale_id,
        'contentHash','synthetic-weekday-hash','text','synthetic body','html','<p>synthetic body</p>'),token);
      if response #>> '{error,code}' is distinct from 'conflict' then raise exception 'weekend materialization must fail'; end if;
      insert into daily_cs_private.mail_outbox(id,kind,snapshot_id,scheduled_date,send_after,subject,text_body,html_body)
        values(stale_id,'daily',snapshot,day,(day+time '09:00') at time zone 'Asia/Seoul','synthetic','synthetic','<p>synthetic</p>');
      response := public.daily_cs_mail_api('mail.claimDue','{"workerId":"synthetic"}',token);
      if response #> '{data,message}' is distinct from 'null'::jsonb then raise exception 'weekend queued daily must not be claimed'; end if;
      update daily_cs_private.mail_outbox set state='claimed',claim_token_hash=daily_cs_private.sha256_text('synthetic-claim'),
        claim_expires_at=daily_cs_private.mail_now()+interval '10 minutes' where id=stale_id;
      request := jsonb_build_object('messageId',stale_id,'claimToken','synthetic-claim','commandId',gen_random_uuid());
      response := public.daily_cs_mail_api('mail.resumeClaim',request,token);
      if response #>> '{error,code}' is distinct from 'conflict' then raise exception 'weekend claimed daily must not resume'; end if;
      response := public.daily_cs_mail_api('mail.beginSending',request,token);
      if response #>> '{error,code}' is distinct from 'conflict' then raise exception 'weekend claimed daily must not begin sending'; end if;
      if not exists(select 1 from daily_cs_private.mail_outbox where id=stale_id and state='claimed'
        and claim_token_hash=daily_cs_private.sha256_text('synthetic-claim')) then raise exception 'denied claim must remain unchanged'; end if;
      -- ACK recovery still accepts a send that had already begun before the change.
      update daily_cs_private.mail_outbox set state='uncertain' where id=stale_id;
      response := public.daily_cs_mail_api('mail.ackSent',request,token);
      if response #>> '{data,state}' is distinct from 'sent' then raise exception 'weekend ACK recovery must remain available'; end if;

      foreach manual_kind in array array['test','resend'] loop
        manual_id := gen_random_uuid();
        insert into daily_cs_private.mail_render_requests(id,kind,snapshot_id,scheduled_date,send_after,command_id)
          values(manual_id,manual_kind::daily_cs_private.mail_kind,snapshot,day,daily_cs_private.schedule_now(),gen_random_uuid());
        response := public.daily_cs_mail_api('mail.prepareDue','{}',token);
        if response #>> '{data,candidate,id}' is distinct from manual_id::text then raise exception 'explicit weekend % must be preparable',manual_kind; end if;
        response := public.daily_cs_mail_api('mail.materialize',jsonb_build_object('candidateId',manual_id,
          'contentHash','synthetic-weekday-hash','text','synthetic manual body','html','<p>synthetic manual body</p>'),token);
        if response #>> '{data,state}' is distinct from 'queued' then raise exception 'explicit weekend % must materialize',manual_kind; end if;
        message := public.daily_cs_mail_api('mail.claimDue','{"workerId":"synthetic"}',token) #> '{data,message}';
        request := jsonb_build_object('messageId',manual_id,'claimToken',message->>'claimToken','commandId',message->>'commandId');
        response := public.daily_cs_mail_api('mail.resumeClaim',request,token);
        if response #>> '{data,message,id}' is distinct from manual_id::text then raise exception 'explicit weekend % must resume',manual_kind; end if;
        response := public.daily_cs_mail_api('mail.beginSending',request,token);
        if response #>> '{data,state}' is distinct from 'sending' then raise exception 'explicit weekend % must begin sending',manual_kind; end if;
        perform public.daily_cs_mail_api('mail.ackSent',request,token);
      end loop;
      -- Leave a real stale weekend queue item for Monday's no-backlog check.
      update daily_cs_private.mail_outbox set state='queued',claim_token_hash=null,claim_expires_at=null where id=stale_id;
    else
      if candidate->>'date' is distinct from day::text then raise exception 'weekday candidate must use its current date: %',day; end if;
      response := public.daily_cs_mail_api('mail.materialize',jsonb_build_object('candidateId',candidate->>'id',
        'contentHash',candidate->>'contentHash','text','synthetic daily body','html','<p>synthetic daily body</p>'),token);
      if response #>> '{data,state}' is distinct from 'queued' then raise exception 'weekday must materialize'; end if;
      message := public.daily_cs_mail_api('mail.claimDue','{"workerId":"synthetic"}',token) #> '{data,message}';
      if message->>'date' is distinct from day::text then raise exception 'Monday must not claim weekend backlog'; end if;
      request := jsonb_build_object('messageId',message->>'id','claimToken',message->>'claimToken','commandId',message->>'commandId');
      response := public.daily_cs_mail_api('mail.resumeClaim',request,token);
      if response #>> '{data,message,date}' is distinct from day::text then raise exception 'weekday claim must resume'; end if;
      response := public.daily_cs_mail_api('mail.beginSending',request,token);
      if response #>> '{data,state}' is distinct from 'sending' then raise exception 'weekday must begin sending'; end if;
      perform public.daily_cs_mail_api('mail.ackSent',request,token);
    end if;
  end loop;
  if (select count(*) from daily_cs_private.day_snapshots where snapshot_date between '2038-01-01' and '2038-01-05') <> 5 then
    raise exception 'all five web dates must be frozen';
  end if;
  if old_history is distinct from (select md5(coalesce(string_agg(to_jsonb(d)::text,'' order by d.snapshot_date),''))
    from daily_cs_private.day_snapshots d where snapshot_date < '2038-01-01') then raise exception 'existing snapshot history changed'; end if;

  -- Given UTC Friday but KST Saturday, a still-active midnight queue is weekend work.
  perform set_config('daily_cs_test.now','2038-01-08T15:05:00Z',true);
  boundary_id := gen_random_uuid();
  insert into daily_cs_private.mail_outbox(id,kind,scheduled_date,send_after,subject,text_body,html_body)
    values(boundary_id,'daily','2038-01-09','2038-01-08T15:00:00Z','synthetic boundary','synthetic','<p>synthetic</p>');
  response := public.daily_cs_mail_api('mail.claimDue','{"workerId":"synthetic-boundary"}',token);
  if response #> '{data,message}' is distinct from 'null'::jsonb then raise exception 'UTC Friday/KST Saturday must not claim weekend mail'; end if;
  update daily_cs_private.mail_outbox set state='claimed',claim_token_hash=daily_cs_private.sha256_text('synthetic-boundary'),
    claim_expires_at=daily_cs_private.mail_now()+interval '10 minutes' where id=boundary_id;
  request := jsonb_build_object('messageId',boundary_id,'claimToken','synthetic-boundary','commandId',gen_random_uuid());
  response := public.daily_cs_mail_api('mail.beginSending',request,token);
  if response #>> '{error,code}' is distinct from 'conflict' then raise exception 'UTC Friday/KST Saturday must not begin weekend mail'; end if;
  if daily_cs_private.is_mail_weekday(('2038-01-08T15:00:00Z'::timestamptz at time zone 'Asia/Seoul')::date)
    or not daily_cs_private.is_mail_weekday(('2038-01-10T15:00:00Z'::timestamptz at time zone 'Asia/Seoul')::date) then
    raise exception 'weekday predicate must follow KST date across UTC day boundaries';
  end if;
  if has_function_privilege('anon','daily_cs_private.is_mail_weekday(date)','EXECUTE')
    or has_function_privilege('authenticated','daily_cs_private.is_mail_weekday(date)','EXECUTE')
    or has_function_privilege('service_role','daily_cs_private.is_mail_weekday(date)','EXECUTE') then
    raise exception 'weekday predicate must remain private';
  end if;
end $test$;
rollback;
