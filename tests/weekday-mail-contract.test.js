const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261017134353_daily_cs_v2_weekday_regular_mail.sql'), 'utf8');

test('regular mail weekday policy stays private and depends on the scheduled date', () => {
  // Given the additive migration, when inspecting its shared weekday predicate,
  // then it uses ISO weekdays on a date with no session timezone dependency.
  assert.match(migration, /function daily_cs_private\.is_mail_weekday\(scheduled_day date\)/);
  assert.match(migration, /immutable strict parallel safe/);
  assert.match(migration, /extract\(isodow from scheduled_day\) between 1 and 5/);
  assert.match(migration, /revoke all on function daily_cs_private\.is_mail_weekday\(date\)[\s\S]*from public, anon, authenticated, service_role/);
});

test('migration validates every existing branch before replacing regular mail guards', () => {
  // Given the currently applied functions, when patching their known guards,
  // then unknown drift aborts the migration instead of silently missing a path.
  assert.match(migration, /pg_catalog\.pg_get_functiondef/);
  assert.match(migration, /occurrences is distinct from patch\.expected/);
  for (const date of ['d.snapshot_date', 'req.scheduled_date', 'c.scheduled_date', 'message_row.scheduled_date', 'scheduled_date']) {
    assert.ok(migration.includes(`daily_cs_private.is_mail_weekday(${date})`), date);
  }
  assert.match(migration, /message_row\.scheduled_date[\s\S]*?,\s*2\)/);
  assert.doesNotMatch(migration, /update daily_cs_private\.(?:day_snapshots|mail_outbox)|delete from daily_cs_private|alter.*trigger|freeze_schedule_internal\(\)/i);
});

test('database regression exercises all transport gates while keeping weekend manual jobs and ACK recovery', () => {
  // Given the PostgreSQL regression, when reviewing its observable scenarios,
  // then every production mail gate and the preserved recovery path are exercised.
  const sql = fs.readFileSync(path.join(__dirname, 'weekday-mail.sql'), 'utf8');
  assert.match(sql, /^--[^\n]*\nbegin;/);
  assert.match(sql, /rollback;\s*$/);
  for (const action of ['prepareDue', 'materialize', 'claimDue', 'resumeClaim', 'beginSending', 'ackSent']) {
    assert.ok(sql.includes(`'mail.${action}'`), action);
  }
  assert.match(sql, /array\['test','resend'\]/);
  assert.match(sql, /existing snapshot history changed/);
  assert.match(sql, /Monday must not claim weekend backlog/);
});
