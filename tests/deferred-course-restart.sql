-- Synthetic future clocks and fixtures stay inside a rolled-back transaction.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
select daily_cs_private.take_owner_lock();
create or replace function daily_cs_private.schedule_now() returns timestamptz
language sql stable set search_path='' as $$ select current_setting('daily_cs_test.now')::timestamptz $$;

do $test$
declare
  actor uuid;
  session_id uuid := gen_random_uuid();
  first_lesson uuid := gen_random_uuid();
  second_lesson uuid := gen_random_uuid();
  sunday_lesson uuid := gen_random_uuid();
  old_monday_lesson uuid := gen_random_uuid();
  old_tuesday_lesson uuid := gen_random_uuid();
  lesson uuid;
  state_before jsonb;
  exported jsonb;
  old_snapshots text;
  old_mail text;
  planned jsonb[];
  original_sunday jsonb;
  reader jsonb;
begin
  if exists(select 1 from daily_cs_private.day_snapshots where snapshot_date >= date '2038-01-03') then
    raise exception 'restart test requires unused 2038 dates';
  end if;
  select owner_uid into actor from daily_cs_private.owner_profile where singleton;
  insert into auth.sessions(id,user_id) values(session_id,actor);
  perform set_config('request.jwt.claim.sub',actor::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'session_id',session_id)::text,true);
  select md5(coalesce(string_agg(to_jsonb(d)::text,'' order by snapshot_date),'')) into old_snapshots from daily_cs_private.day_snapshots d;
  select md5(coalesce(string_agg(to_jsonb(m)::text,'' order by id),'')) into old_mail from daily_cs_private.mail_outbox m;

  -- Given the old cycle's next item is Sunday 034, and catalog order begins 001,002.
  foreach lesson in array array[first_lesson,second_lesson,sunday_lesson,old_monday_lesson,old_tuesday_lesson] loop
    insert into daily_cs_private.lessons(id,owner_uid,title,category,state,document_kind,draft_document,published_revision)
      values(lesson,actor,'Synthetic restart lesson','synthetic','published','markdown','{"markdown":"Synthetic restart body."}',1);
    insert into daily_cs_private.lesson_revisions(lesson_id,revision_number,title,category,document_kind,document,content_hash,created_by)
      values(lesson,1,'Synthetic restart lesson','synthetic','markdown','{"markdown":"Synthetic restart body."}',
        daily_cs_private.document_hash('{"markdown":"Synthetic restart body."}'),actor);
  end loop;
  delete from daily_cs_private.schedule_queue where consumed_date is null;
  delete from daily_cs_private.schedule_catalog_order;
  insert into daily_cs_private.schedule_catalog_order values(first_lesson,1),(second_lesson,2),(sunday_lesson,3),
    (old_monday_lesson,4),(old_tuesday_lesson,5);
  update daily_cs_private.settings set start_date='2038-01-03',send_time='09:00',mail_paused=false;
  update daily_cs_private.schedule_state set cycle=10000,last_frozen_date='2038-01-02',pending_restart_date='2038-01-04';
  insert into daily_cs_private.settings_time_events(effective_date,send_time) values('2038-01-03','09:00');
  insert into daily_cs_private.schedule_queue(cycle,lesson_id,position)
    values(10000,sunday_lesson,1),(10000,old_monday_lesson,2),(10000,old_tuesday_lesson,3);
  perform daily_cs_private.sync_schedule_catalog();
  select to_jsonb(s) into state_before from daily_cs_private.schedule_state s;

  -- When previewing Sunday/Monday/Tuesday before the event takes effect.
  select array_agg(p order by p->>'date') into planned from daily_cs_private.plan_schedule('2038-01-05',false) p;
  -- Then preview restarts at Monday without consuming the event or freezing early.
  if planned[1]->>'lessonId' is distinct from sunday_lesson::text
    or planned[2]->>'lessonId' is distinct from first_lesson::text
    or planned[3]->>'lessonId' is distinct from second_lesson::text then
    raise exception 'preview must be Sunday034, Monday001, Tuesday002';
  end if;
  if state_before is distinct from (select to_jsonb(s) from daily_cs_private.schedule_state s)
    or exists(select 1 from daily_cs_private.schedule_queue where cycle=10001)
    or exists(select 1 from daily_cs_private.day_snapshots where snapshot_date >= date '2038-01-03') then
    raise exception 'preview must not consume restart, create a new queue, or freeze future days';
  end if;

  perform set_config('daily_cs_test.now','2038-01-03T00:00:00Z',true);
  perform daily_cs_private.ensure_mail_due();
  select daily_cs_private.snapshot_day(d) into original_sunday from daily_cs_private.day_snapshots d where snapshot_date='2038-01-03';
  if original_sunday->>'lessonId' is distinct from sunday_lesson::text
    or exists(select 1 from daily_cs_private.mail_render_requests where kind='daily' and scheduled_date='2038-01-03') then
    raise exception 'Sunday must remain normal034 web learning with no regular mail';
  end if;

  -- Export/restore carries pending metadata; old backups missing it clear it safely.
  exported := daily_cs_private.export_schedule_state();
  if exported #>> '{state,pending_restart_date}' is distinct from '2038-01-04' then raise exception 'pending restart must export'; end if;
  update daily_cs_private.schedule_state set pending_restart_date=null;
  perform daily_cs_private.restore_schedule_state(exported);
  if (select pending_restart_date from daily_cs_private.schedule_state) is distinct from date '2038-01-04' then raise exception 'pending restart must restore'; end if;
  perform daily_cs_private.restore_schedule_state(jsonb_set(exported,'{state}',(exported->'state')-'pending_restart_date'));
  if (select pending_restart_date from daily_cs_private.schedule_state) is not null then raise exception 'legacy backup must restore without pending restart'; end if;
  perform daily_cs_private.restore_schedule_state(exported);
  begin
    perform daily_cs_private.restore_schedule_state(jsonb_set(exported,'{state,pending_restart_date}','"2038-01-03"'));
    raise exception 'past restart metadata must fail';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform daily_cs_private.restore_schedule_state(jsonb_set(exported,'{state,pending_restart_date}','"01/04/2038"'));
    raise exception 'noncanonical restart metadata must fail';
  exception when sqlstate '22023' then null;
  end;

  -- Monday 08:59 KST still displays the prior immutable Sunday snapshot.
  perform set_config('daily_cs_test.now','2038-01-03T23:59:00Z',true);
  reader := public.daily_cs_owner_api('reader.today','{}');
  if exists(select 1 from daily_cs_private.day_snapshots where snapshot_date='2038-01-04')
    or (select pending_restart_date from daily_cs_private.schedule_state) is null
    or reader #>> '{data,day,lessonId}' is distinct from sunday_lesson::text then raise exception 'Monday must not restart before09KST'; end if;
  -- Monday 09:00 KST creates one new cycle and both web and mail use its first item.
  perform set_config('daily_cs_test.now','2038-01-04T00:00:00Z',true);
  perform daily_cs_private.ensure_mail_due();
  reader := public.daily_cs_owner_api('reader.today','{}');
  if not exists(select 1 from daily_cs_private.day_snapshots d join daily_cs_private.mail_render_requests r on r.snapshot_id=d.id
    where d.snapshot_date='2038-01-04' and d.lesson_id=first_lesson and d.cycle=10001 and r.kind='daily')
    or reader #>> '{data,day,lessonId}' is distinct from first_lesson::text then
    raise exception 'Monday09KST web and mail must share day001 from the new cycle';
  end if;
  if (select pending_restart_date from daily_cs_private.schedule_state) is not null
    or exists(select 1 from daily_cs_private.schedule_queue where consumed_date is null and cycle<>10001) then
    raise exception 'restart must consume the event and retire only old unconsumed queue items';
  end if;
  perform daily_cs_private.ensure_mail_due();
  if (select cycle from daily_cs_private.schedule_state)<>10001
    or (select count(*) from daily_cs_private.mail_render_requests where kind='daily' and scheduled_date='2038-01-04')<>1 then
    raise exception 'repeated polling must not restart again or duplicate regular mail';
  end if;
  perform daily_cs_private.restore_schedule_state(daily_cs_private.export_schedule_state());
  perform set_config('daily_cs_test.now','2038-01-05T00:00:00Z',true);
  perform daily_cs_private.ensure_mail_due();
  if not exists(select 1 from daily_cs_private.day_snapshots d join daily_cs_private.mail_render_requests r on r.snapshot_id=d.id
    where d.snapshot_date='2038-01-05' and d.lesson_id=second_lesson and d.cycle=10001 and r.kind='daily') then
    raise exception 'Tuesday web and mail must continue day002';
  end if;
  if original_sunday is distinct from (select daily_cs_private.snapshot_day(d) from daily_cs_private.day_snapshots d where snapshot_date='2038-01-03')
    or old_snapshots is distinct from (select md5(coalesce(string_agg(to_jsonb(d)::text,'' order by snapshot_date),'')) from daily_cs_private.day_snapshots d where snapshot_date<'2038-01-03')
    or old_mail is distinct from (select md5(coalesce(string_agg(to_jsonb(m)::text,'' order by id),'')) from daily_cs_private.mail_outbox m) then
    raise exception 'restart must preserve Sunday, all past snapshots, and all delivery/claim history';
  end if;
end $test$;
rollback;
