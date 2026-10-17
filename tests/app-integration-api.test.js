const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { build } = require("esbuild");

async function importBrowserModule(entry) {
  const outfile = path.join(os.tmpdir(), `daily-cs-${path.basename(entry, ".js")}-${Date.now()}-${Math.random()}.mjs`);
  await build({
    entryPoints: [path.join(__dirname, "..", "web", "assets", entry)],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    legalComments: "none"
  });
  return import(`file://${outfile.replace(/\\/g, "/")}`);
}

test("owner api posts dotted action envelopes with bearer auth", async () => {
  const { ACTIONS, createOwnerApi } = await importBrowserModule("api.js");
  const requests = [];
  const api = createOwnerApi({
    origin: "https://donggeonha.github.io",
    getAccessToken: async () => "session-token",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { ok: true } })
      };
    }
  });

  const data = await api.action(ACTIONS.lessonSaveDraft, { id: "lesson-id" });

  assert.deepEqual(data, { ok: true });
  assert.equal(requests[0].url, "https://donggeonha.github.io/functions/v1/owner-api");
  assert.equal(requests[0].init.headers.authorization, "Bearer session-token");
  assert.equal(requests[0].init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    action: "lesson.saveDraft",
    payload: { id: "lesson-id" }
  });
});

test("owner api turns owner-api error envelopes into typed errors", async () => {
  const { ACTIONS, DailyCsApiError, createOwnerApi } = await importBrowserModule("api.js");
  const api = createOwnerApi({
    origin: "https://donggeonha.github.io",
    getAccessToken: async () => "session-token",
    fetchImpl: async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: "conflict", message: "lesson revision changed" } })
    })
  });

  await assert.rejects(
    () => api.action(ACTIONS.lessonPublish, {}),
    (error) => error instanceof DailyCsApiError && error.code === "conflict" && error.status === 409
  );
});

test("frontend source is wired to production actions without app-owned content storage", async () => {
  const source = await fs.readFile(path.join(__dirname, "..", "web", "assets", "app.js"), "utf8");

  for (const oldAction of [
    "listLessons",
    "getLesson",
    "upsertDraft",
    "publishLesson",
    "restoreLesson",
    "trashLesson",
    "purgeLesson",
    "getHistory",
    "updateSchedule",
    "getSchedule",
    "getMailStatus",
    "backupNow"
  ]) {
    assert.doesNotMatch(source, new RegExp(`owner\\([^\\n]+${oldAction}`));
  }
  assert.doesNotMatch(source, /localStorage/);
  assert.doesNotMatch(source, /MOCK_RECORDS|MOCK_SCHEDULE|MOCK_MAIL|content\/lessons/);
  assert.match(source, /ACTIONS\.readerToday/);
  assert.match(source, /ACTIONS\.readerSnapshot/);
  assert.match(source, /ACTIONS\.lessonSaveDraft/);
  assert.match(source, /ACTIONS\.mailRetryUncertain/);
  assert.match(source, /origin: config\.supabaseUrl/);
});

test("lesson normalizer preserves structured documents for shared renderlib", async () => {
  const { documentForRender } = await importBrowserModule("api.js");
  const lesson = documentForRender({
    id: "uuid",
    legacy_id: 7,
    title: "운영체제 질문",
    category: "os-architecture",
    document_kind: "structured",
    row_revision: 3,
    draft_document: {
      id: "007",
      summary: "요약",
      keywords: ["process"],
      track: "common",
      level: "foundation",
      question: "프로세스란?",
      answer: "실행 중인 프로그램",
      explanation: ["주소 공간을 가진다."],
      example: { description: "예", code: "ps" },
      pitfalls: [],
      followUps: [],
      quiz: { question: "", choices: [], answerIndex: 0, explanation: "" },
      sources: []
    }
  });

  assert.equal(lesson.id, "007");
  assert.equal(lesson.title, "운영체제 질문");
  assert.deepEqual(lesson.explanation, ["주소 공간을 가진다."]);
});

test("owner api supports full owner-console scenario action sequence", async () => {
  const { ACTIONS, createOwnerApi, documentForRender, normalizeRevision } = await importBrowserModule("api.js");
  const calls = [];
  const fixtures = {
    [ACTIONS.readerToday]: { day: { date: "2026-09-15", lessonId: "lesson-1", title: "오늘 글", category: "database", documentKind: "structured", document: { id: "001", title: "오늘 글", category: "database", track: "common", level: "foundation", summary: "요약", question: "Q", answer: "A", explanation: [], pitfalls: [], sources: [] }, revisionNumber: 2 } },
    [ACTIONS.readerHistory]: { days: [] },
    [ACTIONS.readerSnapshot]: { day: { date: "2026-09-15", snapshotId: "snapshot-1", lessonId: "lesson-1", title: "메일 스냅샷", category: "database", documentKind: "structured", document: { id: "001", title: "메일 스냅샷", category: "database", track: "common", level: "foundation", summary: "immutable", question: "Q", answer: "A", explanation: [], pitfalls: [], sources: [] }, revisionNumber: 2 } },
    [ACTIONS.readerSearch]: { items: [] },
    [ACTIONS.lessonSaveDraft]: { lesson: { id: "lesson-1", rowRevision: 4, documentKind: "structured", draftDocument: { title: "초안" } } },
    [ACTIONS.lessonPublish]: { lesson: { id: "lesson-1", rowRevision: 5, state: "published" } },
    [ACTIONS.lessonUnpublish]: { lesson: { id: "lesson-1", rowRevision: 6, state: "draft" } },
    [ACTIONS.lessonMoveToTrash]: { lesson: { id: "lesson-1", rowRevision: 7, state: "trash" } },
    [ACTIONS.lessonRestoreTrash]: { lesson: { id: "lesson-1", rowRevision: 8, state: "draft" } },
    [ACTIONS.lessonDuplicate]: { lesson: { id: "lesson-copy", rowRevision: 1, state: "draft" } },
    [ACTIONS.revisionGet]: { revision: { id: "revision-1", lessonId: "lesson-1", revisionNumber: 3, documentKind: "structured", document: { title: "old" } } },
    [ACTIONS.lessonRestoreRevision]: { lesson: { id: "lesson-1", rowRevision: 9 } },
    [ACTIONS.scheduleSetOverride]: { scheduleRevision: 11 },
    [ACTIONS.scheduleRebuildFuture]: { scheduleRevision: 12 },
    [ACTIONS.mailEnqueueTest]: { queued: true },
    [ACTIONS.mailRetryUncertain]: { queued: true },
    [ACTIONS.importPreview]: { hash: "sha256-preview", counts: { lessons: 1 } },
    [ACTIONS.importCommit]: { committed: true },
    [ACTIONS.exportCreate]: { hash: "sha256-export", lessons: [] },
    [ACTIONS.backupRestore]: { restored: true }
  };
  const api = createOwnerApi({
    origin: "https://gdraufrjlmzhnegrrjhj.supabase.co",
    getAccessToken: async () => "owner-token",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      assert.ok(fixtures[body.action], "unexpected action " + body.action);
      return { ok: true, status: 200, json: async () => ({ data: fixtures[body.action] }) };
    }
  });

  await api.action(ACTIONS.readerToday, { date: "2026-09-15" });
  await api.action(ACTIONS.readerHistory, { from: "2026-09-01", to: "2026-09-15" });
  await api.action(ACTIONS.readerSnapshot, { snapshotId: "snapshot-1" });
  await api.action(ACTIONS.readerSearch, { query: "인덱스", limit: 50 });
  await api.action(ACTIONS.lessonSaveDraft, { id: "lesson-1", expectedRevision: 3, document: { title: "초안" } });
  await api.action(ACTIONS.lessonPublish, { id: "lesson-1", expectedRevision: 4 });
  await api.action(ACTIONS.lessonUnpublish, { id: "lesson-1", expectedRevision: 5 });
  await api.action(ACTIONS.lessonMoveToTrash, { id: "lesson-1", expectedRevision: 6 });
  await api.action(ACTIONS.lessonRestoreTrash, { id: "lesson-1", expectedRevision: 7 });
  await api.action(ACTIONS.lessonDuplicate, { id: "lesson-1", title: "Copy" });
  const revisionData = await api.action(ACTIONS.revisionGet, { revisionId: "revision-1" });
  await api.action(ACTIONS.lessonRestoreRevision, { id: "lesson-1", revisionId: "revision-1", expectedRevision: 8 });
  await api.action(ACTIONS.scheduleSetOverride, { date: "2026-09-16", lessonId: "lesson-1", mode: "lesson", expectedScheduleRevision: 10 });
  await api.action(ACTIONS.scheduleRebuildFuture, { from: "2026-09-16", expectedScheduleRevision: 11 });
  await api.action(ACTIONS.mailEnqueueTest, { date: "2026-09-15", commandId: "cmd-test" });
  await api.action(ACTIONS.mailRetryUncertain, { messageId: "mail-1", expectedState: "uncertain", commandId: "cmd-resend", mailboxChecked: true });
  await api.action(ACTIONS.importPreview, { lessons: [{ id: "001" }] });
  await api.action(ACTIONS.importCommit, { expectedExportHash: "sha256-preview", lessons: [{ id: "001" }] });
  await api.action(ACTIONS.exportCreate, { includeTrash: true });
  await api.action(ACTIONS.backupRestore, { expectedExportHash: "sha256-export", export: { lessons: [] } });

  assert.deepEqual(calls.map((call) => call.action), [
    "reader.today", "reader.history", "reader.snapshot", "reader.search", "lesson.saveDraft", "lesson.publish", "lesson.unpublish",
    "lesson.moveToTrash", "lesson.restoreTrash", "lesson.duplicate", "revision.get", "lesson.restoreRevision",
    "schedule.setOverride", "schedule.rebuildFuture", "mail.enqueueTest", "mail.retryUncertain", "import.preview",
    "import.commit", "export.create", "backup.restore"
  ]);
  assert.equal(calls.find((call) => call.action === "mail.retryUncertain").payload.mailboxChecked, true);
  assert.equal(calls.find((call) => call.action === "import.commit").payload.expectedExportHash, "sha256-preview");
  const revision = normalizeRevision(revisionData.revision);
  assert.equal(documentForRender({ id: revision.lessonId, title: revision.title, category: revision.category, documentKind: revision.documentKind, draftDocument: revision.document }).id, "lesson-1");
});

test("rendered interactive controls are bound or intentionally delegated", async () => {
  const appSource = await fs.readFile(path.join(__dirname, "..", "web", "assets", "app.js"), "utf8");
  const html = await fs.readFile(path.join(__dirname, "..", "web", "index.html"), "utf8");
  const interactiveIds = [...html.matchAll(/<(?:button|form|input|select|textarea)\b[^>]*\bid="([^"]+)"/g)].map((match) => match[1]);
  const intentionallyDelegated = new Set([
    "login-form", "reader-search-form", "editor-form",
    "editor-draft-revision", "editor-published-revision", "editor-state"
  ]);
  const missing = interactiveIds.filter((id) => !intentionallyDelegated.has(id) && !appSource.includes(`"${id}"`) && !appSource.includes(`'${id}'`));

  assert.deepEqual(missing, []);
  for (const requiredBinding of [
    "ACTIONS.lessonPublish", "ACTIONS.lessonUnpublish", "ACTIONS.lessonDuplicate", "ACTIONS.lessonMoveToTrash",
    "ACTIONS.lessonRestoreTrash", "ACTIONS.lessonPurge", "ACTIONS.revisionGet", "ACTIONS.lessonRestoreRevision",
    "ACTIONS.scheduleSetOverride", "ACTIONS.scheduleRebuildFuture", "ACTIONS.importPreview", "ACTIONS.importCommit",
    "ACTIONS.backupRestore", "ACTIONS.exportCreate", "ACTIONS.mailEnqueueTest", "ACTIONS.mailRetryUncertain", "ACTIONS.readerSnapshot"
  ]) {
    assert.match(appSource, new RegExp(requiredBinding.replace(/[.]/g, "\\.")));
  }
  assert.doesNotMatch(appSource, /loginEmail|login_hint|owner@example\.com/);
  assert.match(appSource, /signInWithGoogle\(state\.auth, redirectTo\)/);
  assert.match(appSource, /nodes\.mockLogin\) nodes\.mockLogin\.hidden = true/);
});

test("reader normalization ignores admin draft fields", async () => {
  const appSource = await fs.readFile(path.join(__dirname, "..", "web", "assets", "app.js"), "utf8");
  const readerBlock = appSource.slice(appSource.indexOf("function normalizeReaderDay"), appSource.indexOf("function revisionToRenderable"));

  assert.match(readerBlock, /readerLessonFromSnapshot/);
  assert.doesNotMatch(readerBlock, /raw\.draft_document|raw\.draftDocument|raw\.lesson\?\.draft_document|raw\.lesson\?\.draftDocument/);
  assert.match(appSource, /ACTIONS\.readerToday/);
  assert.match(appSource, /ACTIONS\.readerHistory/);
  assert.match(appSource, /ACTIONS\.readerSnapshot/);
  assert.match(appSource, /ACTIONS\.readerSearch/);
});





