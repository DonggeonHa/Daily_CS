const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const crypto = require("node:crypto");
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
    Uint8Array,
    atob,
    btoa,
    crypto: crypto.webcrypto,
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

function visualCandidate() {
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
  const assetId = crypto.createHash('sha256').update(bytes).digest('hex');
  const ref = { cid: `visual-${assetId}`, assetId, mimeType: 'image/png' };
  const visual = {
    version: 1, id: 'diagram', title: 'Synthetic diagram', description: 'Teaching frame', alt: 'A single node',
    emailAssetId: assetId, emailScenarioId: 'normal', emailStep: 0,
    scenarios: [{ id: 'normal', label: 'Normal', steps: [{ title: 'Start', description: 'One node', nodes: [{ id: 'a', label: 'A', detail: '', tone: 'neutral' }], edges: [], metrics: [] }] }],
  };
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', kind: 'daily', date: '2026-09-15',
    snapshotId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', contentHash: 'c'.repeat(64),
    lesson: { id: 'lesson-007', title: 'Synthetic diagram lesson', documentKind: 'markdown', document: { markdown: '# Synthetic', visuals: [visual] } },
    inlineImageRefs: [ref],
    inlineImages: [{ ...ref, base64: bytes.toString('base64') }],
    html: `<img src="cid:${ref.cid}">`,
  };
}

test('Given snapshot visuals When materialized Then exact asset manifest and snapshot identity are supplied', async () => {
  // Given
  const candidate = visualCandidate();
  delete candidate.inlineImages;
  let materialized;
  const { handler } = await loadMailHandler(async ({ action, payload }) => {
    if (action === 'mail.prepareDue') return { data: { candidate } };
    if (action === 'mail.materialize') { materialized = payload; return { data: { state: 'queued' } }; }
    return { data: { message: null } };
  });
  // When
  const response = await handler(post('mail.claimDue'));
  // Then
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(materialized.inlineImageRefs)), candidate.inlineImageRefs);
  assert.equal(materialized.snapshotId, candidate.snapshotId);
});

test('Given mismatched snapshot asset refs When materializing Then no materialize or claim RPC occurs', async () => {
  // Given
  const candidate = visualCandidate();
  candidate.inlineImageRefs = [];
  const calls = [];
  const { handler } = await loadMailHandler(async ({ action }) => { calls.push(action); return { data: { candidate } }; });
  // When
  const response = await handler(post('mail.claimDue'));
  // Then
  assert.equal(response.status, 500);
  assert.deepEqual(calls, ['mail.prepareDue']);
});

for (const action of ['mail.claimDue', 'mail.resumeClaim']) {
  for (const corrupt of ['missing', 'hash', 'manifest', 'snapshot', 'signature', 'duplicate', 'base64']) {
    test(`Given ${corrupt} snapshot PNG When ${action} responds Then invalid attachment is withheld`, async () => {
      // Given
      const message = visualCandidate();
      if (corrupt === 'missing') message.inlineImages = [];
      if (corrupt === 'hash') { const bytes = Buffer.from(message.inlineImages[0].base64, 'base64'); bytes[40] ^= 1; message.inlineImages[0].base64 = bytes.toString('base64'); }
      if (corrupt === 'manifest') message.inlineImageRefs = [];
      if (corrupt === 'snapshot') delete message.contentHash;
      if (corrupt === 'signature') {
        const bytes = Buffer.from(message.inlineImages[0].base64, 'base64'); bytes[0] = 0;
        const assetId = crypto.createHash('sha256').update(bytes).digest('hex');
        message.lesson.document.visuals[0].emailAssetId = assetId;
        message.inlineImageRefs[0] = { cid: `visual-${assetId}`, assetId, mimeType: 'image/png' };
        message.inlineImages[0] = { ...message.inlineImageRefs[0], base64: bytes.toString('base64') };
        message.html = `<img src="cid:visual-${assetId}">`;
      }
      if (corrupt === 'duplicate') message.inlineImages.push({ ...message.inlineImages[0] });
      if (corrupt === 'base64') message.inlineImages[0].base64 += '\n';
      const { handler } = await loadMailHandler(async ({ action: rpcAction }) => {
        if (rpcAction === 'mail.prepareDue') return { data: { candidate: null } };
        return { data: { message } };
      });
      // When
      const response = await handler(post(action));
      // Then
      assert.equal(response.status, 500);
      const body = await response.json();
      assert.equal(body.error.code, 'internal_error');
      assert.equal(body.data, undefined);
    });
  }
}

test('Given complete snapshot PNG When resumeClaim responds Then verified inline bytes remain available', async () => {
  // Given
  const message = visualCandidate();
  const { handler } = await loadMailHandler(async () => ({ data: { message } }));
  // When
  const response = await handler(post('mail.resumeClaim'));
  // Then
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.message.inlineImages, message.inlineImages);
});

test('Given an old lesson discussing CID text When resumed Then prose remains deliverable without images', async () => {
  // Given
  const message = { id: 'legacy-message', html: '<p>Use <code>cid:diagram</code> for inline mail.</p>' };
  const { handler } = await loadMailHandler(async () => ({ data: { message } }));
  // When
  const response = await handler(post('mail.resumeClaim'));
  // Then
  assert.equal(response.status, 200);
});
