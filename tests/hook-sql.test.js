const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const rootDir = path.resolve(__dirname, "..");
const migrationsDir = path.join(rootDir, "supabase", "migrations");
const baseMigrationPath = path.join(migrationsDir, "20260914142658_daily_cs_v2_owner_api.sql");
const repairMigrationPath = path.join(migrationsDir, "20260921224340_owner_hook_repair.sql");

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
  const containerName = `daily-cs-v2-hook-${process.pid}-${Date.now()}`;
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

const supabaseHookHarnessSql = `
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin nologin; end if;
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

create or replace function public.rls_auto_enable()
returns event_trigger
language plpgsql
security definer
as $$
begin
  null;
end;
$$;
`;

const oldHookAmbiguitySql = `
insert into daily_cs_private.owner_allowlist (email_hash, provider)
values (daily_cs_private.normalize_email_hash('owner@example.invalid'), 'google');

do $$
begin
  begin
    perform public.daily_cs_before_user_created(
      jsonb_build_object(
        'user',
        jsonb_build_object(
          'email', 'owner@example.invalid',
          'app_metadata', jsonb_build_object('provider', 'google')
        )
      )
    );
    raise exception 'old hook should fail with provider ambiguity';
  exception
    when ambiguous_column then
      null;
  end;
end $$;
`;

const repairedHookAssertionsSql = `
do $$
declare
  allowed_event jsonb := jsonb_build_object(
    'user',
    jsonb_build_object(
      'email', 'owner@example.invalid',
      'app_metadata', jsonb_build_object('provider', 'google')
    )
  );
  missing_provider_event jsonb := jsonb_build_object(
    'user',
    jsonb_build_object('email', 'owner@example.invalid')
  );
  null_provider_event jsonb := jsonb_build_object(
    'user',
    jsonb_build_object(
      'email', 'owner@example.invalid',
      'app_metadata', jsonb_build_object('provider', null)
    )
  );
  github_event jsonb := jsonb_build_object(
    'user',
    jsonb_build_object(
      'email', 'owner@example.invalid',
      'app_metadata', jsonb_build_object('provider', 'github')
    )
  );
  outsider_event jsonb := jsonb_build_object(
    'user',
    jsonb_build_object(
      'email', 'outsider@example.invalid',
      'app_metadata', jsonb_build_object('provider', 'google')
    )
  );
begin
  if public.daily_cs_before_user_created(allowed_event) <> allowed_event then
    raise exception 'allowed google owner event should pass through unchanged';
  end if;

  if not exists (
    select 1
    from daily_cs_private.owner_allowlist as allowlist
    where allowlist.email_hash = daily_cs_private.normalize_email_hash('owner@example.invalid')
      and allowlist.provider = 'google'
      and allowlist.consumed_at is not null
  ) then
    raise exception 'allowed google owner hash should be consumed';
  end if;

  begin
    perform public.daily_cs_before_user_created(missing_provider_event);
    raise exception 'missing provider should be denied';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform public.daily_cs_before_user_created(null_provider_event);
    raise exception 'null provider should be denied';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform public.daily_cs_before_user_created(github_event);
    raise exception 'non-google provider should be denied';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform public.daily_cs_before_user_created(outsider_event);
    raise exception 'google user outside allowlist should be denied';
  exception
    when insufficient_privilege then null;
  end;

  if has_function_privilege('anon', 'public.daily_cs_before_user_created(jsonb)', 'EXECUTE') then
    raise exception 'anon must not execute owner bootstrap hook';
  end if;

  if has_function_privilege('authenticated', 'public.daily_cs_before_user_created(jsonb)', 'EXECUTE') then
    raise exception 'authenticated must not execute owner bootstrap hook';
  end if;

  if not has_function_privilege('supabase_auth_admin', 'public.daily_cs_before_user_created(jsonb)', 'EXECUTE') then
    raise exception 'supabase_auth_admin must execute owner bootstrap hook';
  end if;

  if has_function_privilege('anon', 'public.rls_auto_enable()', 'EXECUTE') then
    raise exception 'anon must not execute hosted rls_auto_enable helper';
  end if;

  if has_function_privilege('authenticated', 'public.rls_auto_enable()', 'EXECUTE') then
    raise exception 'authenticated must not execute hosted rls_auto_enable helper';
  end if;
end $$;
`;

test("Given the frozen base hook When the allowed Google path runs Then Postgres reproduces provider ambiguity", () => {
  const containerName = startPostgres();
  try {
    psql(containerName, supabaseHookHarnessSql);
    psql(containerName, fs.readFileSync(baseMigrationPath, "utf8"));
    const output = psql(containerName, oldHookAmbiguitySql);
    assert.equal(output.includes("ERROR:"), false, output);
  } finally {
    stopPostgres(containerName);
  }
});

test("Given the additive hook repair When auth events are checked Then only the configured Google hash is allowed", () => {
  const containerName = startPostgres();
  try {
    psql(containerName, supabaseHookHarnessSql);
    psql(containerName, fs.readFileSync(baseMigrationPath, "utf8"));
    psql(containerName, oldHookAmbiguitySql);
    psql(containerName, fs.readFileSync(repairMigrationPath, "utf8"));
    const output = psql(containerName, repairedHookAssertionsSql);
    assert.equal(output.includes("ERROR:"), false, output);
  } finally {
    stopPostgres(containerName);
  }
});
