const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const { build } = require("esbuild");
const { chromium } = require("playwright");
const { createPreviewServer } = require("../scripts/preview-server.js");

const root = path.resolve(__dirname, "..");
const evidence = path.resolve(root, "../v2-evidence/oct17-admin");
const phase = process.env.ADMIN_UI_PHASE || "green";
const lessons = Array.from({ length: 365 }, (_, index) => ({
  id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  title: `합성 학습글 ${index + 1}`, legacyId: index + 1,
  state: index === 0 ? "draft" : "published", revision: 1,
  category: index % 2 ? "database" : "network",
  level: index % 2 ? "foundation" : "advanced",
  summary: `합성 요약 ${index + 1}`, keywords: [`keyword-${index + 1}`]
}));
const settings = { ownerUid: "synthetic-private-uid", startDate: "2026-09-15", sendTime: "09:35", timezone: "Asia/Seoul", revision: 2, scheduleRevision: 3, mailPaused: false };
const today = { date: "2026-10-17", status: "frozen", title: "오늘 합성 글", lessonId: lessons[1].id, document: { answer: "PRIVATE_BODY_SENTINEL" } };
const tomorrow = { date: "2026-10-18", status: "scheduled", title: "내일 합성 글", lessonId: lessons[2].id };
let browser, server, origin, appBundle;

test.before(async () => {
  await fs.mkdir(evidence, { recursive: true });
  const source = await fs.readFile(path.join(root, "web/assets/app.js"), "utf8");
  const bundled = await build({
    stdin: { contents: source, resolveDir: path.join(root, "web/assets"), loader: "js" },
    bundle: true, format: "esm", write: false,
    plugins: [{ name: "synthetic-local-auth", setup(builder) {
      builder.onResolve({ filter: /^\.\/auth\.js$/ }, () => ({ path: "auth", namespace: "test" }));
      builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: `
        export const RETURN_URL_KEY = 'synthetic-return';
        export const createAuthClient = () => ({});
        export const getVerifiedSession = async () => ({ access_token: 'synthetic-local-token', user: { email: 'synthetic@example.test' } });
        export const safeReturnUrl = value => value;
        export const signInWithGoogle = async () => ({});
        export const signOut = async () => {};
        export const startSessionRefresh = () => () => {};
      ` }));
    } }]
  });
  appBundle = bundled.outputFiles[0].text;
  server = createPreviewServer({ root: path.join(root, "web") });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});
test.after(async () => {
  await browser?.close();
  await new Promise(resolve => server?.close(resolve));
});

async function openApp(t) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce" });
  t.after(() => page.close());
  const requests = [];
  await page.route("**/assets/app.js", route => route.fulfill({ contentType: "text/javascript", body: appBundle }));
  await page.route("**/assets/config.js", route => route.fulfill({ contentType: "text/javascript", body: `window.DAILY_CS_CONFIG = { supabaseUrl: '${origin}', basePath: '/Daily_CS/' };` }));
  await page.route("**/functions/v1/owner-api", async route => {
    const { action, payload } = route.request().postDataJSON();
    requests.push({ action, payload });
    const responses = {
      "dashboard.get": { settings, counts: { draft: 1, published: 364, trash: 0, queuedMail: 2, uncertainMail: 1 }, today, tomorrow },
      "lesson.list": { items: lessons },
      "settings.get": settings,
      "schedule.get": { days: [today, tomorrow], scheduleRevision: 3 },
      "mail.status": { items: [] },
      "reader.history": { days: [] },
      "reader.today": { day: { status: "empty" } },
      "settings.update": { ...settings, sendTime: payload.sendTime },
      "schedule.setOverride": { scheduleRevision: 4 },
      "lesson.get": { lesson: { ...lessons.find(item => item.id === payload.id), draftDocument: { level: lessons.find(item => item.id === payload.id)?.level } }, revisions: [] }
    };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: responses[action] ?? {} }) });
  });
  await page.goto(`${origin}/Daily_CS/`);
  await page.locator("#admin-list .lesson-card").last().waitFor({ state: "attached" });
  return { page, requests };
}

test("extended document IDs, order and week remain valid beyond the original year", async t => {
  // Given an authenticated editor with a catalog larger than the original year.
  const { page } = await openApp(t);
  // When the owner enters extended metadata.
  const valid = await page.evaluate(() => [
    ["editor-document-id", "lesson-1000"], ["editor-order", "1000"], ["editor-week", "90"], ["editor-legacy-id", "1000"]
  ].map(([id, value]) => { const node = document.getElementById(id); node.value = value; return node.checkValidity(); }));
  // Then native form validation accepts every field.
  assert.deepEqual(valid, [true, true, true, true]);
});

test("saving the schedule preserves minutes and midnight", async t => {
  // Given the saved time contains minutes.
  const { page, requests } = await openApp(t);
  await page.locator('[data-view="ops"]').click();
  assert.equal(await page.locator("#schedule-hour").inputValue(), "09:35");
  // When the owner saves midnight with minutes.
  await page.locator("#schedule-hour").fill("00:17");
  const response = page.waitForResponse(response => response.url().endsWith("owner-api") && response.request().postDataJSON().action === "settings.update");
  await page.locator("#save-schedule").click();
  await response;
  // Then the API receives the complete time.
  assert.equal(requests.find(item => item.action === "settings.update").payload.sendTime, "00:17");
});

test("dashboard shows counts and today/tomorrow with a concise account summary", async t => {
  // Given the API returns dashboard summaries and private snapshot bodies.
  const { page } = await openApp(t);
  await page.locator('[data-view="ops"]').click();
  await page.screenshot({ path: path.join(evidence, `${phase}-ops-1280.png`), animations: "disabled" });
  // When the operations screen is read.
  const summary = await page.locator("#dashboard-summary").textContent({ timeout: 1500 });
  const account = await page.locator("#account-output").textContent();
  // Then human-readable summaries appear without raw bodies or owner UUIDs.
  assert.match(summary, /초안\s*1/);
  assert.match(summary, /게시\s*364/);
  assert.match(summary, /오늘 합성 글/);
  assert.match(summary, /내일 합성 글/);
  assert.match(account, /synthetic@example.test/);
  assert.match(account, /Asia\/Seoul/);
  assert.doesNotMatch(account, /PRIVATE_BODY_SENTINEL|synthetic-private-uid|"document"/);
});

test("admin category and level filters combine with query and state", async t => {
  // Given the full catalog has different states, categories and levels.
  const { page } = await openApp(t);
  await page.locator('[data-view="admin"]').click();
  // When the owner narrows the catalog with every filter.
  await page.locator("#admin-category").selectOption({ value: "database" }, { timeout: 1500 });
  await page.locator("#admin-level").selectOption("foundation");
  await page.locator("#admin-state").selectOption("published");
  await page.locator("#admin-search").fill("학습글 364");
  await page.waitForFunction(() => document.querySelectorAll("#admin-list .lesson-card").length === 1);
  // Then only the matching lesson appears.
  assert.match(await page.locator("#admin-list").textContent(), /학습글 364/);
});

test("override selector retains every published title after admin filtering and sends its UUID", async t => {
  // Given an admin state filter excludes published lessons.
  const { page, requests } = await openApp(t);
  await page.locator('[data-view="admin"]').click();
  await page.locator("#admin-state").selectOption("draft");
  await page.locator('[data-view="ops"]').click();
  // When a published title beyond the original 100 is selected.
  const selector = page.locator("select#schedule-override-lesson-id");
  assert.equal(await selector.locator("option").count(), 365);
  await selector.selectOption(lessons[364].id, { timeout: 1500 });
  await page.locator("#schedule-override-mode").selectOption("lesson");
  const response = page.waitForResponse(response => response.url().endsWith("owner-api") && response.request().postDataJSON().action === "schedule.setOverride");
  await page.locator("#save-override").click();
  await response;
  // Then the title option resolves to the unchanged UUID contract.
  assert.equal(requests.find(item => item.action === "schedule.setOverride").payload.lessonId, lessons[364].id);
});

test("keyword search uses summary metadata without per-lesson API requests", async t => {
  // Given a catalog summary includes keywords but no document bodies.
  const { page, requests } = await openApp(t);
  await page.locator('[data-view="admin"]').click();
  // When an owner searches a keyword.
  await page.locator("#admin-search").fill("keyword-365");
  // Then matching uses the single catalog response.
  assert.equal(await page.locator("#admin-list .lesson-card").count(), 1);
  assert.match(await page.locator("#admin-list").textContent(), /학습글 365/);
  assert.equal(requests.filter(item => item.action === "lesson.list").length, 1);
  assert.equal(requests.filter(item => item.action === "lesson.get").length, 0);
});

test("empty override selection gives feedback without sending an invalid UUID", async t => {
  // Given no published lesson has been selected.
  const { page, requests } = await openApp(t);
  await page.locator('[data-view="ops"]').click();
  await page.locator("#schedule-override-mode").selectOption("lesson");
  // When the owner attempts to save a lesson override.
  await page.locator("#save-override").click();
  // Then the required choice is explained and no write is sent.
  assert.match(await page.locator("#ops-status").textContent(), /선택해 주세요/);
  assert.equal(requests.filter(item => item.action === "schedule.setOverride").length, 0);
});

test("logout clears rendered dashboard and account data", async t => {
  // Given summaries have been rendered for an authenticated owner.
  const { page } = await openApp(t);
  // When the session ends.
  await page.locator("#local-logout").click();
  await page.locator("#auth-shell").waitFor();
  // Then no sensitive summary or title options remain in the DOM.
  assert.equal(await page.locator("#account-output").textContent(), "");
  assert.equal(await page.locator("#dashboard-summary").textContent(), "");
  assert.equal(await page.locator("#schedule-override-lesson-id option").count(), 1);
});

test("operations and admin controls fit mobile, tablet and desktop", async t => {
  // Given the owner views each changed surface.
  const { page } = await openApp(t);
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const view of ["ops", "admin"]) {
      // When the viewport changes.
      await page.locator(`[data-view="${view}"]`).click();
      await page.screenshot({ path: path.join(evidence, `${phase}-${view}-${width}.png`), animations: "disabled" });
      // Then the document has no horizontal overflow.
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${view} at ${width}px`);
    }
  }
});
