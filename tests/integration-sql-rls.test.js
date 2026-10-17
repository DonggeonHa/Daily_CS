const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const rootDir = path.resolve(__dirname, "..");
const migrationPath = path.join(rootDir, "supabase", "migrations", "20260914142658_daily_cs_v2_owner_api.sql");

function docker(args, options = {}) {
  return execFileSync("docker", args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: options.input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    ...options
  });
}

function psql(containerName, sql) {
  return docker(["exec", "-i", containerName, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], {
    input: sql
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
  const containerName = `daily-cs-v2-sql-${process.pid}-${Date.now()}`;
  docker([
    "run",
    "-d",
    "--name",
    containerName,
    "-e",
    "POSTGRES_PASSWORD=postgres",
    "postgres:17-alpine"
  ]);
  waitForPostgres(containerName);
  return containerName;
}

function stopPostgres(containerName) {
  try {
    docker(["rm", "-f", containerName]);
  } catch {
    // The container may already be gone after an early Docker failure.
  }
}

const supabaseAuthHarnessSql = `
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end $$;

create schema if not exists auth;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table auth.sessions (
  id uuid primary key,
  user_id uuid not null,
  not_after timestamptz
);

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

const behaviorAssertionsSql = `
insert into daily_cs_private.owner_profile (owner_uid, owner_email_hash)
values ('11111111-1111-1111-1111-111111111111', 'owner-email-hash');

insert into auth.sessions (id, user_id, not_after)
values
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', now() + interval '1 hour'),
  ('33333333-3333-3333-3333-333333333333', '99999999-9999-9999-9999-999999999999', now() + interval '1 hour'),
  ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', now() - interval '1 hour');

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select set_config('request.jwt.claims', '{"session_id":"22222222-2222-2222-2222-222222222222"}', false);

do $$
begin
  if not daily_cs_private.is_active_owner() then
    raise exception 'expected active owner session';
  end if;
  if (select count(*) from daily_cs_private.settings) <> 1 then
    raise exception 'active owner should see singleton settings';
  end if;
end $$;

insert into daily_cs_private.lessons (owner_uid, title, category, state, document_kind, draft_document)
values (
  '11111111-1111-1111-1111-111111111111',
  'Synthetic SQL RLS lesson',
  'database',
  'draft',
  'markdown',
  '{"markdown":"\`\`\`java\\nList<String> values = List.of(\\"x\\");\\n\`\`\`"}'::jsonb
);

select daily_cs_private.validate_document(
  'markdown',
  '{"markdown":"\`\`\`java\\nList<String> values = List.of(\\"x\\");\\n\`\`\`"}'::jsonb
);

do $$
begin
  begin
    perform daily_cs_private.validate_document('markdown', '{"markdown":"Safe text\\n<script>alert(1)</script>"}'::jsonb);
    raise exception 'raw html outside code fence should be rejected';
  exception
    when invalid_parameter_value then
      null;
  end;
end $$;

do $$
declare
  result jsonb;
  lesson_id uuid;
  revision_id uuid;
  row_revision integer;
begin
  result := public.daily_cs_owner_api('settings.get', '{}'::jsonb);
  if result #>> '{data,settings,timezone}' <> 'Asia/Seoul' then
    raise exception 'active owner settings RPC failed: %', result;
  end if;

  result := public.daily_cs_owner_api(
    'lesson.create',
    jsonb_build_object(
      'title', 'Synthetic RPC Draft',
      'category', 'database',
      'documentKind', 'markdown',
      'document', jsonb_build_object('markdown', '## Synthetic draft\\nThis body is long enough to publish safely.'),
      'state', 'draft'
    )
  );
  if result ? 'error' then
    raise exception 'lesson.create failed: %', result;
  end if;
  lesson_id := (result #>> '{data,lesson,id}')::uuid;
  row_revision := (result #>> '{data,lesson,row_revision}')::integer;

  result := public.daily_cs_owner_api(
    'lesson.saveDraft',
    jsonb_build_object(
      'id', lesson_id,
      'expectedRevision', row_revision + 1,
      'title', 'Stale write',
      'category', 'database',
      'documentKind', 'markdown',
      'document', jsonb_build_object('markdown', '## stale')
    )
  );
  if result #>> '{error,code}' <> 'conflict' then
    raise exception 'stale saveDraft should conflict: %', result;
  end if;

  result := public.daily_cs_owner_api(
    'lesson.saveDraft',
    jsonb_build_object(
      'id', lesson_id,
      'expectedRevision', row_revision,
      'title', 'Synthetic RPC Draft Updated',
      'category', 'database',
      'documentKind', 'markdown',
      'document', jsonb_build_object('markdown', '## Synthetic draft\\nUpdated safe body with enough text.')
    )
  );
  if result ? 'error' then
    raise exception 'saveDraft with current revision failed: %', result;
  end if;
  row_revision := (result #>> '{data,lesson,row_revision}')::integer;

  result := public.daily_cs_owner_api(
    'lesson.publish',
    jsonb_build_object('id', lesson_id, 'expectedRevision', row_revision)
  );
  if result #>> '{data,lesson,state}' <> 'published' or result #>> '{data,revision,id}' is null then
    raise exception 'publish failed: %', result;
  end if;
  revision_id := (result #>> '{data,revision,id}')::uuid;
  row_revision := (result #>> '{data,lesson,row_revision}')::integer;

  insert into daily_cs_private.day_snapshots (
    snapshot_date, lesson_id, revision_id, title, category, document_kind, document, content_hash
  )
  values (
    current_date - 1,
    lesson_id,
    revision_id,
    'Frozen synthetic snapshot',
    'database',
    'markdown',
    jsonb_build_object('markdown', 'Frozen immutable body'),
    'synthetic-hash'
  );

  result := public.daily_cs_owner_api(
    'lesson.purge',
    jsonb_build_object('id', lesson_id, 'expectedRevision', row_revision)
  );
  if result #>> '{error,code}' <> 'conflict' then
    raise exception 'purge of historically referenced lesson should conflict: %', result;
  end if;
end $$;

select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select set_config('request.jwt.claims', '{"session_id":"33333333-3333-3333-3333-333333333333"}', false);
do $$
declare
  result jsonb;
begin
  if daily_cs_private.is_active_owner() then
    raise exception 'forged owner subject with non-owner session should not be active';
  end if;
  result := public.daily_cs_owner_api('settings.get', '{}'::jsonb);
  if result #>> '{error,code}' <> 'forbidden' then
    raise exception 'forged owner/session RPC should be forbidden: %', result;
  end if;
end $$;

select set_config('request.jwt.claims', '{"session_id":"44444444-4444-4444-4444-444444444444"}', false);
do $$
begin
  if daily_cs_private.is_active_owner() then
    raise exception 'expired owner session should not be active';
  end if;
  if (select count(*) from daily_cs_private.settings) <> 0 then
    raise exception 'expired owner session should not see settings through RLS';
  end if;
end $$;

select set_config('request.jwt.claim.sub', '99999999-9999-9999-9999-999999999999', false);
select set_config('request.jwt.claims', '{"session_id":"33333333-3333-3333-3333-333333333333"}', false);
do $$
begin
  if daily_cs_private.is_active_owner() then
    raise exception 'non-owner session should not be active';
  end if;
  begin
    insert into daily_cs_private.lessons (owner_uid, title, category, state, document_kind, draft_document)
    values ('11111111-1111-1111-1111-111111111111', 'Bad write', 'database', 'draft', 'markdown', '{"markdown":"x"}'::jsonb);
    raise exception 'non-owner should not be able to write owner lesson';
  exception
    when insufficient_privilege then
      null;
  end;
end $$;

reset role;
set role anon;
do $$
begin
  begin
    perform count(*) from daily_cs_private.settings;
    raise exception 'anon should not access private settings';
  exception
    when insufficient_privilege then
      null;
  end;
end $$;

reset role;

insert into daily_cs_private.api_credentials (scope, token_hash, label)
values
  ('mail', daily_cs_private.sha256_text('mail-secret'), 'test mail key'),
  ('backup_export', daily_cs_private.sha256_text('backup-secret'), 'test backup key');

insert into daily_cs_private.mail_outbox (kind, scheduled_date, send_after, subject, text_body, html_body, command_id)
values ('daily', (daily_cs_private.mail_now() at time zone 'Asia/Seoul')::date, daily_cs_private.mail_now() - interval '1 minute', 'Synthetic subject', 'Synthetic text', '<p>Synthetic html</p>', gen_random_uuid());

do $$
declare
  result jsonb;
  message jsonb;
  message_id uuid;
  claim_token text;
  repeated_claim jsonb;
  second_message_id uuid;
  second_claim_token text;
begin
  begin
    set local role authenticated;
    perform public.daily_cs_mail_api('mail.claimDue', '{}'::jsonb, 'mail-secret');
    raise exception 'authenticated users should not execute mail API';
  exception
    when insufficient_privilege then
      reset role;
  end;

  result := public.daily_cs_mail_api('mail.claimDue', '{"workerId":"sql-test"}'::jsonb, 'backup-secret');
  if result #>> '{error,code}' <> 'forbidden' then
    raise exception 'backup key should not claim mail: %', result;
  end if;

  result := public.daily_cs_mail_api('mail.claimDue', '{"workerId":"sql-test"}'::jsonb, 'mail-secret');
  message := result #> '{data,message}';
  if message is null or message ? 'to' or message ->> 'claimToken' is null then
    raise exception 'mail claim returned unsafe or incomplete payload: %', result;
  end if;

  message_id := (message ->> 'id')::uuid;
  claim_token := message ->> 'claimToken';

  result := public.daily_cs_mail_api('mail.claimDue', '{"workerId":"sql-test-2"}'::jsonb, 'mail-secret');
  if result #> '{data,message}' <> 'null'::jsonb then
    raise exception 'duplicate active claim should not return same queued message: %', result;
  end if;

  result := public.daily_cs_mail_api(
    'mail.beginSending',
    jsonb_build_object('messageId', message_id, 'claimToken', 'wrong-token'),
    'mail-secret'
  );
  if result #>> '{error,code}' <> 'forbidden' then
    raise exception 'beginSending with wrong claim token should be forbidden: %', result;
  end if;

  result := public.daily_cs_mail_api(
    'mail.beginSending',
    jsonb_build_object('messageId', message_id, 'claimToken', claim_token),
    'mail-secret'
  );
  if result #>> '{data,state}' <> 'sending' then
    raise exception 'beginSending should move to sending: %', result;
  end if;

  result := public.daily_cs_mail_api(
    'mail.ackSent',
    jsonb_build_object('messageId', message_id, 'claimToken', claim_token, 'providerMessageId', 'synthetic-provider-id'),
    'mail-secret'
  );
  if result #>> '{data,state}' <> 'sent' then
    raise exception 'ackSent should move to sent: %', result;
  end if;

  result := public.daily_cs_mail_api(
    'mail.ackSent',
    jsonb_build_object('messageId', message_id, 'claimToken', claim_token, 'providerMessageId', 'synthetic-provider-id'),
    'mail-secret'
  );
  if result #>> '{data,state}' <> 'sent' then
    raise exception 'duplicate ackSent should be idempotent: %', result;
  end if;

  insert into daily_cs_private.mail_outbox (kind, scheduled_date, send_after, subject, text_body, html_body, command_id)
  values ('test', (daily_cs_private.mail_now() at time zone 'Asia/Seoul')::date, daily_cs_private.mail_now() - interval '1 minute', 'Synthetic uncertainty', 'Synthetic text', '<p>Synthetic html</p>', gen_random_uuid());

  result := public.daily_cs_mail_api('mail.claimDue', '{"workerId":"sql-test"}'::jsonb, 'mail-secret');
  repeated_claim := result #> '{data,message}';
  second_message_id := (repeated_claim ->> 'id')::uuid;
  second_claim_token := repeated_claim ->> 'claimToken';

  update daily_cs_private.mail_outbox
  set claim_expires_at = now() - interval '1 minute'
  where id = second_message_id;

  result := public.daily_cs_mail_api('mail.claimDue', '{"workerId":"sql-test-reclaim"}'::jsonb, 'mail-secret');
  if (result #>> '{data,message,id}')::uuid <> second_message_id then
    raise exception 'expired claimed message should be reclaimable before sending: %', result;
  end if;
  second_claim_token := result #>> '{data,message,claimToken}';

  result := public.daily_cs_mail_api(
    'mail.beginSending',
    jsonb_build_object('messageId', second_message_id, 'claimToken', second_claim_token),
    'mail-secret'
  );
  if result #>> '{data,state}' <> 'sending' then
    raise exception 'second beginSending should move to sending: %', result;
  end if;

  result := public.daily_cs_mail_api(
    'mail.markUncertain',
    jsonb_build_object('messageId', second_message_id, 'claimToken', second_claim_token, 'reason', 'synthetic crash after provider handoff'),
    'mail-secret'
  );
  if result #>> '{data,state}' <> 'uncertain' then
    raise exception 'markUncertain should move sending message to uncertain: %', result;
  end if;

  result := public.daily_cs_mail_api(
    'mail.ackSent',
    jsonb_build_object('messageId', second_message_id, 'claimToken', 'wrong-token', 'providerMessageId', 'late-provider-id'),
    'mail-secret'
  );
  if result #>> '{error,code}' <> 'forbidden' then
    raise exception 'ack after uncertain with wrong claim should be forbidden: %', result;
  end if;

  result := public.daily_cs_mail_api(
    'mail.ackSent',
    jsonb_build_object('messageId', second_message_id, 'claimToken', second_claim_token, 'providerMessageId', 'late-provider-id'),
    'mail-secret'
  );
  if result #>> '{data,state}' <> 'sent' then
    raise exception 'ack after uncertain with original claim should reconcile to sent: %', result;
  end if;
end $$;
`;

test("Given a disposable Postgres When the Supabase migration is applied Then owner RLS, sessions, Markdown validation, and mail scopes execute", () => {
  const containerName = startPostgres();
  try {
    psql(containerName, supabaseAuthHarnessSql);
    psql(containerName, fs.readFileSync(migrationPath, "utf8"));
    const output = psql(containerName, behaviorAssertionsSql);
    assert.equal(output.includes("ERROR:"), false, output);
  } finally {
    stopPostgres(containerName);
  }
});

const mailStateAssertionsSql = `
insert into daily_cs_private.api_credentials (scope, token_hash, label)
values
  ('mail', daily_cs_private.sha256_text('mail-secret'), 'test mail key'),
  ('backup_export', daily_cs_private.sha256_text('backup-secret'), 'test backup key');

insert into daily_cs_private.mail_outbox (kind, scheduled_date, send_after, subject, text_body, html_body, command_id)
values ('daily', (daily_cs_private.mail_now() at time zone 'Asia/Seoul')::date, daily_cs_private.mail_now() - interval '1 minute', 'Synthetic subject', 'Synthetic text', '<p>Synthetic html</p>', gen_random_uuid());

set role authenticated;
do $$
begin
  begin
    perform public.daily_cs_mail_api('mail.claimDue', '{}'::jsonb, 'mail-secret');
    raise exception 'authenticated users should not execute mail API';
  exception
    when insufficient_privilege then
      null;
  end;
end $$;
reset role;

do $$
declare
  result jsonb;
  message jsonb;
  message_id uuid;
  claim_token text;
  repeated_claim jsonb;
  second_message_id uuid;
  second_claim_token text;
begin
  result := public.daily_cs_mail_api('mail.claimDue', '{"workerId":"sql-test"}'::jsonb, 'backup-secret');
  if result #>> '{error,code}' <> 'forbidden' then
    raise exception 'backup key should not claim mail: %', result;
  end if;

  result := public.daily_cs_mail_api('mail.claimDue', '{"workerId":"sql-test"}'::jsonb, 'mail-secret');
  message := result #> '{data,message}';
  if message is null or message ? 'to' or message ->> 'claimToken' is null then
    raise exception 'mail claim returned unsafe or incomplete payload: %', result;
  end if;

  message_id := (message ->> 'id')::uuid;
  claim_token := message ->> 'claimToken';

  result := public.daily_cs_mail_api('mail.claimDue', '{"workerId":"sql-test-2"}'::jsonb, 'mail-secret');
  if result #> '{data,message}' <> 'null'::jsonb then
    raise exception 'duplicate active claim should not return same queued message: %', result;
  end if;

  result := public.daily_cs_mail_api(
    'mail.beginSending',
    jsonb_build_object('messageId', message_id, 'claimToken', 'wrong-token'),
    'mail-secret'
  );
  if result #>> '{error,code}' <> 'forbidden' then
    raise exception 'beginSending with wrong claim token should be forbidden: %', result;
  end if;

  result := public.daily_cs_mail_api(
    'mail.beginSending',
    jsonb_build_object('messageId', message_id, 'claimToken', claim_token),
    'mail-secret'
  );
  if result #>> '{data,state}' <> 'sending' then
    raise exception 'beginSending should move to sending: %', result;
  end if;

  result := public.daily_cs_mail_api(
    'mail.ackSent',
    jsonb_build_object('messageId', message_id, 'claimToken', claim_token, 'providerMessageId', 'synthetic-provider-id'),
    'mail-secret'
  );
  if result #>> '{data,state}' <> 'sent' then
    raise exception 'ackSent should move to sent: %', result;
  end if;

  result := public.daily_cs_mail_api(
    'mail.ackSent',
    jsonb_build_object('messageId', message_id, 'claimToken', claim_token, 'providerMessageId', 'synthetic-provider-id'),
    'mail-secret'
  );
  if result #>> '{data,state}' <> 'sent' then
    raise exception 'duplicate ackSent should be idempotent: %', result;
  end if;

  insert into daily_cs_private.mail_outbox (kind, scheduled_date, send_after, subject, text_body, html_body, command_id)
  values ('test', (daily_cs_private.mail_now() at time zone 'Asia/Seoul')::date, daily_cs_private.mail_now() - interval '1 minute', 'Synthetic uncertainty', 'Synthetic text', '<p>Synthetic html</p>', gen_random_uuid());

  result := public.daily_cs_mail_api('mail.claimDue', '{"workerId":"sql-test"}'::jsonb, 'mail-secret');
  repeated_claim := result #> '{data,message}';
  second_message_id := (repeated_claim ->> 'id')::uuid;
  second_claim_token := repeated_claim ->> 'claimToken';

  update daily_cs_private.mail_outbox
  set claim_expires_at = now() - interval '1 minute'
  where id = second_message_id;

  result := public.daily_cs_mail_api('mail.claimDue', '{"workerId":"sql-test-reclaim"}'::jsonb, 'mail-secret');
  if (result #>> '{data,message,id}')::uuid <> second_message_id then
    raise exception 'expired claimed message should be reclaimable before sending: %', result;
  end if;
  second_claim_token := result #>> '{data,message,claimToken}';

  result := public.daily_cs_mail_api(
    'mail.beginSending',
    jsonb_build_object('messageId', second_message_id, 'claimToken', second_claim_token),
    'mail-secret'
  );
  if result #>> '{data,state}' <> 'sending' then
    raise exception 'second beginSending should move to sending: %', result;
  end if;

  result := public.daily_cs_mail_api(
    'mail.markUncertain',
    jsonb_build_object('messageId', second_message_id, 'claimToken', second_claim_token, 'reason', 'synthetic crash after provider handoff'),
    'mail-secret'
  );
  if result #>> '{data,state}' <> 'uncertain' then
    raise exception 'markUncertain should move sending message to uncertain: %', result;
  end if;

  result := public.daily_cs_mail_api(
    'mail.ackSent',
    jsonb_build_object('messageId', second_message_id, 'claimToken', 'wrong-token', 'providerMessageId', 'late-provider-id'),
    'mail-secret'
  );
  if result #>> '{error,code}' <> 'forbidden' then
    raise exception 'ack after uncertain with wrong claim should be forbidden: %', result;
  end if;

  result := public.daily_cs_mail_api(
    'mail.ackSent',
    jsonb_build_object('messageId', second_message_id, 'claimToken', second_claim_token, 'providerMessageId', 'late-provider-id'),
    'mail-secret'
  );
  if result #>> '{data,state}' <> 'sent' then
    raise exception 'ack after uncertain with original claim should reconcile to sent: %', result;
  end if;
end $$;
`;

test("Given a disposable Postgres When the mail API is exercised Then scoped keys, leases, idempotent ACK, and uncertainty rules hold", () => {
  const containerName = startPostgres();
  try {
    psql(containerName, supabaseAuthHarnessSql);
    psql(containerName, fs.readFileSync(migrationPath, "utf8"));
    const output = psql(containerName, mailStateAssertionsSql);
    assert.equal(output.includes("ERROR:"), false, output);
  } finally {
    stopPostgres(containerName);
  }
});
