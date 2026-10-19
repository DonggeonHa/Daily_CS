const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('PostgreSQL visual assets, owner sessions, atomic restore and mail manifests', {
  skip: process.platform === 'win32' && process.env.RUN_DOCKER_SQL_TESTS !== '1'
    ? 'Windows engine is unavailable; run on Linux CI or the rollback SQL harness' : false,
}, () => {
  const name = `daily-cs-visual-${process.pid}-${Date.now()}`;
  const root = path.resolve(__dirname, '..');
  const docker = (args, input) => execFileSync('docker', args, {
    cwd: root, encoding: 'utf8', input, maxBuffer: 8 * 1024 * 1024,
  });
  const sql = input => docker(['exec', '-i', name, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], input);
  docker(['run', '-d', '--name', name, '-e', 'POSTGRES_PASSWORD=postgres', 'postgres:17-alpine']);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
        ready = true;
        break;
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
      }
    }
    assert.equal(ready, true, 'Postgres TCP listener did not become ready');
    sql(`create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create schema auth;
      create table auth.users(id uuid primary key);
      create table auth.sessions(id uuid primary key,user_id uuid not null,not_after timestamptz);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      create function auth.jwt() returns jsonb language sql stable as $$
        select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;`);
    const dir = path.join(root, 'supabase/migrations');
    for (const file of fs.readdirSync(dir).filter(file => file.endsWith('.sql')).sort()) {
      sql(fs.readFileSync(path.join(dir, file), 'utf8'));
    }
    const regression = fs.readFileSync(path.join(__dirname, 'visual-assets.sql'), 'utf8')
      .replace('do $test$', `${fs.readFileSync(path.join(__dirname, 'visual-text.sql'), 'utf8')}\ndo $test$`);
    assert.match(sql(regression), /visual asset regressions passed/);
    assert.match(sql("select count(*)=0 from daily_cs_private.visual_assets;"), /t/);
  } finally {
    docker(['rm', '-f', name]);
  }
});
