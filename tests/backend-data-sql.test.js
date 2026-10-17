const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const rootDir = path.resolve(__dirname, "..");
const migrationsDir = path.join(rootDir, "supabase", "migrations");

function docker(args, options = {}) {
  return execFileSync("docker", args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: options.input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function psql(containerName, sql) {
  return docker(["exec", "-i", containerName, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], {
    input: sql,
  });
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForPostgres(containerName) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      docker(["exec", containerName, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]);
      return;
    } catch {
      sleepSync(1000);
    }
  }
  throw new Error("Postgres container did not become ready");
}

test("Given retry sleep When running on Linux CI Then it does not require PowerShell", () => {
  assert.equal(waitForPostgres.toString().includes(`power${"shell"}`), false);
  assert.doesNotThrow(() => sleepSync(1));
});

function startPostgres() {
  const containerName = `daily-cs-v2-data-${process.pid}-${Date.now()}`;
  docker(["run", "-d", "--name", containerName, "-e", "POSTGRES_PASSWORD=postgres", "postgres:17-alpine"]);
  waitForPostgres(containerName);
  return containerName;
}

function stopPostgres(containerName) {
  try {
    docker(["rm", "-f", containerName]);
  } catch {
    // Container cleanup is best effort after Docker failures.
  }
}

const authHarnessSql = `
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;

create schema if not exists auth;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table auth.sessions (id uuid primary key, user_id uuid not null, not_after timestamptz);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
`;

const dataAssertionsSql = `
create or replace function daily_cs_private.schedule_now()
returns timestamptz language sql stable set search_path = ''
as $$ select '2026-09-15T01:00:00Z'::timestamptz $$;

insert into daily_cs_private.owner_profile (owner_uid, owner_email_hash)
values ('11111111-1111-1111-1111-111111111111', 'owner-email-hash');

insert into auth.sessions (id, user_id, not_after)
values ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', now() + interval '1 hour');

create or replace function pg_temp.seed_claimed_mail()
returns void
language sql
security definer
set search_path = ''
as $$
  insert into daily_cs_private.mail_outbox (kind, scheduled_date, send_after, state, subject, text_body, html_body)
  values ('daily', (daily_cs_private.mail_now() at time zone 'Asia/Seoul')::date, daily_cs_private.mail_now(), 'claimed', 's', 't', 'h');
$$;

create or replace function pg_temp.clear_mail_outbox()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from daily_cs_private.mail_outbox;
$$;

create or replace function pg_temp.seed_existing_snapshot()
returns void
language sql
security definer
set search_path = ''
as $$
  insert into daily_cs_private.day_snapshots (snapshot_date, content_hash, send_eligible_at)
  values (date '2026-09-15', 'existing-hash', daily_cs_private.schedule_at(date '2026-09-15'));
$$;


create or replace function pg_temp.seed_lesson_snapshot(target_lesson_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  revision_id uuid;
begin
  select id into revision_id
  from daily_cs_private.lesson_revisions
  where lesson_id = target_lesson_id
  order by revision_number desc
  limit 1;

  insert into daily_cs_private.day_snapshots (
    snapshot_date, lesson_id, revision_id, legacy_id, title, category,
    document_kind, document, content_hash, send_eligible_at
  )
  select
    date '2026-09-15', l.id, revision_id, l.legacy_id, l.title, l.category,
    l.document_kind, r.document, r.content_hash, daily_cs_private.schedule_at(date '2026-09-15')
  from daily_cs_private.lessons l
  join daily_cs_private.lesson_revisions r on r.id = revision_id
  where l.id = target_lesson_id;
  update daily_cs_private.schedule_state
  set last_frozen_date = greatest(last_frozen_date, date '2026-09-15')
  where singleton;
end;
$$;

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select set_config('request.jwt.claims', '{"session_id":"22222222-2222-2222-2222-222222222222"}', false);

do $$
declare
  lesson jsonb := jsonb_build_object(
    'id', '001',
    'order', 1,
    'track', 'common',
    'category', 'database',
    'level', 'foundation',
    'week', 1,
    'title', 'Synthetic import lesson',
    'summary', 'Synthetic summary',
    'keywords', jsonb_build_array('db'),
    'question', 'Synthetic question?',
    'answer', 'Synthetic answer that is long enough for publication.',
    'explanation', jsonb_build_array('Synthetic explanation.'),
    'example', jsonb_build_object('language', 'sql', 'code', 'select 1;', 'description', 'Synthetic example'),
    'pitfalls', jsonb_build_array('Synthetic pitfall'),
    'followUps', jsonb_build_array(jsonb_build_object('question', 'Follow?', 'answer', 'Answer.')),
    'quiz', jsonb_build_object('question', 'Quiz?', 'choices', jsonb_build_array('A', 'B'), 'answerIndex', 0, 'explanation', 'Because.'),
    'sources', jsonb_build_array(jsonb_build_object('title', 'Synthetic source', 'url', 'https://example.invalid', 'note', 'Synthetic')),
    'versionNote', 'Synthetic version note'
  );
  lessons jsonb := jsonb_build_array(lesson);
  preview jsonb;
  committed jsonb;
  exported jsonb;
  restore_result jsonb;
  imported_lesson_id uuid;
  purge_result jsonb;
begin
  preview := public.daily_cs_owner_api('import.preview', jsonb_build_object('lessons', lessons));
  if preview #>> '{data,mode}' <> 'simpleLessons' or preview #>> '{data,lessons}' <> '1' then
    raise exception 'simple import preview failed: %', preview;
  end if;

  committed := public.daily_cs_owner_api(
    'import.commit',
    jsonb_build_object('lessons', lessons, 'expectedExportHash', preview #>> '{data,hash}')
  );
  if committed #>> '{data,imported,lessons}' <> '1' then
    raise exception 'simple import commit failed: %', committed;
  end if;

  select id into imported_lesson_id from daily_cs_private.lessons where legacy_id = 1;
  perform pg_temp.seed_lesson_snapshot(imported_lesson_id);
  purge_result := public.daily_cs_owner_api('lesson.purge', jsonb_build_object('id', imported_lesson_id, 'expectedRevision', 1));
  if purge_result #>> '{data,retainedHistory}' <> 'true' then
    raise exception 'purge should tombstone snapshot-referenced lessons: %', purge_result;
  end if;
  if public.daily_cs_owner_api('lesson.get', jsonb_build_object('id', imported_lesson_id)) #>> '{error,code}' <> 'not_found' then
    raise exception 'purged lesson should be hidden from owner catalog';
  end if;

  exported := public.daily_cs_owner_api('export.create', '{"includeTrash":true}'::jsonb);
  if exported #>> '{data,export,hash}' is null or exported #>> '{data,export,lessons,0,owner_uid}' is not null then
    raise exception 'export leaked owner metadata or missed hash: %', exported;
  end if;
  if exported #>> '{data,export,lessons,0,purgedAt}' is null then
    raise exception 'export should preserve purgedAt tombstone compatibility: %', exported;
  end if;

  perform pg_temp.seed_claimed_mail();
  restore_result := public.daily_cs_owner_api(
    'backup.restore',
    jsonb_build_object('export', exported #> '{data,export}', 'expectedExportHash', exported #>> '{data,export,hash}')
  );
  if restore_result #>> '{error,code}' <> 'conflict' then
    raise exception 'restore should block active mail jobs: %', restore_result;
  end if;
  perform pg_temp.clear_mail_outbox();

  restore_result := public.daily_cs_owner_api(
    'backup.restore',
    jsonb_build_object(
      'export',
      jsonb_set(exported #> '{data,export}', '{daySnapshots}', jsonb_build_array(jsonb_build_object('date', '2026-09-15', 'contentHash', 'different-hash'))),
      'expectedExportHash',
      daily_cs_private.document_hash(jsonb_set((exported #> '{data,export}') - 'hash', '{daySnapshots}', jsonb_build_array(jsonb_build_object('date', '2026-09-15', 'contentHash', 'different-hash'))))
    )
  );
  if restore_result #>> '{error,code}' <> 'validation_failed' and restore_result #>> '{error,code}' <> 'conflict' then
    raise exception 'restore should reject changed historical snapshot: %', restore_result;
  end if;
end $$;
`;

test("Given data migration When owner imports and restores Then ledger and snapshots are protected", () => {
  const containerName = startPostgres();
  try {
    psql(containerName, authHarnessSql);
    for (const file of fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort()) {
      psql(containerName, fs.readFileSync(path.join(migrationsDir, file), "utf8"));
    }
    const output = psql(containerName, dataAssertionsSql);
    assert.equal(output.includes("ERROR:"), false, output);
  } finally {
    stopPostgres(containerName);
  }
});
