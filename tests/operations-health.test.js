const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const root = path.resolve(__dirname, "..");

test("backup Edge forwards reports with scoped credentials and rejects other actions", async () => {
  // Given the real Edge source runs against a recorded RPC boundary.
  const { transform } = require("esbuild");
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(root, "supabase/functions/backup-api/index.ts"), "utf8")
    .replace(/^import .*?;\r?\n/, "const createClient = globalThis.createTestClient;\n");
  const bundle = await transform(source, { loader: "ts", format: "cjs" });
  let handler;
  const calls = [];
  vm.runInNewContext(bundle.code, {
    Request, Response, Headers, URL,
    Deno: { serve: callback => { handler = callback; }, env: { get: () => "synthetic-config" } },
    createTestClient: () => ({ rpc: async (name, args) => { calls.push({ name, args }); return { data: { data: { recorded: true } }, error: null }; } })
  });
  const request = action => new Request("https://project.supabase.co/functions/v1/backup-api", {
    method: "POST", headers: { "content-type": "application/json", "X-Daily-CS-Backup-Key": "synthetic-backup-key-with-enough-length" },
    body: JSON.stringify({ action, payload: { runId: "123", status: "failure", errorCode: "workflow_failed" } })
  });
  // When a report and an unauthorized content action are submitted.
  const report = await handler(request("backup.report"));
  const denied = await handler(request("lesson.create"));
  // Then only the report reaches the credential-checked backup RPC.
  assert.equal(report.status, 200);
  assert.equal(denied.status, 400);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "daily_cs_backup_api");
  assert.equal(calls[0].args.action, "backup.report");
});

test("a completed backup reports only validated run and Git metadata", async () => {
  // Given a completed private archive push.
  const { reportBackup } = require("../scripts/report-backup.js");
  const calls = [];
  const client = { request: async (action, payload) => { calls.push({ action, payload }); return { recorded: true }; } };
  const report = { runId: "123456", status: "success", contentHash: "a".repeat(64), commitSha: "b".repeat(40), document: "must not leave this process" };
  // When the workflow records its result.
  await reportBackup(report, client);
  // Then no backup body or arbitrary fields enter the reporting API.
  assert.deepEqual(calls, [{ action: "backup.report", payload: { runId: "123456", status: "success", contentHash: "a".repeat(64), commitSha: "b".repeat(40) } }]);
});

test("failed backup reports use a generic error and need no export body", async () => {
  // Given export or push failed before a backup file was created.
  const { reportBackup } = require("../scripts/report-backup.js");
  let payload;
  // When the workflow records failure.
  await reportBackup({ runId: "123456", status: "failure" }, { request: async (_action, body) => { payload = body; } });
  // Then reporting needs no content, commit or raw exception.
  assert.deepEqual(payload, { runId: "123456", status: "failure", errorCode: "workflow_failed" });
});

test("malformed backup metadata never reaches the reporting API", async () => {
  // Given invalid identities, hashes or statuses at the CLI boundary.
  const { reportBackup } = require("../scripts/report-backup.js");
  for (const report of [
    { runId: "https://invalid", status: "failure" },
    { runId: "123", status: "unknown" },
    { runId: "123", status: "success", contentHash: "invalid", commitSha: "b".repeat(40) }
  ]) {
    // When a result is submitted.
    // Then it fails before creating any API request.
    await assert.rejects(() => reportBackup(report, { request: async () => assert.fail("invalid report sent") }), /Invalid backup report/);
  }
});

test("backup success is reported after Git push and failure reporting is conditional", () => {
  // Given the private archive job writes its backup to Git.
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/private-backup.yml"), "utf8");
  // When the job order is inspected.
  const push = workflow.indexOf("          git push");
  const success = workflow.indexOf("run: node scripts/report-backup.js success");
  const failure = workflow.indexOf("run: node scripts/report-backup.js failure");
  // Then an export alone cannot be called a Git backup success.
  assert.ok(push >= 0 && success > push && failure > success);
  assert.match(workflow.slice(success, failure), /if:.*failure\(\)/);
});

test("health migration confines reports to a private RLS table and owner-gated summaries", () => {
  // Given the applied migration files are immutable.
  const sql = fs.readFileSync(path.join(root, "supabase/migrations/20261017054442_daily_cs_v2_operations_health.sql"), "utf8");
  // When the additive health contract is inspected.
  // Then direct public access and content mutations are absent.
  assert.match(sql, /alter table daily_cs_private\.backup_runs enable row level security/);
  assert.match(sql, /revoke all on.*backup_runs.*from public, anon, authenticated/s);
  assert.match(sql, /scope = 'backup_export'/);
  assert.match(sql, /perform daily_cs_private\.require_active_owner\(\)/);
  assert.match(sql, /pg_get_functiondef/);
  assert.doesNotMatch(sql, /(?:insert into|update|delete from) daily_cs_private\.(?:lessons|settings|day_snapshots)/);
});
