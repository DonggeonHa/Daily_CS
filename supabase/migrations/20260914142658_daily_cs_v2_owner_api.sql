create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;
grant usage on schema auth to authenticated;
grant execute on all functions in schema extensions to anon, authenticated, service_role;

create schema if not exists daily_cs_private;

create type daily_cs_private.lesson_state as enum ('draft', 'published', 'trash');
create type daily_cs_private.document_kind as enum ('structured', 'markdown');
create type daily_cs_private.override_mode as enum ('auto', 'lesson', 'empty');
create type daily_cs_private.mail_state as enum ('queued', 'claimed', 'sending', 'sent', 'uncertain');
create type daily_cs_private.mail_kind as enum ('daily', 'test', 'resend');
create type daily_cs_private.credential_scope as enum ('mail', 'backup_export');

create table daily_cs_private.owner_profile (
  singleton boolean primary key default true check (singleton),
  owner_uid uuid not null unique,
  owner_email_hash text not null,
  bootstrapped_at timestamptz not null default now(),
  revision integer not null default 1 check (revision > 0)
);

create table daily_cs_private.owner_allowlist (
  email_hash text primary key,
  provider text not null check (provider = 'google'),
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);

create table daily_cs_private.settings (
  singleton boolean primary key default true check (singleton),
  timezone text not null default 'Asia/Seoul' check (timezone = 'Asia/Seoul'),
  start_date date not null default date '2026-09-15',
  send_time time not null default time '09:00',
  mail_paused boolean not null default false,
  revision integer not null default 1 check (revision > 0),
  schedule_revision integer not null default 1 check (schedule_revision > 0)
);

insert into daily_cs_private.settings (singleton)
values (true)
on conflict (singleton) do nothing;

create table daily_cs_private.lessons (
  id uuid primary key default gen_random_uuid(),
  owner_uid uuid not null,
  legacy_id integer unique check (legacy_id is null or legacy_id > 0),
  title text not null check (length(trim(title)) between 1 and 160),
  category text not null check (length(trim(category)) between 1 and 80),
  state daily_cs_private.lesson_state not null default 'draft',
  document_kind daily_cs_private.document_kind not null default 'structured',
  draft_document jsonb not null default '{}'::jsonb,
  published_revision integer check (published_revision is null or published_revision > 0),
  draft_revision integer not null default 1 check (draft_revision > 0),
  row_revision integer not null default 1 check (row_revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  trashed_at timestamptz,
  constraint owner_matches_bootstrap check (owner_uid is not null)
);

create table daily_cs_private.lesson_revisions (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references daily_cs_private.lessons(id) on delete cascade,
  revision_number integer not null check (revision_number > 0),
  title text not null,
  category text not null,
  document_kind daily_cs_private.document_kind not null,
  document jsonb not null,
  content_hash text not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  unique (lesson_id, revision_number)
);

create table daily_cs_private.schedule_overrides (
  schedule_date date primary key,
  mode daily_cs_private.override_mode not null,
  lesson_id uuid references daily_cs_private.lessons(id) on delete set null,
  reason text,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (mode = 'lesson' and lesson_id is not null)
    or (mode in ('auto', 'empty') and lesson_id is null)
  )
);

create table daily_cs_private.day_snapshots (
  id uuid primary key default gen_random_uuid(),
  snapshot_date date not null unique,
  lesson_id uuid references daily_cs_private.lessons(id) on delete set null,
  revision_id uuid references daily_cs_private.lesson_revisions(id) on delete restrict,
  legacy_id integer,
  title text,
  category text,
  document_kind daily_cs_private.document_kind,
  document jsonb,
  content_hash text,
  frozen_at timestamptz not null default now(),
  empty_reason text
);

create table daily_cs_private.mail_outbox (
  id uuid primary key default gen_random_uuid(),
  kind daily_cs_private.mail_kind not null default 'daily',
  supersedes_message_id uuid references daily_cs_private.mail_outbox(id) on delete restrict,
  snapshot_id uuid references daily_cs_private.day_snapshots(id) on delete restrict,
  manual_snapshot_id uuid,
  scheduled_date date not null,
  send_after timestamptz not null,
  state daily_cs_private.mail_state not null default 'queued',
  subject text not null,
  text_body text not null,
  html_body text not null,
  claim_token_hash text,
  claimed_by text,
  claim_expires_at timestamptz,
  sending_started_at timestamptz,
  sending_command_id uuid,
  sent_at timestamptz,
  provider_message_id text,
  command_id uuid unique,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table daily_cs_private.api_credentials (
  id uuid primary key default gen_random_uuid(),
  scope daily_cs_private.credential_scope not null,
  token_hash text not null unique,
  label text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create table daily_cs_private.import_batches (
  id uuid primary key default gen_random_uuid(),
  export_hash text not null,
  item_count integer not null check (item_count >= 0),
  committed_by uuid not null,
  committed_at timestamptz not null default now()
);

create index lessons_owner_state_idx on daily_cs_private.lessons (owner_uid, state, updated_at desc);
create index lessons_legacy_id_idx on daily_cs_private.lessons (legacy_id) where legacy_id is not null;
create index revisions_lesson_number_idx on daily_cs_private.lesson_revisions (lesson_id, revision_number desc);
create index snapshots_date_idx on daily_cs_private.day_snapshots (snapshot_date desc);
create index mail_due_idx on daily_cs_private.mail_outbox (state, send_after) where state in ('queued', 'claimed');
create index mail_snapshot_idx on daily_cs_private.mail_outbox (snapshot_id);
create unique index mail_daily_date_once_idx on daily_cs_private.mail_outbox (scheduled_date) where kind = 'daily';
create unique index mail_command_once_idx on daily_cs_private.mail_outbox (command_id) where command_id is not null;
create index credentials_scope_hash_idx on daily_cs_private.api_credentials (scope, token_hash) where enabled;

alter table daily_cs_private.owner_profile enable row level security;
alter table daily_cs_private.owner_allowlist enable row level security;
alter table daily_cs_private.settings enable row level security;
alter table daily_cs_private.lessons enable row level security;
alter table daily_cs_private.lesson_revisions enable row level security;
alter table daily_cs_private.schedule_overrides enable row level security;
alter table daily_cs_private.day_snapshots enable row level security;
alter table daily_cs_private.mail_outbox enable row level security;
alter table daily_cs_private.api_credentials enable row level security;
alter table daily_cs_private.import_batches enable row level security;

revoke all on schema daily_cs_private from public, anon, authenticated;
grant usage on schema daily_cs_private to authenticated;

create or replace function daily_cs_private.sha256_text(value text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select pg_catalog.encode(extensions.digest(value, 'sha256'), 'hex')
$$;

create or replace function daily_cs_private.normalize_email_hash(value text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select daily_cs_private.sha256_text(lower(trim(value)))
$$;

create or replace function daily_cs_private.document_hash(value jsonb)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select daily_cs_private.sha256_text(value::text)
$$;

create or replace function daily_cs_private.validate_document(kind daily_cs_private.document_kind, document jsonb)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  markdown_without_code text;
begin
  markdown_without_code := pg_catalog.regexp_replace(coalesce(document ->> 'markdown', ''), '```(.|\n|\r)*?```', '', 'g');

  if kind = 'markdown' and markdown_without_code ~ '<[A-Za-z!/]' then
    raise exception using errcode = '22023', message = 'validation_failed: raw HTML is not allowed in markdown';
  end if;

  if kind = 'structured' and jsonb_typeof(document) <> 'object' then
    raise exception using errcode = '22023', message = 'validation_failed: structured document must be an object';
  end if;
end;
$$;

create or replace function daily_cs_private.validate_publish_document(kind daily_cs_private.document_kind, document jsonb)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  perform daily_cs_private.validate_document(kind, document);

  if kind = 'markdown' then
    if length(trim(coalesce(document ->> 'markdown', ''))) < 20 then
      raise exception using errcode = '22023', message = 'validation_failed: markdown publish body is incomplete';
    end if;
    return;
  end if;

  if not (
    document ? 'id'
    and document ? 'order'
    and document ? 'track'
    and document ? 'category'
    and document ? 'level'
    and document ? 'week'
    and document ? 'title'
    and document ? 'summary'
    and document ? 'keywords'
    and document ? 'question'
    and document ? 'answer'
    and document ? 'explanation'
    and document ? 'example'
    and document ? 'pitfalls'
    and document ? 'followUps'
    and document ? 'quiz'
    and document ? 'sources'
    and document ? 'versionNote'
  ) then
    raise exception using errcode = '22023', message = 'validation_failed: structured lesson is incomplete';
  end if;

  if (document ->> 'id') !~ '^[0-9]{3}$'
    or jsonb_typeof(document -> 'order') <> 'number'
    or length(trim(document ->> 'question')) = 0
    or length(trim(document ->> 'answer')) = 0
    or jsonb_typeof(document -> 'explanation') <> 'array'
    or jsonb_typeof(document -> 'followUps') <> 'array'
    or jsonb_typeof(document -> 'sources') <> 'array'
  then
    raise exception using errcode = '22023', message = 'validation_failed: structured lesson fields are invalid';
  end if;
end;
$$;

create or replace function daily_cs_private.take_owner_lock()
returns void
language sql
volatile
set search_path = ''
as $$
  select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('daily_cs_v2_owner', 0))
$$;

create or replace function daily_cs_private.mail_now()
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  current_value timestamptz;
begin
  if pg_catalog.to_regprocedure('daily_cs_private.schedule_now()') is not null then
    execute 'select daily_cs_private.schedule_now()' into current_value;
    return current_value;
  end if;
  return now();
end;
$$;

create or replace function daily_cs_private.is_active_owner()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  session_claim text := auth.jwt() ->> 'session_id';
  session_uuid uuid;
  pinned_uid uuid;
begin
  if uid is null or session_claim is null or session_claim !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;

  session_uuid := session_claim::uuid;

  select owner_uid
  into pinned_uid
  from daily_cs_private.owner_profile
  where singleton;

  if pinned_uid is null or pinned_uid <> uid then
    return false;
  end if;

  return exists (
    select 1
    from auth.sessions s
    where s.id = session_uuid
      and s.user_id = uid
      and (s.not_after is null or s.not_after > now())
  );
end;
$$;

create or replace function daily_cs_private.require_active_owner()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if not daily_cs_private.is_active_owner() then
    raise exception using errcode = '42501', message = 'forbidden: active owner session required';
  end if;
  return uid;
end;
$$;

create policy owner_profile_select on daily_cs_private.owner_profile
  for select to authenticated using (daily_cs_private.is_active_owner());

create policy settings_owner_all on daily_cs_private.settings
  for all to authenticated
  using (daily_cs_private.is_active_owner())
  with check (daily_cs_private.is_active_owner());

create policy lessons_owner_all on daily_cs_private.lessons
  for all to authenticated
  using (daily_cs_private.is_active_owner() and owner_uid = auth.uid())
  with check (
    (current_setting('request.daily_cs_owner_rpc', true) = 'true')
    or (daily_cs_private.is_active_owner() and owner_uid = auth.uid())
  );

create policy revisions_owner_all on daily_cs_private.lesson_revisions
  for all to authenticated
  using (
    daily_cs_private.is_active_owner()
    and exists (
      select 1 from daily_cs_private.lessons l
      where l.id = daily_cs_private.lesson_revisions.lesson_id and l.owner_uid = auth.uid()
    )
  )
  with check (
    (current_setting('request.daily_cs_owner_rpc', true) = 'true')
    or daily_cs_private.is_active_owner()
  );

create policy owner_only_all on daily_cs_private.schedule_overrides
  for all to authenticated using (daily_cs_private.is_active_owner()) with check (daily_cs_private.is_active_owner());
create policy snapshots_owner_all on daily_cs_private.day_snapshots
  for all to authenticated using (daily_cs_private.is_active_owner()) with check (daily_cs_private.is_active_owner());
create policy mail_owner_all on daily_cs_private.mail_outbox
  for all to authenticated using (daily_cs_private.is_active_owner()) with check (daily_cs_private.is_active_owner());
create policy import_owner_all on daily_cs_private.import_batches
  for all to authenticated using (daily_cs_private.is_active_owner()) with check (daily_cs_private.is_active_owner());

grant select, insert, update, delete on all tables in schema daily_cs_private to authenticated;
grant usage, select on all sequences in schema daily_cs_private to authenticated;

create or replace function public.daily_cs_before_user_created(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  email text := event #>> '{user,email}';
  provider text := coalesce(
    event #>> '{user,app_metadata,provider}',
    event #>> '{user,raw_app_meta_data,provider}'
  );
  hashed_email text;
begin
  if email is null or lower(provider) <> 'google' then
    raise exception using errcode = '42501', message = 'forbidden: google owner allowlist required';
  end if;

  hashed_email := daily_cs_private.normalize_email_hash(email);

  if not exists (
    select 1
    from daily_cs_private.owner_allowlist
    where email_hash = hashed_email and provider = 'google'
  ) then
    raise exception using errcode = '42501', message = 'forbidden: google owner allowlist required';
  end if;

  update daily_cs_private.owner_allowlist
  set consumed_at = coalesce(consumed_at, now())
  where email_hash = hashed_email;

  return event;
end;
$$;

revoke all on function public.daily_cs_before_user_created(jsonb) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'supabase_auth_admin') then
    grant execute on function public.daily_cs_before_user_created(jsonb) to supabase_auth_admin;
  end if;
end $$;

create or replace function daily_cs_private.api_ok(value jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('data', coalesce(value, '{}'::jsonb))
$$;

create or replace function daily_cs_private.api_error(code text, message text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('error', jsonb_build_object('code', code, 'message', message))
$$;

create or replace function daily_cs_private.lock_settings()
returns daily_cs_private.settings
language sql
volatile
set search_path = ''
as $$
  select * from daily_cs_private.settings where singleton for update
$$;

create or replace function daily_cs_private.freeze_elapsed_days()
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  insert into daily_cs_private.day_snapshots (
    snapshot_date, lesson_id, revision_id, legacy_id, title, category,
    document_kind, document, content_hash, empty_reason
  )
  select
    m.scheduled_date,
    l.id,
    r.id,
    l.legacy_id,
    r.title,
    r.category,
    r.document_kind,
    r.document,
    r.content_hash,
    null
  from daily_cs_private.mail_outbox m
  join daily_cs_private.lessons l on l.id = (
    select lesson_id from daily_cs_private.lesson_revisions rr where rr.id = m.snapshot_id limit 1
  )
  join daily_cs_private.lesson_revisions r on r.lesson_id = l.id and r.revision_number = l.published_revision
  where m.scheduled_date < (now() at time zone 'Asia/Seoul')::date
  on conflict (snapshot_date) do nothing;
end;
$$;

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
      return daily_cs_private.api_error('conflict', 'lesson is referenced by historical snapshots');
    end if;
    delete from daily_cs_private.lessons where id = lesson_row.id;
    if pg_catalog.to_regprocedure('daily_cs_private.on_catalog_change(uuid)') is not null then
      execute 'select daily_cs_private.on_catalog_change($1)' using lesson_row.id;
    end if;
    return daily_cs_private.api_ok(jsonb_build_object('purged', true));
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

revoke all on function public.daily_cs_owner_api(text, jsonb) from public, anon;
grant execute on function public.daily_cs_owner_api(text, jsonb) to authenticated;

revoke all on function daily_cs_private.is_active_owner() from public, anon;
revoke all on function daily_cs_private.require_active_owner() from public, anon;
grant execute on function daily_cs_private.is_active_owner() to authenticated;
grant execute on function daily_cs_private.require_active_owner() to authenticated;

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
    if payload ->> 'legacyState' not in ('sent', 'uncertain') then
      return daily_cs_private.api_error('validation_failed', 'legacyState must be sent or uncertain');
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
    if message_row.state = 'sent' then
      return daily_cs_private.api_ok(jsonb_build_object('state', 'sent', 'messageId', message_row.id));
    end if;
    if payload ->> 'legacyState' = 'sent' then
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
        last_error = left(coalesce(payload ->> 'reason', 'legacy uncertain guard'), 200),
        updated_at = daily_cs_private.mail_now()
    where id = message_row.id
    returning * into message_row;
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
      return daily_cs_private.api_error('conflict', 'claim expired');
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

create or replace function public.daily_cs_backup_api(action text, payload jsonb, token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  credential_id uuid;
  export_body jsonb;
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

  export_body := jsonb_build_object(
    'schemaVersion', 2,
    'settings', (select to_jsonb(s) from daily_cs_private.settings s where singleton),
    'lessons', coalesce((select jsonb_agg(to_jsonb(l) order by l.legacy_id nulls last, l.created_at) from daily_cs_private.lessons l), '[]'::jsonb),
    'revisions', coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at) from daily_cs_private.lesson_revisions r), '[]'::jsonb),
    'scheduleOverrides', coalesce((select jsonb_agg(to_jsonb(o) order by o.schedule_date) from daily_cs_private.schedule_overrides o), '[]'::jsonb)
  );

  return daily_cs_private.api_ok(jsonb_build_object(
    'export', export_body || jsonb_build_object('hash', daily_cs_private.document_hash(export_body))
  ));
end;
$$;

revoke all on function public.daily_cs_backup_api(text, jsonb, text) from public, anon, authenticated;
grant execute on function public.daily_cs_backup_api(text, jsonb, text) to service_role;
