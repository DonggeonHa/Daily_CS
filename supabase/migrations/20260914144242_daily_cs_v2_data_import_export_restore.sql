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
        'emptyReason', empty_reason
      ) order by snapshot_date)
      from daily_cs_private.day_snapshots
    ), '[]'::jsonb)
  )
$$;

create or replace function daily_cs_private.export_with_hash(include_trash boolean default false)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select envelope || jsonb_build_object('hash', daily_cs_private.document_hash(envelope))
  from (select daily_cs_private.export_envelope(include_trash) as envelope) e
$$;

create or replace function daily_cs_private.validate_export_envelope(envelope jsonb)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  lesson jsonb;
  revision jsonb;
begin
  if coalesce((envelope ->> 'schemaVersion')::integer, 0) <> 2 then
    raise exception using errcode = '22023', message = 'validation_failed: unsupported export schema version';
  end if;

  if jsonb_typeof(envelope -> 'lessons') <> 'array'
    or jsonb_typeof(envelope -> 'revisions') <> 'array'
    or jsonb_typeof(envelope -> 'scheduleOverrides') <> 'array'
    or jsonb_typeof(envelope -> 'daySnapshots') <> 'array'
  then
    raise exception using errcode = '22023', message = 'validation_failed: export arrays are required';
  end if;

  for lesson in select value from jsonb_array_elements(envelope -> 'lessons') loop
    perform daily_cs_private.validate_document((lesson ->> 'documentKind')::daily_cs_private.document_kind, lesson -> 'draftDocument');
    if lesson ->> 'state' = 'published' then
      perform daily_cs_private.validate_publish_document((lesson ->> 'documentKind')::daily_cs_private.document_kind, lesson -> 'draftDocument');
    end if;
  end loop;

  for revision in select value from jsonb_array_elements(envelope -> 'revisions') loop
    perform daily_cs_private.validate_publish_document((revision ->> 'documentKind')::daily_cs_private.document_kind, revision -> 'document');
    if revision ->> 'contentHash' <> daily_cs_private.document_hash(revision -> 'document') then
      raise exception using errcode = '22023', message = 'validation_failed: revision content hash mismatch';
    end if;
  end loop;
end;
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
    document_kind, document, content_hash, frozen_at, empty_reason
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
    nullif(item ->> 'emptyReason', '')
  from jsonb_array_elements(envelope -> 'daySnapshots') as item
  on conflict (snapshot_date) do nothing;

  return jsonb_build_object(
    'lessons', jsonb_array_length(envelope -> 'lessons'),
    'revisions', jsonb_array_length(envelope -> 'revisions'),
    'snapshots', jsonb_array_length(envelope -> 'daySnapshots')
  );
end;
$$;

create or replace function daily_cs_private.commit_simple_lessons(lessons jsonb, uid uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  item jsonb;
  lesson_uuid uuid;
  imported_count integer := 0;
begin
  if jsonb_typeof(lessons) <> 'array' then
    raise exception using errcode = '22023', message = 'validation_failed: lessons array is required';
  end if;

  for item in select value from jsonb_array_elements(lessons) loop
    perform daily_cs_private.validate_publish_document('structured', item);
  end loop;

  for item in select value from jsonb_array_elements(lessons) loop
    lesson_uuid := extensions.gen_random_uuid();
    insert into daily_cs_private.lessons (
      id, owner_uid, legacy_id, title, category, state, document_kind,
      draft_document, published_revision, draft_revision, row_revision
    )
    values (
      lesson_uuid,
      uid,
      (item ->> 'order')::integer,
      item ->> 'title',
      item ->> 'category',
      'published',
      'structured',
      item,
      1,
      1,
      1
    )
    on conflict (legacy_id) do update
    set owner_uid = excluded.owner_uid,
        title = excluded.title,
        category = excluded.category,
        state = 'published',
        document_kind = 'structured',
        draft_document = excluded.draft_document,
        published_revision = 1,
        draft_revision = daily_cs_private.lessons.draft_revision + 1,
        row_revision = daily_cs_private.lessons.row_revision + 1,
        updated_at = now()
    returning id into lesson_uuid;

    insert into daily_cs_private.lesson_revisions (
      lesson_id, revision_number, title, category, document_kind, document, content_hash, created_by
    )
    values (
      lesson_uuid,
      1,
      item ->> 'title',
      item ->> 'category',
      'structured',
      item,
      daily_cs_private.document_hash(item),
      uid
    )
    on conflict (lesson_id, revision_number) do update
    set title = excluded.title,
        category = excluded.category,
        document = excluded.document,
        content_hash = excluded.content_hash,
        created_by = excluded.created_by;

    imported_count := imported_count + 1;
  end loop;

  return jsonb_build_object('lessons', imported_count);
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
      'snapshots', jsonb_array_length((envelope - 'hash') -> 'daySnapshots')
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

revoke all on function daily_cs_private.export_envelope(boolean) from public, anon, authenticated;
revoke all on function daily_cs_private.export_with_hash(boolean) from public, anon, authenticated;
revoke all on function daily_cs_private.restore_export_envelope(jsonb, uuid) from public, anon, authenticated;
revoke all on function daily_cs_private.owner_data_api(text, jsonb) from public, anon;
grant execute on function daily_cs_private.owner_data_api(text, jsonb) to authenticated;

create or replace function public.daily_cs_backup_api(action text, payload jsonb, token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  credential_id uuid;
  envelope jsonb;
begin
  select id into credential_id
  from daily_cs_private.api_credentials
  where scope = 'backup_export'
    and enabled
    and token_hash = daily_cs_private.sha256_text(token);

  if credential_id is null then
    return daily_cs_private.api_error('forbidden', 'valid backup credential required');
  end if;

  if action <> 'backup.export' then
    return daily_cs_private.api_error('bad_request', 'unknown backup action');
  end if;

  update daily_cs_private.api_credentials set last_used_at = now() where id = credential_id;
  envelope := daily_cs_private.export_with_hash(true);
  return daily_cs_private.api_ok(jsonb_build_object('export', envelope));
end;
$$;

revoke all on function public.daily_cs_backup_api(text, jsonb, text) from public, anon, authenticated;
grant execute on function public.daily_cs_backup_api(text, jsonb, text) to service_role;
