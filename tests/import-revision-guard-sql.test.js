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
      docker(["exec", containerName, "pg_isready", "-U", "postgres"]);
      return;
    } catch {
      sleepSync(1000);
    }
  }
  throw new Error("Postgres container did not become ready");
}

function startPostgres() {
  const containerName = `daily-cs-v2-import-guard-${process.pid}-${Date.now()}`;
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

const importRevisionGuardSql = `
do $$
declare
  owner_uid uuid := '99999999-9999-9999-9999-999999999999'::uuid;
  lesson jsonb := jsonb_build_object(
    'id', '999',
    'order', 987654321,
    'track', 'synthetic',
    'category', 'database',
    'level', 'foundation',
    'week', 1,
    'title', 'Synthetic import revision guard v1',
    'summary', 'Synthetic summary',
    'keywords', jsonb_build_array('synthetic'),
    'question', 'Synthetic question?',
    'answer', 'Synthetic answer version one is long enough for publication.',
    'explanation', jsonb_build_array('Synthetic explanation.'),
    'example', jsonb_build_object('language', 'sql', 'code', 'select 1;', 'description', 'Synthetic example'),
    'pitfalls', jsonb_build_array('Synthetic pitfall'),
    'followUps', jsonb_build_array(jsonb_build_object('question', 'Follow?', 'answer', 'Answer.')),
    'quiz', jsonb_build_object('question', 'Quiz?', 'choices', jsonb_build_array('A', 'B'), 'answerIndex', 0, 'explanation', 'Because.'),
    'sources', jsonb_build_array(jsonb_build_object('title', 'Synthetic source', 'url', 'https://example.invalid', 'note', 'Synthetic')),
    'versionNote', 'Synthetic version note'
  );
  changed_lesson jsonb := jsonb_set(
    jsonb_set(lesson, '{title}', to_jsonb('Synthetic import revision guard v2'::text)),
    '{answer}',
    to_jsonb('Synthetic answer version two is long enough and intentionally different.'::text)
  );
  invalid_lessons jsonb := jsonb_build_array(
    jsonb_set(lesson, '{order}', to_jsonb(987654322)),
    jsonb_build_object('id', 'bad')
  );
  imported_lesson_id uuid;
  first_revision_hash text;
  final_revision_one_hash text;
  revision_count integer;
  published_revision integer;
begin
  perform daily_cs_private.commit_simple_lessons(jsonb_build_array(lesson), owner_uid);

  select l.id, r.content_hash
  into imported_lesson_id, first_revision_hash
  from daily_cs_private.lessons l
  join daily_cs_private.lesson_revisions r on r.lesson_id = l.id and r.revision_number = 1
  where l.legacy_id = 987654321;

  perform daily_cs_private.commit_simple_lessons(jsonb_build_array(changed_lesson), owner_uid);

  select
    l.published_revision,
    count(r.*)::integer,
    max(r.content_hash) filter (where r.revision_number = 1)
  into published_revision, revision_count, final_revision_one_hash
  from daily_cs_private.lessons l
  join daily_cs_private.lesson_revisions r on r.lesson_id = l.id
  where l.id = imported_lesson_id
  group by l.id, l.published_revision;

  if revision_count <> 2 or published_revision <> 2 or final_revision_one_hash <> first_revision_hash then
    raise exception 'changed import should append revision 2 without rewriting revision 1';
  end if;

  begin
    perform daily_cs_private.commit_simple_lessons(invalid_lessons, owner_uid);
    raise exception 'invalid import should fail';
  exception
    when invalid_parameter_value then
      null;
  end;

  if exists (select 1 from daily_cs_private.lessons where legacy_id = 987654322) then
    raise exception 'invalid import should not partially commit earlier valid lessons';
  end if;
end $$;
`;

test("Given repeated simple lesson imports When content changes Then a new revision is appended and invalid batches stay atomic", () => {
  const containerName = startPostgres();
  try {
    psql(containerName, authHarnessSql);
    for (const file of fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort()) {
      psql(containerName, fs.readFileSync(path.join(migrationsDir, file), "utf8"));
    }
    const output = psql(containerName, importRevisionGuardSql);
    assert.equal(output.includes("ERROR:"), false, output);
  } finally {
    stopPostgres(containerName);
  }
});
