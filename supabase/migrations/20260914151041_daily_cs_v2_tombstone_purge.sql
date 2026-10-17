alter table daily_cs_private.lessons
  add column if not exists purged_at timestamptz;

alter table daily_cs_private.lessons
  drop constraint if exists owner_matches_bootstrap;

alter table daily_cs_private.lessons
  alter column owner_uid drop not null;


create or replace function daily_cs_private.tombstone_purged_lesson(target_lesson_id uuid)
returns daily_cs_private.lessons
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  result daily_cs_private.lessons;
begin
  if current_setting('request.daily_cs_owner_rpc', true) <> 'true' or not daily_cs_private.is_active_owner() then
    raise exception using errcode = '42501', message = 'active owner session required';
  end if;

  delete from daily_cs_private.lesson_revisions r
  where r.lesson_id = target_lesson_id
    and not exists (
      select 1 from daily_cs_private.day_snapshots d where d.revision_id = r.id
    );

  update daily_cs_private.lessons
  set owner_uid = null,
      legacy_id = null,
      title = 'Purged lesson',
      category = 'purged',
      state = 'trash',
      document_kind = 'markdown',
      draft_document = '{}'::jsonb,
      published_revision = null,
      draft_revision = draft_revision + 1,
      row_revision = row_revision + 1,
      updated_at = now(),
      trashed_at = coalesce(trashed_at, now()),
      purged_at = now()
  where id = target_lesson_id
  returning * into result;

  if result.id is null then
    raise exception using errcode = '02000', message = 'lesson not found';
  end if;

  return result;
end;
$$;

revoke all on function daily_cs_private.tombstone_purged_lesson(uuid) from public, anon;
grant execute on function daily_cs_private.tombstone_purged_lesson(uuid) to authenticated;

create or replace function public.daily_cs_mail_api(action text, payload jsonb, token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  credential_id uuid;
  message_row daily_cs_private.mail_outbox;
  claim_secret text;
  claim_hash text;
  dispatcher_result jsonb;
  legacy_status text;
begin
  perform daily_cs_private.take_owner_lock();

  select id into credential_id
  from daily_cs_private.api_credentials
  where scope = 'mail'
    and enabled
    and token_hash = daily_cs_private.sha256_text(token);

  if credential_id is null then
    return daily_cs_private.api_error('forbidden', 'valid mail credential required');
  end if;

  update daily_cs_private.api_credentials set last_used_at = now() where id = credential_id;

  if action = 'mail.preflight' then
    return daily_cs_private.api_ok(jsonb_build_object('status', 'mail-preflight-ok'));
  end if;

  if action = 'mail.reconcileLegacyGuard' then
    legacy_status := coalesce(payload ->> 'legacyStatus', payload ->> 'legacyState');
    if legacy_status not in ('sent', 'sending', 'uncertain') then
      return daily_cs_private.api_error('validation_failed', 'legacyStatus must be sent, sending, or uncertain');
    end if;

    if nullif(payload ->> 'messageId', '') is not null then
      select * into message_row
      from daily_cs_private.mail_outbox
      where id = (payload ->> 'messageId')::uuid
      for update;
    elsif nullif(payload ->> 'commandId', '') is not null then
      select * into message_row
      from daily_cs_private.mail_outbox
      where command_id = (payload ->> 'commandId')::uuid
         or sending_command_id = (payload ->> 'commandId')::uuid
      order by updated_at desc
      limit 1
      for update;
    elsif payload ->> 'kind' = 'daily' and nullif(payload ->> 'date', '') is not null then
      select * into message_row
      from daily_cs_private.mail_outbox
      where kind = 'daily'
        and scheduled_date = (payload ->> 'date')::date
      order by updated_at desc
      limit 1
      for update;
    else
      return daily_cs_private.api_error('validation_failed', 'messageId, commandId, or daily date is required');
    end if;

    if not found then
      return daily_cs_private.api_ok(jsonb_build_object('state', 'missing'));
    end if;
    if message_row.claim_token_hash is not null
      and nullif(payload ->> 'claimToken', '') is not null
      and message_row.claim_token_hash is distinct from daily_cs_private.sha256_text(payload ->> 'claimToken')
    then
      return daily_cs_private.api_error('forbidden', 'valid claim required');
    end if;
    if message_row.state = 'sent' then
      return daily_cs_private.api_ok(jsonb_build_object('state', 'sent', 'messageId', message_row.id));
    end if;
    if legacy_status = 'sent' then
      update daily_cs_private.mail_outbox
      set state = 'sent',
          sent_at = coalesce(sent_at, daily_cs_private.mail_now()),
          provider_message_id = coalesce(nullif(payload ->> 'providerMessageId', ''), provider_message_id),
          last_error = null,
          updated_at = daily_cs_private.mail_now()
      where id = message_row.id
      returning * into message_row;
      return daily_cs_private.api_ok(jsonb_build_object('state', 'sent', 'messageId', message_row.id));
    end if;

    update daily_cs_private.mail_outbox
    set state = 'uncertain',
        last_error = left(coalesce(payload ->> 'reason', 'legacy sending guard requires mailbox confirmation'), 200),
        updated_at = daily_cs_private.mail_now()
    where id = message_row.id;
    return daily_cs_private.api_ok(jsonb_build_object('state', 'uncertain', 'messageId', message_row.id));
  end if;

  if action = 'mail.resumeClaim' then
    select * into message_row
    from daily_cs_private.mail_outbox
    where id = (payload ->> 'messageId')::uuid
    for update;

    if not found then
      return daily_cs_private.api_error('not_found', 'message not found');
    end if;

    if message_row.state = 'sent' then
      return daily_cs_private.api_ok(jsonb_build_object('state', 'sent'));
    end if;
    if message_row.state = 'uncertain' then
      return daily_cs_private.api_error('conflict', 'message is uncertain and requires reconciliation');
    end if;
    if message_row.claim_token_hash is distinct from daily_cs_private.sha256_text(payload ->> 'claimToken') then
      return daily_cs_private.api_error('forbidden', 'valid claim required');
    end if;
    if message_row.state = 'claimed' and message_row.claim_expires_at <= daily_cs_private.mail_now() then
      update daily_cs_private.mail_outbox
      set state = 'queued',
          claim_token_hash = null,
          claimed_by = null,
          claim_expires_at = null,
          updated_at = daily_cs_private.mail_now()
      where id = message_row.id;
      return daily_cs_private.api_ok(jsonb_build_object('message', null, 'status', 'expired'));
    end if;
    if message_row.state = 'sending'
      and nullif(payload ->> 'commandId', '')::uuid is not null
      and message_row.sending_command_id is distinct from nullif(payload ->> 'commandId', '')::uuid
    then
      return daily_cs_private.api_error('conflict', 'message is already sending with a different command');
    end if;
    if message_row.state not in ('claimed', 'sending') then
      return daily_cs_private.api_error('conflict', 'message is not resumable');
    end if;
    if message_row.kind = 'daily'
      and (
        message_row.scheduled_date <> (daily_cs_private.mail_now() at time zone 'Asia/Seoul')::date
        or daily_cs_private.mail_now() > message_row.send_after + interval '1 hour'
        or (select mail_paused from daily_cs_private.settings where singleton)
      )
    then
      return daily_cs_private.api_error('conflict', 'daily mail is outside its active send window');
    end if;

    return daily_cs_private.api_ok(jsonb_build_object(
      'message', jsonb_build_object(
        'id', message_row.id,
        'kind', message_row.kind,
        'commandId', coalesce(message_row.sending_command_id, nullif(payload ->> 'commandId', '')::uuid, message_row.command_id),
        'date', message_row.scheduled_date,
        'subject', message_row.subject,
        'text', message_row.text_body,
        'html', message_row.html_body,
        'snapshotId', coalesce(message_row.snapshot_id, message_row.manual_snapshot_id),
        'state', message_row.state,
        'claimToken', payload ->> 'claimToken'
      )
    ));
  end if;

  if action in ('mail.prepareDue', 'mail.materialize') then
    if pg_catalog.to_regprocedure('daily_cs_private.mail_schedule_api(text,jsonb)') is null then
      return daily_cs_private.api_error('internal_error', 'mail schedule module is not installed');
    end if;
    execute 'select daily_cs_private.mail_schedule_api($1, $2)' into dispatcher_result using action, payload;
    return dispatcher_result;
  end if;

  if action = 'mail.claimDue' then
    update daily_cs_private.mail_outbox
    set state = 'queued',
        claim_token_hash = null,
        claimed_by = null,
        claim_expires_at = null,
        updated_at = now()
    where state = 'claimed' and claim_expires_at <= daily_cs_private.mail_now();

    select * into message_row
    from daily_cs_private.mail_outbox
    where state = 'queued'
      and send_after <= daily_cs_private.mail_now()
      and (
        kind <> 'daily'
        or (
          scheduled_date = (daily_cs_private.mail_now() at time zone 'Asia/Seoul')::date
          and daily_cs_private.mail_now() <= send_after + interval '1 hour'
          and not (select mail_paused from daily_cs_private.settings where singleton)
        )
      )
    order by send_after
    for update skip locked
    limit 1;

    if not found then
      return daily_cs_private.api_ok(jsonb_build_object('message', null));
    end if;

    claim_secret := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
    claim_hash := daily_cs_private.sha256_text(claim_secret);

    update daily_cs_private.mail_outbox
    set state = 'claimed',
        claim_token_hash = claim_hash,
        claimed_by = left(coalesce(payload ->> 'workerId', 'worker'), 80),
        claim_expires_at = daily_cs_private.mail_now() + interval '10 minutes',
        updated_at = daily_cs_private.mail_now()
    where id = message_row.id
    returning * into message_row;

    return daily_cs_private.api_ok(jsonb_build_object(
      'message', jsonb_build_object(
        'id', message_row.id,
        'kind', message_row.kind,
        'commandId', message_row.command_id,
        'date', message_row.scheduled_date,
        'subject', message_row.subject,
        'text', message_row.text_body,
        'html', message_row.html_body,
        'snapshotId', coalesce(message_row.snapshot_id, message_row.manual_snapshot_id),
        'claimToken', claim_secret
      )
    ));
  end if;

  select * into message_row
  from daily_cs_private.mail_outbox
  where id = (payload ->> 'messageId')::uuid
  for update;

  if not found then
    return daily_cs_private.api_error('forbidden', 'valid claim required');
  end if;
  if message_row.claim_token_hash is distinct from daily_cs_private.sha256_text(payload ->> 'claimToken') then
    return daily_cs_private.api_error('forbidden', 'valid claim required');
  end if;

  if action = 'mail.ackSent' then
    if message_row.state = 'sent' then
      return daily_cs_private.api_ok(jsonb_build_object('state', 'sent'));
    end if;
    if message_row.state not in ('sending', 'uncertain') then
      return daily_cs_private.api_error('conflict', 'message is not sending');
    end if;
    update daily_cs_private.mail_outbox
    set state = 'sent',
        sent_at = daily_cs_private.mail_now(),
        provider_message_id = nullif(payload ->> 'providerMessageId', ''),
        last_error = null,
        updated_at = daily_cs_private.mail_now()
    where id = message_row.id;
    return daily_cs_private.api_ok(jsonb_build_object('state', 'sent'));
  end if;

  if message_row.state = 'uncertain' then
    return daily_cs_private.api_error('conflict', 'message is uncertain and requires reconciliation');
  end if;

  if action = 'mail.beginSending' then
    if message_row.kind = 'daily'
      and (
        message_row.scheduled_date <> (daily_cs_private.mail_now() at time zone 'Asia/Seoul')::date
        or daily_cs_private.mail_now() > message_row.send_after + interval '1 hour'
        or (select mail_paused from daily_cs_private.settings where singleton)
      )
    then
      return daily_cs_private.api_error('conflict', 'daily mail is outside its active send window');
    end if;
    if message_row.state = 'sending'
      and message_row.sending_command_id is not distinct from nullif(payload ->> 'commandId', '')::uuid
    then
      return daily_cs_private.api_ok(jsonb_build_object('state', 'sending'));
    end if;
    if message_row.state = 'sending' then
      return daily_cs_private.api_error('conflict', 'message is already sending with a different command');
    end if;
    if message_row.state <> 'claimed' or message_row.claim_expires_at <= daily_cs_private.mail_now() then
      return daily_cs_private.api_error('conflict', 'message is not claimable');
    end if;
    update daily_cs_private.mail_outbox
    set state = 'sending',
        sending_started_at = daily_cs_private.mail_now(),
        sending_command_id = nullif(payload ->> 'commandId', '')::uuid,
        updated_at = daily_cs_private.mail_now()
    where id = message_row.id;
    return daily_cs_private.api_ok(jsonb_build_object('state', 'sending'));
  end if;

  if action = 'mail.markUncertain' then
    if message_row.state <> 'sending' then
      return daily_cs_private.api_error('conflict', 'message is not sending');
    end if;
    update daily_cs_private.mail_outbox
    set state = 'uncertain',
        last_error = left(coalesce(payload ->> 'reason', 'uncertain'), 200),
        updated_at = daily_cs_private.mail_now()
    where id = message_row.id;
    return daily_cs_private.api_ok(jsonb_build_object('state', 'uncertain'));
  end if;

  return daily_cs_private.api_error('bad_request', 'unknown mail action');
end;
$$;

revoke all on function public.daily_cs_mail_api(text, jsonb, text) from public, anon, authenticated;
grant execute on function public.daily_cs_mail_api(text, jsonb, text) to service_role;

create or replace function public.daily_cs_owner_api(action text, payload jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  uid uuid;
  settings_row daily_cs_private.settings;
  lesson_row daily_cs_private.lessons;
  revision_row daily_cs_private.lesson_revisions;
  message_row daily_cs_private.mail_outbox;
  dispatcher_result jsonb;
  requested_id uuid;
  expected_revision integer;
  new_revision integer;
  new_id uuid;
begin
  if not daily_cs_private.is_active_owner() then
    return daily_cs_private.api_error('forbidden', 'active owner session required');
  end if;
  perform set_config('request.daily_cs_owner_rpc', 'true', true);
  uid := auth.uid();
  perform daily_cs_private.take_owner_lock();

  if action is null or action = '' then
    return daily_cs_private.api_error('bad_request', 'action is required');
  end if;

  if action in ('settings.get', 'settings.update', 'dashboard.get')
     and pg_catalog.to_regprocedure('daily_cs_private.owner_schedule_api(text,jsonb)') is not null then
    execute 'select daily_cs_private.owner_schedule_api($1, $2)' into dispatcher_result using action, payload;
    return dispatcher_result;
  end if;

  if action in ('settings.get', 'dashboard.get') then
    select * into settings_row from daily_cs_private.settings where singleton;
    return daily_cs_private.api_ok(jsonb_build_object(
      'settings', jsonb_build_object(
        'timezone', settings_row.timezone,
        'startDate', settings_row.start_date,
        'sendTime', to_char(settings_row.send_time, 'HH24:MI'),
        'mailPaused', settings_row.mail_paused,
        'revision', settings_row.revision,
        'scheduleRevision', settings_row.schedule_revision
      )
    ));
  end if;

  if action = 'settings.update' then
    select * into settings_row from daily_cs_private.lock_settings();
    expected_revision := (payload ->> 'expectedRevision')::integer;
    if settings_row.revision <> expected_revision then
      return daily_cs_private.api_error('conflict', 'settings revision changed');
    end if;
    update daily_cs_private.settings
    set send_time = coalesce((payload ->> 'sendTime')::time, send_time),
        mail_paused = coalesce((payload ->> 'mailPaused')::boolean, mail_paused),
        revision = revision + 1,
        schedule_revision = schedule_revision + 1
    where singleton
    returning * into settings_row;
    return daily_cs_private.api_ok(jsonb_build_object('revision', settings_row.revision, 'scheduleRevision', settings_row.schedule_revision));
  end if;

  if action = 'lesson.list' then
    return daily_cs_private.api_ok(jsonb_build_object(
      'items',
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', id,
          'legacyId', legacy_id,
          'state', state,
          'title', title,
          'category', category,
          'publishedRevision', published_revision,
          'draftRevision', draft_revision,
          'revision', row_revision,
          'updatedAt', updated_at
        ) order by updated_at desc)
        from daily_cs_private.lessons
        where owner_uid = uid
          and ((payload ->> 'state') is null or payload ->> 'state' = 'all' or state::text = payload ->> 'state')
      ), '[]'::jsonb)
    ));
  end if;

  if action = 'lesson.create' then
    perform daily_cs_private.validate_document((payload ->> 'documentKind')::daily_cs_private.document_kind, payload -> 'document');
    insert into daily_cs_private.lessons (
      owner_uid, legacy_id, title, category, state, document_kind, draft_document
    )
    values (
      uid,
      nullif(payload ->> 'legacyId', '')::integer,
      trim(payload ->> 'title'),
      trim(payload ->> 'category'),
      'draft',
      (payload ->> 'documentKind')::daily_cs_private.document_kind,
      payload -> 'document'
    )
    returning * into lesson_row;
    return daily_cs_private.api_ok(jsonb_build_object('lesson', to_jsonb(lesson_row)));
  end if;

  if action in ('lesson.get', 'revision.list') then
    requested_id := (payload ->> 'id')::uuid;
    select * into lesson_row from daily_cs_private.lessons where id = requested_id and owner_uid = uid;
    if not found then
      return daily_cs_private.api_error('not_found', 'lesson not found');
    end if;
    return daily_cs_private.api_ok(jsonb_build_object(
      'lesson', to_jsonb(lesson_row),
      'revisions',
      coalesce((
        select jsonb_agg(to_jsonb(r) order by revision_number desc)
        from daily_cs_private.lesson_revisions r
        where r.lesson_id = lesson_row.id
      ), '[]'::jsonb)
    ));
  end if;

  if action = 'revision.get' then
    select r.* into revision_row
    from daily_cs_private.lesson_revisions r
    join daily_cs_private.lessons l on l.id = r.lesson_id
    where r.id = (payload ->> 'revisionId')::uuid and l.owner_uid = uid;
    if not found then
      return daily_cs_private.api_error('not_found', 'revision not found');
    end if;
    return daily_cs_private.api_ok(jsonb_build_object('revision', to_jsonb(revision_row)));
  end if;

  if action in ('lesson.saveDraft', 'lesson.publish', 'lesson.unpublish', 'lesson.moveToTrash', 'lesson.restoreTrash', 'lesson.purge') then
    perform daily_cs_private.freeze_elapsed_days();
    requested_id := (payload ->> 'id')::uuid;
    expected_revision := (payload ->> 'expectedRevision')::integer;
    select * into lesson_row from daily_cs_private.lessons where id = requested_id and owner_uid = uid for update;
    if not found then
      return daily_cs_private.api_error('not_found', 'lesson not found');
    end if;
    if lesson_row.row_revision <> expected_revision then
      return daily_cs_private.api_error('conflict', 'lesson revision changed');
    end if;

    if action = 'lesson.saveDraft' then
      perform daily_cs_private.validate_document((payload ->> 'documentKind')::daily_cs_private.document_kind, payload -> 'document');
      update daily_cs_private.lessons
      set title = trim(payload ->> 'title'),
          category = trim(payload ->> 'category'),
          document_kind = (payload ->> 'documentKind')::daily_cs_private.document_kind,
          draft_document = payload -> 'document',
          draft_revision = draft_revision + 1,
          row_revision = row_revision + 1,
          updated_at = now()
      where id = requested_id
      returning * into lesson_row;
      return daily_cs_private.api_ok(jsonb_build_object('lesson', to_jsonb(lesson_row)));
    end if;

    if action = 'lesson.publish' then
      perform daily_cs_private.validate_publish_document(lesson_row.document_kind, lesson_row.draft_document);
      new_revision := coalesce(lesson_row.published_revision, 0) + 1;
      insert into daily_cs_private.lesson_revisions (
        lesson_id, revision_number, title, category, document_kind, document, content_hash, created_by
      )
      values (
        lesson_row.id,
        new_revision,
        lesson_row.title,
        lesson_row.category,
        lesson_row.document_kind,
        lesson_row.draft_document,
        daily_cs_private.document_hash(lesson_row.draft_document),
        uid
      )
      returning * into revision_row;
      update daily_cs_private.lessons
      set state = 'published',
          published_revision = new_revision,
          row_revision = row_revision + 1,
          updated_at = now(),
          trashed_at = null
      where id = lesson_row.id
      returning * into lesson_row;
      if pg_catalog.to_regprocedure('daily_cs_private.on_catalog_change(uuid)') is not null then
        execute 'select daily_cs_private.on_catalog_change($1)' using lesson_row.id;
      end if;
      return daily_cs_private.api_ok(jsonb_build_object('lesson', to_jsonb(lesson_row), 'revision', to_jsonb(revision_row)));
    end if;

    if action = 'lesson.unpublish' then
      update daily_cs_private.lessons
      set state = 'draft', row_revision = row_revision + 1, updated_at = now()
      where id = lesson_row.id
      returning * into lesson_row;
      if pg_catalog.to_regprocedure('daily_cs_private.on_catalog_change(uuid)') is not null then
        execute 'select daily_cs_private.on_catalog_change($1)' using lesson_row.id;
      end if;
      return daily_cs_private.api_ok(jsonb_build_object('lesson', to_jsonb(lesson_row)));
    end if;

    if action = 'lesson.moveToTrash' then
      update daily_cs_private.lessons
      set state = 'trash', row_revision = row_revision + 1, updated_at = now(), trashed_at = now()
      where id = lesson_row.id
      returning * into lesson_row;
      if pg_catalog.to_regprocedure('daily_cs_private.on_catalog_change(uuid)') is not null then
        execute 'select daily_cs_private.on_catalog_change($1)' using lesson_row.id;
      end if;
      return daily_cs_private.api_ok(jsonb_build_object('lesson', to_jsonb(lesson_row)));
    end if;

    if action = 'lesson.restoreTrash' then
      update daily_cs_private.lessons
      set state = 'draft', row_revision = row_revision + 1, updated_at = now(), trashed_at = null
      where id = lesson_row.id
      returning * into lesson_row;
      if pg_catalog.to_regprocedure('daily_cs_private.on_catalog_change(uuid)') is not null then
        execute 'select daily_cs_private.on_catalog_change($1)' using lesson_row.id;
      end if;
      return daily_cs_private.api_ok(jsonb_build_object('lesson', to_jsonb(lesson_row)));
    end if;

    if exists (select 1 from daily_cs_private.day_snapshots where lesson_id = lesson_row.id) then
      lesson_row := daily_cs_private.tombstone_purged_lesson(lesson_row.id);

      if pg_catalog.to_regprocedure('daily_cs_private.on_catalog_change(uuid)') is not null then
        execute 'select daily_cs_private.on_catalog_change($1)' using lesson_row.id;
      end if;
      return daily_cs_private.api_ok(jsonb_build_object('purged', true, 'retainedHistory', true, 'id', lesson_row.id));
    end if;
    delete from daily_cs_private.lessons where id = lesson_row.id;
    if pg_catalog.to_regprocedure('daily_cs_private.on_catalog_change(uuid)') is not null then
      execute 'select daily_cs_private.on_catalog_change($1)' using lesson_row.id;
    end if;
    return daily_cs_private.api_ok(jsonb_build_object('purged', true, 'retainedHistory', false, 'id', lesson_row.id));
  end if;

  if action = 'lesson.restoreRevision' then
    requested_id := (payload ->> 'id')::uuid;
    expected_revision := (payload ->> 'expectedRevision')::integer;
    select * into lesson_row from daily_cs_private.lessons where id = requested_id and owner_uid = uid for update;
    if not found then
      return daily_cs_private.api_error('not_found', 'lesson not found');
    end if;
    if lesson_row.row_revision <> expected_revision then
      return daily_cs_private.api_error('conflict', 'lesson revision changed');
    end if;
    select * into revision_row from daily_cs_private.lesson_revisions where id = (payload ->> 'revisionId')::uuid and lesson_id = requested_id;
    if not found then
      return daily_cs_private.api_error('not_found', 'revision not found');
    end if;
    update daily_cs_private.lessons
    set title = revision_row.title,
        category = revision_row.category,
        document_kind = revision_row.document_kind,
        draft_document = revision_row.document,
        draft_revision = draft_revision + 1,
        row_revision = row_revision + 1,
        updated_at = now()
    where id = requested_id
    returning * into lesson_row;
    return daily_cs_private.api_ok(jsonb_build_object('lesson', to_jsonb(lesson_row)));
  end if;

  if action = 'lesson.duplicate' then
    requested_id := (payload ->> 'id')::uuid;
    select * into lesson_row from daily_cs_private.lessons where id = requested_id and owner_uid = uid;
    if not found then
      return daily_cs_private.api_error('not_found', 'lesson not found');
    end if;
    insert into daily_cs_private.lessons (owner_uid, title, category, state, document_kind, draft_document)
    values (uid, coalesce(nullif(payload ->> 'title', ''), lesson_row.title || ' copy'), lesson_row.category, 'draft', lesson_row.document_kind, lesson_row.draft_document)
    returning id into new_id;
    return public.daily_cs_owner_api('lesson.get', jsonb_build_object('id', new_id));
  end if;

  if action in (
    'schedule.get', 'schedule.setOverride', 'schedule.rebuildFuture',
    'reader.today', 'reader.lesson', 'reader.snapshot', 'reader.history', 'reader.search',
    'mail.status', 'mail.enqueueTest', 'mail.retryUncertain'
  ) then
    if pg_catalog.to_regprocedure('daily_cs_private.owner_schedule_api(text,jsonb)') is null then
      return daily_cs_private.api_error('internal_error', 'schedule module is not installed');
    end if;
    execute 'select daily_cs_private.owner_schedule_api($1, $2)' into dispatcher_result using action, payload;
    return dispatcher_result;
  end if;

  if action in ('import.preview', 'export.create', 'backup.restore', 'import.commit') then
    if pg_catalog.to_regprocedure('daily_cs_private.owner_data_api(text,jsonb)') is null then
      return daily_cs_private.api_error('internal_error', 'data module is not installed');
    end if;
    execute 'select daily_cs_private.owner_data_api($1, $2)' into dispatcher_result using action, payload;
    return dispatcher_result;
  end if;

  return daily_cs_private.api_error('bad_request', 'unknown action');
exception
  when invalid_text_representation or invalid_datetime_format or not_null_violation or check_violation then
    return daily_cs_private.api_error('validation_failed', 'payload failed validation');
  when insufficient_privilege then
    return daily_cs_private.api_error('forbidden', 'active owner session required');
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
        'trashedAt', trashed_at,
        'purgedAt', purged_at
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
    created_at, updated_at, trashed_at, purged_at
  )
  select
    (item ->> 'id')::uuid,
    case when nullif(item ->> 'purgedAt', '') is null then uid else null end,
    case when nullif(item ->> 'purgedAt', '') is null then nullif(item ->> 'legacyId', '')::integer else null end,
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
    nullif(item ->> 'trashedAt', '')::timestamptz,
    nullif(item ->> 'purgedAt', '')::timestamptz
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
      trashed_at = excluded.trashed_at,
      purged_at = excluded.purged_at;

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
