const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const root = path.resolve(__dirname, "..");

async function loadBackupEdge({ fetchRpc, rpc, decoder = TextDecoder }) {
  const { transform } = require("esbuild");
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(root, "supabase/functions/backup-api/index.ts"), "utf8")
    .replace(/^import .*?;\r?\n/, "const createClient = globalThis.createTestClient;\n");
  const bundle = await transform(source, { loader: "ts", format: "cjs" });
  let handler;
  vm.runInNewContext(bundle.code, {
    Request, Response, Headers, URL, ReadableStream, TextDecoder: decoder,
    Deno: {
      serve: callback => { handler = callback; },
      env: { get: name => ({ SUPABASE_URL: "https://project.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-role" })[name] }
    },
    fetch: fetchRpc,
    createTestClient: () => ({ rpc })
  });
  return handler;
}

function backupRequest(action, payload = {}, token = "synthetic-backup-key-with-enough-length") {
  return new Request("https://project.supabase.co/functions/v1/backup-api", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Daily-CS-Backup-Key": token,
      Origin: "https://donggeonha.github.io"
    },
    body: JSON.stringify({ action, payload })
  });
}

test("backup Edge sends export headers before the remainder of a fragmented snapshot arrives", async () => {
  const hash = "c".repeat(64);
  const prefix = ['{"da', 'ta": {"exp', 'ort": {'];
  const suffix = `"hash":"${hash}","lessons":["한글"]}}}`;
  const encoder = new TextEncoder();
  const restRequested = Promise.withResolvers();
  const restAvailable = Promise.withResolvers();
  let upstreamCall;
  const fetchRpc = async (url, options) => {
    upstreamCall = { url, options };
    return new Response(new ReadableStream({
      async pull(controller) {
        const head = prefix.shift();
        if (head !== undefined) {
          controller.enqueue(encoder.encode(head));
          return;
        }
        restRequested.resolve("still buffering export");
        await restAvailable.promise;
        controller.enqueue(encoder.encode(suffix));
        controller.close();
      }
    }, { highWaterMark: 0 }), { headers: { "Content-Type": "application/json; charset=utf-8" } });
  };
  const handler = await loadBackupEdge({
    fetchRpc,
    // The prior SDK boundary consumes the complete PostgREST body before it returns a result.
    rpc: async () => ({ data: await (await fetchRpc()).json(), error: null })
  });

  const handling = handler(backupRequest("backup.export"));
  const response = await Promise.race([handling, restRequested.promise]);
  restAvailable.resolve();
  assert.ok(response instanceof Response, "Response headers must be available before the export body is complete");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://donggeonha.github.io");
  assert.equal(String(upstreamCall.url), "https://project.supabase.co/rest/v1/rpc/daily_cs_backup_api");
  const headers = new Headers(upstreamCall.options.headers);
  assert.equal(headers.get("apikey"), "synthetic-service-role");
  assert.equal(headers.get("authorization"), "Bearer synthetic-service-role");
  assert.equal(upstreamCall.options.redirect, "error");
  assert.deepEqual(JSON.parse(upstreamCall.options.body), {
    action: "backup.export", payload: {}, token: "synthetic-backup-key-with-enough-length"
  });
  const text = await response.text();
  assert.equal(text, `{"data": {"export": {${suffix}`);
  assert.equal(JSON.parse(text).data.export.hash, hash);
});

test("backup Edge inspects only a bounded prefix of a large chunk and relays cancellation", async () => {
  const encoder = new TextEncoder();
  const firstChunk = encoder.encode(`{"data":{"export":{"image":"${"a".repeat(2 * 1024 * 1024)}`);
  const decodedLengths = [];
  class MeasuredDecoder extends TextDecoder {
    decode(bytes, options) {
      decodedLengths.push(bytes.byteLength);
      return super.decode(bytes, options);
    }
  }
  let reads = 0;
  let canceledWith;
  const upstream = new ReadableStream({
    pull(controller) {
      reads += 1;
      controller.enqueue(firstChunk);
    },
    cancel(reason) { canceledWith = reason; }
  }, { highWaterMark: 0 });
  const handler = await loadBackupEdge({
    fetchRpc: async () => new Response(upstream, { headers: { "Content-Type": "application/json" } }),
    decoder: MeasuredDecoder
  });

  const response = await handler(backupRequest("backup.export"));
  const reader = response.body.getReader();
  const result = await reader.read();
  await reader.cancel("test client canceled");

  assert.ok(result.value === firstChunk, "the first upstream chunk must be forwarded without copying it");
  assert.deepEqual(decodedLengths, [64]);
  assert.equal(reads, 1);
  assert.equal(canceledWith, "test client canceled");
});

test("backup Edge keeps export credential denials and upstream errors private", async () => {
  const responses = [
    [200, '{"error":{"code":"forbidden","message":"private upstream detail"}}', 403, "forbidden"],
    [500, '{"message":"private upstream detail"}', 500, "internal_error"],
    [200, '{"data":{"unrecognized":"private upstream detail"}}', 500, "internal_error"],
    [200, '{"data":{"export":null}}', 500, "internal_error"]
  ];
  const handler = await loadBackupEdge({
    fetchRpc: async () => {
      const [status, body] = responses[0];
      return new Response(body, { status, headers: { "Content-Type": "application/json" } });
    }
  });

  const shortToken = await handler(backupRequest("backup.export", {}, "invalid"));
  assert.equal(shortToken.status, 403);
  while (responses.length > 0) {
    const [, , expectedStatus, expectedCode] = responses[0];
    const result = await handler(backupRequest("backup.export"));
    responses.shift();
    assert.equal(result.status, expectedStatus);
    const message = expectedCode === "forbidden" ? "valid backup credential required" : "backup action failed";
    assert.deepEqual(await result.json(), { error: { code: expectedCode, message } });
  }
});

test("backup Edge propagates a transport failure during a streamed export", async () => {
  const encoder = new TextEncoder();
  let prefixSent = false;
  const upstream = new ReadableStream({
    pull(controller) {
      if (prefixSent) throw new Error("synthetic upstream disconnect");
      controller.enqueue(encoder.encode('{"data":{"export":{'));
      prefixSent = true;
    }
  }, { highWaterMark: 0 });
  const handler = await loadBackupEdge({
    fetchRpc: async () => new Response(upstream, { headers: { "Content-Type": "application/json" } })
  });

  const result = await handler(backupRequest("backup.export"));

  assert.equal(result.status, 200);
  await assert.rejects(result.text(), /synthetic upstream disconnect/);
});

test("backup Edge forwards reports with scoped credentials and rejects other actions", async () => {
  // Given the real Edge source runs against a recorded RPC boundary.
  const calls = [];
  const handler = await loadBackupEdge({
    rpc: async (name, args) => {
      calls.push({ name, args });
      return { data: { data: { recorded: true } }, error: null };
    }
  });
  // When a report and an unauthorized content action are submitted.
  const report = await handler(backupRequest("backup.report", { runId: "123", status: "failure", errorCode: "workflow_failed" }));
  const denied = await handler(backupRequest("lesson.create"));
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
