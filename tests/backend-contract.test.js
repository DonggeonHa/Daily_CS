const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const MIGRATION = fs.readFileSync(
  path.join(ROOT, 'supabase', 'migrations', '20260914142658_daily_cs_v2_owner_api.sql'),
  'utf8',
);
const DATA_MIGRATION = fs.readFileSync(
  path.join(ROOT, 'supabase', 'migrations', '20260914144242_daily_cs_v2_data_import_export_restore.sql'),
  'utf8',
);
const PURGE_MIGRATION = fs.readFileSync(
  path.join(ROOT, 'supabase', 'migrations', '20260914151041_daily_cs_v2_tombstone_purge.sql'),
  'utf8',
);
const API_DOC = fs.readFileSync(path.join(ROOT, 'docs', 'API.md'), 'utf8');
const OWNER_EDGE = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'owner-api', 'index.ts'), 'utf8');
const MAIL_EDGE = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'mail-api', 'index.ts'), 'utf8');
const BACKUP_EDGE = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'backup-api', 'index.ts'), 'utf8');
const SUPABASE_CONFIG = fs.readFileSync(path.join(ROOT, 'supabase', 'config.toml'), 'utf8');
const BOOTSTRAP = fs.readFileSync(
  path.join(ROOT, 'supabase', 'bootstrap', 'private-bootstrap-template.sql'),
  'utf8',
);

test('owner content contract is private and action-envelope based', () => {
  assert.match(API_DOC, /POST.+\{ "action": "lesson\.saveDraft", "payload": \{\} \}/s);
  assert.match(API_DOC, /Reader Data Is Private/);
  assert.match(API_DOC, /There is no public content endpoint, public content table, or published snapshot view/);
  assert.doesNotMatch(API_DOC, /public read endpoints/i);
});

test('owner authorization requires pinned uid and active auth session', () => {
  assert.match(MIGRATION, /from auth\.sessions s/);
  assert.match(MIGRATION, /s\.id = session_uuid/);
  assert.match(MIGRATION, /s\.user_id = uid/);
  assert.match(MIGRATION, /pinned_uid <> uid/);
  assert.doesNotMatch(MIGRATION, /raw_user_meta_data/);
});

test('google signup hook is allowlist only with no first-user-wins branch', () => {
  assert.match(MIGRATION, /daily_cs_before_user_created/);
  assert.match(MIGRATION, /owner_allowlist/);
  assert.match(MIGRATION, /lower\(provider\) <> 'google'/);
  assert.doesNotMatch(MIGRATION, /count\(\*\).*= 0/);
});

test('owner rpc is invoker while machine endpoints are tightly scoped definer functions', () => {
  assert.match(MIGRATION, /public\.daily_cs_owner_api[\s\S]*?security invoker/);
  assert.match(MIGRATION, /revoke all on function public\.daily_cs_mail_api\(text, jsonb, text\) from public, anon, authenticated/);
  assert.match(MIGRATION, /grant execute on function public\.daily_cs_mail_api\(text, jsonb, text\) to service_role/);
  assert.match(MIGRATION, /revoke all on function public\.daily_cs_backup_api\(text, jsonb, text\) from public, anon, authenticated/);
});

test('catalog and mail mutations use one transaction-scoped advisory lock', () => {
  assert.match(MIGRATION, /pg_advisory_xact_lock/);
  assert.match(MIGRATION, /public\.daily_cs_owner_api[\s\S]*?take_owner_lock\(\)/);
  assert.match(MIGRATION, /public\.daily_cs_mail_api[\s\S]*?take_owner_lock\(\)/);
});

test('drafts can be incomplete, publish validates full original lesson shape', () => {
  assert.match(API_DOC, /Draft autosave may store incomplete content/);
  assert.match(MIGRATION, /validate_publish_document/);
  assert.match(MIGRATION, /document \? 'followUps'/);
  assert.match(MIGRATION, /document \? 'sources'/);
  assert.match(MIGRATION, /lesson\.publish[\s\S]*?validate_publish_document/);
});

test('markdown raw html check ignores fenced code blocks', () => {
  assert.match(API_DOC, /outside fenced code blocks/);
  assert.match(MIGRATION, /regexp_replace\(coalesce\(document ->> 'markdown'/);
  assert.match(MIGRATION, /```\(\.\|\\n\|\\r\)\*\?```/);
});

test('mail retry creates resend jobs and leaves uncertain originals intact', () => {
  assert.match(API_DOC, /Creates a new `resend` mail job linked to the uncertain original/);
  assert.match(MIGRATION, /mail_kind as enum \('daily', 'test', 'resend'\)/);
  assert.match(MIGRATION, /supersedes_message_id uuid references daily_cs_private\.mail_outbox/);
  assert.match(MIGRATION, /state = 'uncertain'/);
  assert.match(MIGRATION, /'resend'/);
  assert.doesNotMatch(MIGRATION, /set state = 'queued'[\s\S]{0,200}mail\.retryUncertain/);
});

test('backup hash is based on data envelope without timestamps or job heartbeat', () => {
  assert.match(DATA_MIGRATION, /daily_cs_private\.export_with_hash/);
  assert.match(DATA_MIGRATION, /'hash', daily_cs_private\.document_hash\(envelope\)/);
  assert.doesNotMatch(DATA_MIGRATION, /exportedAt|heartbeat|jobHeartbeat/);
});

test('owner api delegates schedule and data modules without final stubs', () => {
  assert.match(MIGRATION, /owner_schedule_api\(text,jsonb\)/);
  assert.match(MIGRATION, /owner_data_api\(text,jsonb\)/);
  assert.doesNotMatch(MIGRATION, /jsonb_build_object\('items', '?\[\]'?::jsonb\)/);
  assert.match(DATA_MIGRATION, /import\.preview/);
  assert.match(DATA_MIGRATION, /import\.commit/);
  assert.match(DATA_MIGRATION, /backup\.restore/);
  assert.match(DATA_MIGRATION, /restore_export_envelope/);
});

test('edge wrappers verify the intended credentials and do not log request data', () => {
  assert.match(OWNER_EDGE, /auth\.getUser\(\)/);
  assert.match(OWNER_EDGE, /Authorization/);
  assert.match(MAIL_EDGE, /X-Daily-CS-Mail-Key/);
  assert.match(BACKUP_EDGE, /X-Daily-CS-Backup-Key/);
  assert.doesNotMatch(`${OWNER_EDGE}\n${MAIL_EDGE}\n${BACKUP_EDGE}`, /console\.(log|warn|error)/);
});

test('mail compact-ledger recovery actions are documented and implemented in the additive migration', () => {
  assert.match(API_DOC, /### `mail\.resumeClaim`[\s\S]*?\{ "message": null, "status": "expired" \}/);
  assert.match(API_DOC, /"legacyStatus": "sent\|sending\|uncertain"/);
  assert.match(API_DOC, /`sending` and `uncertain` mark a non-sent row uncertain/);
  assert.match(PURGE_MIGRATION, /if action = 'mail\.resumeClaim'/);
  assert.match(PURGE_MIGRATION, /if action = 'mail\.reconcileLegacyGuard'/);
  assert.match(PURGE_MIGRATION, /legacy_status not in \('sent', 'sending', 'uncertain'\)/);
  assert.match(MAIL_EDGE, /"mail\.resumeClaim"/);
  assert.match(MAIL_EDGE, /"mail\.reconcileLegacyGuard"/);
});

test('edge wrappers use exact CORS allowlist, shared SDK version, and manual auth boundary', () => {
  for (const source of [OWNER_EDGE, MAIL_EDGE, BACKUP_EDGE]) {
    assert.match(source, /@supabase\/supabase-js@2\.87\.1/);
    assert.match(source, /https:\/\/donggeonha\.github\.io/);
    assert.match(source, /Access-Control-Allow-Origin/);
    assert.match(source, /Access-Control-Allow-Methods", "POST, OPTIONS"/);
    assert.match(source, /Access-Control-Allow-Headers/);
    assert.match(source, /"Vary": "Origin"/);
    assert.match(source, /DAILY_CS_ALLOW_LOCAL_ORIGINS/);
  }
  assert.match(OWNER_EDGE, /authorization, apikey, content-type/);
  assert.match(MAIL_EDGE, /x-daily-cs-mail-key/);
  assert.match(BACKUP_EDGE, /x-daily-cs-backup-key/);
  assert.match(SUPABASE_CONFIG, /\[functions\.owner-api\]\s+verify_jwt = false/);
  assert.match(SUPABASE_CONFIG, /\[functions\.mail-api\]\s+verify_jwt = false/);
  assert.match(SUPABASE_CONFIG, /\[functions\.backup-api\]\s+verify_jwt = false/);
});

test('private bootstrap template contains placeholders only', () => {
  assert.match(BOOTSTRAP, /<OWNER_EMAIL>/);
  assert.match(BOOTSTRAP, /<OWNER_AUTH_UID>/);
  assert.match(BOOTSTRAP, /<MAIL_ENDPOINT_KEY>/);
  assert.match(BOOTSTRAP, /<BACKUP_EXPORT_KEY>/);
  assert.doesNotMatch(BOOTSTRAP, /@gmail\.com|@naver\.com|@daum\.net/);
});
