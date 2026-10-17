const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261017135825_daily_cs_v2_deferred_course_restart.sql'), 'utf8');

test('deferred restart is an optional future event with guarded scheduler and restore patches', () => {
  // Given the additive migration, when inspecting its persisted event contract,
  // then no current calendar or transport state is reset during deployment.
  assert.match(migration, /add column pending_restart_date date/);
  assert.match(migration, /pending_restart_date > last_frozen_date/);
  assert.match(migration, /if d=s\.pending_restart_date then/);
  assert.match(migration, /if persist_days then[\s\S]*delete from daily_cs_private\.schedule_queue where cycle=s\.cycle and consumed_date is null/);
  assert.match(migration, /pending_restart_date=restored_state\.pending_restart_date/);
  assert.match(migration, /occurrences is distinct from patch\.expected/);
  assert.doesNotMatch(migration, /2026-10-19|update daily_cs_private\.(?:day_snapshots|mail_outbox|settings)|schedule_overrides|apps-script/i);
});

test('restart integration proves previews, the 09KST boundary, idempotency and backup compatibility', () => {
  // Given the real PostgreSQL test, when reviewing its behavioral scenarios,
  // then both calendar/mail sequencing and durable metadata recovery are exercised.
  const sql = fs.readFileSync(path.join(__dirname, 'deferred-course-restart.sql'), 'utf8');
  for (const evidence of ['Sunday034, Monday001, Tuesday002', 'Monday must not restart before09KST',
    'Monday09KST web and mail', 'repeated polling', 'legacy backup', 'past restart metadata',
    'noncanonical restart metadata', 'all delivery/claim history']) assert.ok(sql.includes(evidence), evidence);
  assert.match(sql, /rollback;\s*$/);
});
