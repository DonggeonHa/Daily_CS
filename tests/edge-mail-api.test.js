const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { build } = require("esbuild");
const { buildSharedRender } = require("../scripts/build-shared-render.js");

const rootDir = path.resolve(__dirname, "..");
const mailApiPath = path.join(rootDir, "supabase", "functions", "mail-api", "index.ts");

async function loadMailHandler(rpcHandler) {
  let servedHandler = null;
  const clients = [];
  const bundle = await build({
    entryPoints: [mailApiPath],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    target: ["es2022"],
    legalComments: "none",
    plugins: [{
      name: "supabase-stub",
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /^https:\/\/esm\.sh\/@supabase\/supabase-js@2\.87\.1$/ }, () => ({
          path: "supabase-js",
          namespace: "supabase-stub",
        }));
        pluginBuild.onLoad({ filter: /.*/, namespace: "supabase-stub" }, () => ({
          contents: "export function createClient(url, key, options) { return globalThis.__dailyCsCreateClient(url, key, options); }",
          loader: "js",
        }));
      },
    }],
  });

  const context = {
    Buffer,
    Headers,
    Request,
    Response,
    URL,
    console,
    module: { exports: {} },
    exports: {},
    globalThis: null,
    Deno: {
      env: {
        get(name) {
          if (name === "SUPABASE_URL") return "https://project.supabase.co";
          if (name === "SUPABASE_SERVICE_ROLE_KEY") return "service-role-key";
          if (name === "DAILY_CS_ALLOW_LOCAL_ORIGINS") return "true";
          return undefined;
        },
      },
      serve(handler) {
        servedHandler = handler;
      },
    },
    __dailyCsCreateClient(url, key, options) {
      clients.push({ url, key, options });
      return {
        async rpc(name, args) {
          assert.equal(name, "daily_cs_mail_api");
          return { data: await rpcHandler(args), error: null };
        },
      };
    },
  };
  context.globalThis = context;
  vm.runInNewContext(bundle.outputFiles[0].text, context, { filename: mailApiPath });
  assert.equal(typeof servedHandler, "function");
  return { clients, handler: servedHandler };
}

function post(action, payload = {}) {
  return new Request("https://project.supabase.co/functions/v1/mail-api", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "https://donggeonha.github.io",
      "X-Daily-CS-Mail-Key": "synthetic-mail-key-with-enough-length",
    },
    body: JSON.stringify({ action, payload }),
  });
}

test("Given mail Edge handler When claimDue has a render candidate Then it materializes with shared-rendered full content before claiming", async () => {
  await buildSharedRender();
  const rpcCalls = [];
  const candidate = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    kind: "daily",
    date: "2026-09-15",
    snapshotId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    contentHash: "hash-for-immutable-snapshot",
    lesson: {
      id: "lesson-007",
      legacyId: 7,
      title: "Edge render candidate",
      category: "database",
      documentKind: "markdown",
      document: { markdown: "# Full mail body\n\nRenderer should include this **content**." },
    },
  };
  const { clients, handler } = await loadMailHandler(async (args) => {
    rpcCalls.push(args);
    if (args.action === "mail.prepareDue") return { data: { candidate } };
    if (args.action === "mail.materialize") {
      assert.equal(args.payload.candidateId, candidate.id);
      assert.equal(args.payload.contentHash, candidate.contentHash);
      assert.match(args.payload.subject, /Edge render candidate/);
      assert.match(args.payload.text, /Renderer should include this content/);
      assert.match(args.payload.html, /Renderer should include this <strong>content<\/strong>/);
      assert.match(args.payload.text, /웹에서 보기: https:\/\/donggeonha\.github\.io\/Daily_CS\/\?snapshot=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/);
      assert.match(args.payload.html, /https:\/\/donggeonha\.github\.io\/Daily_CS\/\?snapshot=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/);
      return { data: { state: "queued", messageId: candidate.id } };
    }
    if (args.action === "mail.claimDue") {
      return { data: { message: { id: candidate.id, kind: "daily", claimToken: "claim-token" } } };
    }
    throw new Error(`unexpected action ${args.action}`);
  });

  const response = await handler(post("mail.claimDue", { workerId: "edge-test" }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.message.id, candidate.id);
  assert.deepEqual(rpcCalls.map((call) => call.action), ["mail.prepareDue", "mail.materialize", "mail.claimDue"]);
  assert.equal(clients[0].url, "https://project.supabase.co");
  assert.equal(clients[0].key, "service-role-key");
  assert.equal(clients[0].options.auth.persistSession, false);
});

test("Given mail Edge handler When action is not allowlisted Then no RPC client is created", async () => {
  const { clients, handler } = await loadMailHandler(async () => {
    throw new Error("RPC should not be called");
  });

  const response = await handler(post("lesson.list"));
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error.code, "bad_request");
  assert.equal(clients.length, 0);
});

test("Given mail Edge handler When resumeClaim is called Then it is forwarded without preparing a new message", async () => {
  const rpcCalls = [];
  const { handler } = await loadMailHandler(async (args) => {
    rpcCalls.push(args);
    assert.equal(args.action, "mail.resumeClaim");
    return { data: { message: { id: args.payload.messageId, state: "claimed" } } };
  });

  const response = await handler(post("mail.resumeClaim", {
    messageId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    claimToken: "claim-token",
  }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.message.state, "claimed");
  assert.deepEqual(rpcCalls.map((call) => call.action), ["mail.resumeClaim"]);
}
);
