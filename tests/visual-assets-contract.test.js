const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migrations = path.join(__dirname, '../supabase/migrations');
const file = fs.readdirSync(migrations).find(name => name.endsWith('_daily_cs_v2_private_visual_assets.sql'));
const sql = fs.readFileSync(path.join(migrations, file), 'utf8');

test('private visual assets have immutable storage and active owner API gates', () => {
  assert.match(sql, /create table daily_cs_private\.visual_assets/);
  assert.match(sql, /visual_assets enable row level security/);
  assert.match(sql, /revoke all on daily_cs_private\.visual_assets from public, anon, authenticated, service_role/);
  assert.match(sql, /require_active_owner\(\)/);
  assert.match(sql, /before update or delete on daily_cs_private\.visual_assets/);
});

test('visual backup validation precedes asset writes and retains existing legacy functions', () => {
  const restore = sql.split('create function daily_cs_private.restore_export_envelope(')[1];
  assert.ok(restore.indexOf('validate_export_envelope(envelope)') < restore.indexOf('insert into daily_cs_private.visual_assets'));
  assert.match(sql, /restore_export_envelope_before_visuals/);
  assert.match(sql, /inline_image_refs jsonb/);
  assert.doesNotMatch(sql, /update daily_cs_private\.day_snapshots|delete from daily_cs_private\.visual_assets/i);
});
