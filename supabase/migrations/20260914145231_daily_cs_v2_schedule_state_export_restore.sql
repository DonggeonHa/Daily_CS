create or replace function daily_cs_private.export_schedule_state_if_available()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  state jsonb;
begin
  if pg_catalog.to_regprocedure('daily_cs_private.export_schedule_state()') is null then
    return null;
  end if;
  execute 'select daily_cs_private.export_schedule_state()' into state;
  return state;
end;
$$;

create or replace function daily_cs_private.restore_schedule_state_if_available(state jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if state is null or state = 'null'::jsonb then
    return;
  end if;
  if pg_catalog.to_regprocedure('daily_cs_private.restore_schedule_state(jsonb)') is null then
    raise exception using errcode = '22023', message = 'validation_failed: schedule restore helper is not installed';
  end if;
  execute 'select daily_cs_private.restore_schedule_state($1)' using state;
end;
$$;


create or replace function daily_cs_private.export_envelope(include_trash boolean default false)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'schemaVersion', 2,
    'settings', (
      select jsonb_build_object(
        'timezone', timezone,
        'startDate', start_date,
        'sendTime', to_char(send_time, 'HH24:MI'),
        'mailPaused', mail_paused,
        'revision', revision,
        'scheduleRevision', schedule_revision
      )
      from daily_cs_private.settings
      where singleton
    ),
    'lessons', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id,
        'legacyId', legacy_id,
        'title', title,
        'category', category,
        'state', state,
        'documentKind', document_kind,
        'draftDocument', draft_document,
        'publishedRevision', published_revision,
        'draftRevision', draft_revision,
        'rowRevision', row_revision,
        'createdAt', created_at,
        'updatedAt', updated_at,
        'trashedAt', trashed_at
      ) order by legacy_id nulls last, created_at, id)
      from daily_cs_private.lessons
      where include_trash or state <> 'trash'
    ), '[]'::jsonb),
    'revisions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id,
        'lessonId', r.lesson_id,
        'revisionNumber', r.revision_number,
        'title', r.title,
        'category', r.category,
        'documentKind', r.document_kind,
        'document', r.document,
        'contentHash', r.content_hash,
        'createdAt', r.created_at
      ) order by r.created_at, r.id)
      from daily_cs_private.lesson_revisions r
      join daily_cs_private.lessons l on l.id = r.lesson_id
      where include_trash or l.state <> 'trash'
    ), '[]'::jsonb),
    'scheduleOverrides', coalesce((
      select jsonb_agg(jsonb_build_object(
        'date', schedule_date,
        'mode', mode,
        'lessonId', lesson_id,
        'reason', reason,
        'revision', revision
      ) order by schedule_date)
      from daily_cs_private.schedule_overrides
    ), '[]'::jsonb),
    'daySnapshots', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id,
        'date', snapshot_date,
        'lessonId', lesson_id,
        'revisionId', revision_id,
        'legacyId', legacy_id,
        'title', title,
        'category', category,
        'documentKind', document_kind,
        'document', document,
        'contentHash', content_hash,
        'frozenAt', frozen_at,
        'emptyReason', empty_reason,
        'sendEligibleAt', send_eligible_at,
        'cycle', cycle,
        'isReview', is_review,
        'overrideReason', override_reason
      ) order by snapshot_date)
      from daily_cs_private.day_snapshots
    ), '[]'::jsonb)
  )
$$;

create or replace function daily_cs_private.restore_export_envelope(envelope jsonb, uid uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  settings_json jsonb := envelope -> 'settings';
begin
  perform daily_cs_private.validate_export_envelope(envelope);

  update daily_cs_private.settings
  set timezone = coalesce(settings_json ->> 'timezone', 'Asia/Seoul'),
      start_date = coalesce((settings_json ->> 'startDate')::date, date '2026-09-15'),
      send_time = coalesce((settings_json ->> 'sendTime')::time, time '09:00'),
      mail_paused = coalesce((settings_json ->> 'mailPaused')::boolean, false),
      revision = coalesce((settings_json ->> 'revision')::integer, 1),
      schedule_revision = coalesce((settings_json ->> 'scheduleRevision')::integer, 1)
  where singleton;

  insert into daily_cs_private.lessons (
    id, owner_uid, legacy_id, title, category, state, document_kind,
    draft_document, published_revision, draft_revision, row_revision,
    created_at, updated_at, trashed_at
  )
  select
    (item ->> 'id')::uuid,
    uid,
    nullif(item ->> 'legacyId', '')::integer,
    item ->> 'title',
    item ->> 'category',
    (item ->> 'state')::daily_cs_private.lesson_state,
    (item ->> 'documentKind')::daily_cs_private.document_kind,
    item -> 'draftDocument',
    nullif(item ->> 'publishedRevision', '')::integer,
    coalesce((item ->> 'draftRevision')::integer, 1),
    coalesce((item ->> 'rowRevision')::integer, 1),
    coalesce((item ->> 'createdAt')::timestamptz, now()),
    coalesce((item ->> 'updatedAt')::timestamptz, now()),
    nullif(item ->> 'trashedAt', '')::timestamptz
  from jsonb_array_elements(envelope -> 'lessons') as item
  on conflict (id) do update
  set owner_uid = excluded.owner_uid,
      legacy_id = excluded.legacy_id,
      title = excluded.title,
      category = excluded.category,
      state = excluded.state,
      document_kind = excluded.document_kind,
      draft_document = excluded.draft_document,
      published_revision = excluded.published_revision,
      draft_revision = excluded.draft_revision,
      row_revision = excluded.row_revision + 1,
      updated_at = now(),
      trashed_at = excluded.trashed_at;

  insert into daily_cs_private.lesson_revisions (
    id, lesson_id, revision_number, title, category, document_kind,
    document, content_hash, created_by, created_at
  )
  select
    (item ->> 'id')::uuid,
    (item ->> 'lessonId')::uuid,
    (item ->> 'revisionNumber')::integer,
    item ->> 'title',
    item ->> 'category',
    (item ->> 'documentKind')::daily_cs_private.document_kind,
    item -> 'document',
    item ->> 'contentHash',
    uid,
    coalesce((item ->> 'createdAt')::timestamptz, now())
  from jsonb_array_elements(envelope -> 'revisions') as item
  on conflict (lesson_id, revision_number) do update
  set title = excluded.title,
      category = excluded.category,
      document_kind = excluded.document_kind,
      document = excluded.document,
      content_hash = excluded.content_hash,
      created_by = excluded.created_by;

  delete from daily_cs_private.schedule_overrides;

  insert into daily_cs_private.schedule_overrides (
    schedule_date, mode, lesson_id, reason, revision
  )
  select
    (item ->> 'date')::date,
    (item ->> 'mode')::daily_cs_private.override_mode,
    nullif(item ->> 'lessonId', '')::uuid,
    nullif(item ->> 'reason', ''),
    coalesce((item ->> 'revision')::integer, 1)
  from jsonb_array_elements(envelope -> 'scheduleOverrides') as item
  on conflict (schedule_date) do update
  set mode = excluded.mode,
      lesson_id = excluded.lesson_id,
      reason = excluded.reason,
      revision = excluded.revision,
      updated_at = now();

  insert into daily_cs_private.day_snapshots (
    id, snapshot_date, lesson_id, revision_id, legacy_id, title, category,
    document_kind, document, content_hash, frozen_at, empty_reason,
    send_eligible_at, cycle, is_review, override_reason
  )
  select
    (item ->> 'id')::uuid,
    (item ->> 'date')::date,
    nullif(item ->> 'lessonId', '')::uuid,
    nullif(item ->> 'revisionId', '')::uuid,
    nullif(item ->> 'legacyId', '')::integer,
    nullif(item ->> 'title', ''),
    nullif(item ->> 'category', ''),
    nullif(item ->> 'documentKind', '')::daily_cs_private.document_kind,
    item -> 'document',
    nullif(item ->> 'contentHash', ''),
    coalesce((item ->> 'frozenAt')::timestamptz, now()),
    nullif(item ->> 'emptyReason', ''),
    coalesce((item ->> 'sendEligibleAt')::timestamptz, daily_cs_private.schedule_at((item ->> 'date')::date)),
    coalesce((item ->> 'cycle')::integer, 1),
    coalesce((item ->> 'isReview')::boolean, false),
    nullif(item ->> 'overrideReason', '')
  from jsonb_array_elements(envelope -> 'daySnapshots') as item
  on conflict (snapshot_date) do nothing;

  return jsonb_build_object(
    'lessons', jsonb_array_length(envelope -> 'lessons'),
    'revisions', jsonb_array_length(envelope -> 'revisions'),
    'snapshots', jsonb_array_length(envelope -> 'daySnapshots')
  );
end;
$$;
create or replace function daily_cs_private.export_with_hash(include_trash boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  envelope jsonb;
  schedule_state jsonb;
begin
  envelope := daily_cs_private.export_envelope(include_trash);
  schedule_state := daily_cs_private.export_schedule_state_if_available();
  if schedule_state is not null then
    envelope := envelope || jsonb_build_object('scheduleState', schedule_state);
  end if;
  return envelope || jsonb_build_object('hash', daily_cs_private.document_hash(envelope));
end;
$$;

create or replace function daily_cs_private.owner_data_api(action text, payload jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  uid uuid := daily_cs_private.require_active_owner();
  envelope jsonb;
  envelope_hash text;
  expected_hash text;
  restore_counts jsonb;
  simple_body jsonb;
  item jsonb;
begin
  perform daily_cs_private.take_owner_lock();

  if action = 'export.create' then
    envelope := daily_cs_private.export_with_hash(coalesce((payload ->> 'includeTrash')::boolean, false));
    return daily_cs_private.api_ok(jsonb_build_object('export', envelope));
  end if;

  if action = 'import.preview' then
    if jsonb_typeof(payload -> 'lessons') = 'array' then
      simple_body := jsonb_build_object('schemaVersion', 2, 'lessons', payload -> 'lessons');
      for item in select value from jsonb_array_elements(payload -> 'lessons') loop
        perform daily_cs_private.validate_publish_document('structured', item);
      end loop;
      return daily_cs_private.api_ok(jsonb_build_object(
        'hash', daily_cs_private.document_hash(simple_body),
        'lessons', jsonb_array_length(payload -> 'lessons'),
        'mode', 'simpleLessons'
      ));
    end if;

    envelope := payload -> 'export';
    if envelope is null then
      return daily_cs_private.api_error('validation_failed', 'export envelope is required');
    end if;
    envelope_hash := daily_cs_private.document_hash(envelope - 'hash');
    if envelope ->> 'hash' <> envelope_hash then
      return daily_cs_private.api_error('validation_failed', 'export hash mismatch');
    end if;
    perform daily_cs_private.validate_export_envelope(envelope - 'hash');
    return daily_cs_private.api_ok(jsonb_build_object(
      'hash', envelope_hash,
      'lessons', jsonb_array_length((envelope - 'hash') -> 'lessons'),
      'revisions', jsonb_array_length((envelope - 'hash') -> 'revisions'),
      'snapshots', jsonb_array_length((envelope - 'hash') -> 'daySnapshots'),
      'hasScheduleState', (envelope - 'hash') ? 'scheduleState'
    ));
  end if;

  if action in ('import.commit', 'backup.restore') then
    if jsonb_typeof(payload -> 'lessons') = 'array' then
      simple_body := jsonb_build_object('schemaVersion', 2, 'lessons', payload -> 'lessons');
      expected_hash := payload ->> 'expectedExportHash';
      if expected_hash is null or expected_hash <> daily_cs_private.document_hash(simple_body) then
        return daily_cs_private.api_error('validation_failed', 'lesson import hash mismatch');
      end if;
      restore_counts := daily_cs_private.commit_simple_lessons(payload -> 'lessons', uid);
      insert into daily_cs_private.import_batches (export_hash, item_count, committed_by)
      values (expected_hash, coalesce((restore_counts ->> 'lessons')::integer, 0), uid);
      return daily_cs_private.api_ok(jsonb_build_object('hash', expected_hash, 'imported', restore_counts));
    end if;

    envelope := payload -> 'export';
    expected_hash := payload ->> 'expectedExportHash';
    if envelope is null or expected_hash is null then
      return daily_cs_private.api_error('validation_failed', 'export and expectedExportHash are required');
    end if;
    envelope_hash := daily_cs_private.document_hash(envelope - 'hash');
    if envelope ->> 'hash' <> envelope_hash or expected_hash <> envelope_hash then
      return daily_cs_private.api_error('validation_failed', 'export hash mismatch');
    end if;
    if exists (select 1 from daily_cs_private.mail_outbox where state in ('claimed', 'sending')) then
      return daily_cs_private.api_error('conflict', 'restore is blocked while mail jobs are active');
    end if;
    if exists (
      select 1
      from jsonb_array_elements((envelope - 'hash') -> 'daySnapshots') incoming(item)
      join daily_cs_private.day_snapshots existing
        on existing.snapshot_date = (incoming.item ->> 'date')::date
      where existing.content_hash is distinct from nullif(incoming.item ->> 'contentHash', '')
    ) then
      return daily_cs_private.api_error('conflict', 'restore conflicts with existing immutable day snapshots');
    end if;
    restore_counts := daily_cs_private.restore_export_envelope(envelope - 'hash', uid);
    perform daily_cs_private.restore_schedule_state_if_available((envelope - 'hash') -> 'scheduleState');
    insert into daily_cs_private.import_batches (export_hash, item_count, committed_by)
    values (envelope_hash, coalesce((restore_counts ->> 'lessons')::integer, 0), uid);
    return daily_cs_private.api_ok(jsonb_build_object('hash', envelope_hash, 'restored', restore_counts));
  end if;

  return daily_cs_private.api_error('bad_request', 'unknown data action');
exception
  when invalid_text_representation or invalid_datetime_format or not_null_violation or check_violation or invalid_parameter_value then
    return daily_cs_private.api_error('validation_failed', 'data payload failed validation');
end;
$$;

revoke all on function daily_cs_private.export_schedule_state_if_available() from public, anon, authenticated;
revoke all on function daily_cs_private.restore_schedule_state_if_available(jsonb) from public, anon, authenticated;
revoke all on function daily_cs_private.export_with_hash(boolean) from public, anon, authenticated;
revoke all on function daily_cs_private.owner_data_api(text, jsonb) from public, anon;
grant execute on function daily_cs_private.owner_data_api(text, jsonb) to authenticated;
