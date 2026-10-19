const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const { build } = require("esbuild");
const { chromium } = require("playwright");
const { createPreviewServer } = require("../scripts/preview-server.js");

const root = path.resolve(__dirname, "..");
const evidence = path.resolve(root, "../v2-evidence/visual-pilot/web");
const visual = {
  version: 1, id: "synthetic-flow", title: "합성 흐름 살펴보기", description: "조건을 고르고 각 단계를 비교합니다.",
  alt: "두 상자가 순서대로 상태를 바꾸는 합성 설명입니다.", emailAssetId: "a".repeat(64), emailScenarioId: "normal", emailStep: 0,
  scenarios: ["normal", "alternate"].map((id, scenario) => ({ id, label: scenario ? "대체 조건" : "기본 조건", steps: Array.from({ length: 3 }, (_, step) => ({
    title: `합성 단계 ${scenario + 1}-${step + 1}`, description: `이 단계의 설명 ${step + 1}`,
    nodes: [{ id: "first", label: "첫 번째 상자", detail: "긴 한국어 설명도 읽을 수 있습니다.", tone: step ? "success" : "active" }, { id: "second", label: "두 번째 상자", detail: "도착 상태", tone: "neutral" }],
    edges: [{ from: "first", to: "second", label: "이동" }], metrics: [{ label: "예시 단계", value: String(step + 1) }]
  })) }))
};
const id = "00000000-0000-4000-8000-000000000001";
visual.scenarios.push({ id: "short", label: "한 단계 조건", steps: [visual.scenarios[0].steps[0]] });
let browser, server, origin, appBundle;

test.before(async () => {
  await fs.mkdir(evidence, { recursive: true });
  const bundle = await build({ entryPoints: [path.join(root, "web/assets/app.js")], bundle: true, format: "esm", write: false,
    plugins: [{ name: "synthetic-auth", setup(builder) {
      builder.onResolve({ filter: /^\.\/auth\.js$/ }, () => ({ path: "auth", namespace: "test" }));
      builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: `
        export const RETURN_URL_KEY = 'synthetic-return';
        export const createAuthClient = () => ({});
        export const getVerifiedSession = async () => ({access_token:'synthetic', user:{email:'synthetic@example.test'}});
        export const safeReturnUrl = value => value;
        export const signInWithGoogle = async () => ({});
        export const signOut = async () => {};
        export const startSessionRefresh = () => () => {};
      ` }));
    } }] });
  appBundle = bundle.outputFiles[0].text;
  server = createPreviewServer({ root: path.join(root, "web") });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, channel: "chrome" });
});
test.after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function openApp(t, kind = "structured", reducedMotion = "reduce") {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion });
  page.setDefaultTimeout(2500);
  t.after(() => page.close());
  const requests = [];
  const document = { id: "synthetic", title: "합성 문서", summary: "테스트 전용", level: "foundation", track: "common", week: 1, category: "network", answer: "합성 본문", markdown: "## 합성 본문\n내용", visuals: [visual] };
  const lesson = { id, title: "합성 문서", category: "network", state: "draft", revision: 1, documentKind: kind, draftDocument: document };
  await page.route("**/assets/app.js", route => route.fulfill({ contentType: "text/javascript", body: appBundle }));
  await page.route("**/assets/config.js", route => route.fulfill({ contentType: "text/javascript", body: `window.DAILY_CS_CONFIG={supabaseUrl:'${origin}',basePath:'/Daily_CS/'};` }));
  await page.route("**/functions/v1/owner-api", async route => {
    const { action, payload } = route.request().postDataJSON();
    requests.push({ action, payload });
    const settings = { startDate: "2026-10-01", timezone: "Asia/Seoul", sendTime: "09:00" };
    const responses = { "dashboard.get": { settings }, "lesson.list": { items: [lesson] }, "settings.get": settings,
      "schedule.get": { days: [] }, "mail.status": { items: [] }, "reader.history": { days: [] },
      "reader.today": { day: { date: "2026-10-19", lessonId: id, title: lesson.title, category: "network", documentKind: kind, document } },
      "lesson.get": { lesson, revisions: [] }, "lesson.saveDraft": { lesson: { ...lesson, draftDocument: payload.document, revision: 2 } } };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: responses[action] ?? {} }) });
  });
  await page.goto(`${origin}/Daily_CS/`);
  await page.locator("#admin-list .lesson-card").waitFor({ state: "attached" });
  await page.locator("#reader-status").filter({ hasText: "열었습니다" }).waitFor();
  return { page, requests };
}

test("structured and markdown edits preserve visual documents in saves and previews", async t => {
  for (const kind of ["structured", "markdown"]) {
    const { page, requests } = await openApp(t, kind);
    await page.locator('[data-view="admin"]').click();
    await page.locator("#admin-list .lesson-card").click();
    await page.locator("#editor-title").fill("수정한 합성 문서");
    const saved = page.waitForResponse(response => response.url().endsWith("owner-api") && response.request().postDataJSON().action === "lesson.saveDraft");
    await page.locator("#editor-form").evaluate(form => form.dispatchEvent(new Event("submit", { cancelable: true })));
    await saved;
    assert.deepEqual(requests.find(item => item.action === "lesson.saveDraft").payload.document.visuals, [visual]);
    assert.equal(await page.locator("#preview-output [data-visual-id]").count(), 1);
  }
});

test("player starts paused and supports condition, steps, reset and keyboard", async t => {
  const { page } = await openApp(t);
  const figure = page.locator("#lesson-paper [data-visual-id]");
  assert.equal(await figure.getByRole("button", { name: "재생", exact: true, includeHidden: true }).count(), 1);
  assert.match(await figure.locator("[data-visual-frame]").textContent(), /합성 단계 1-1/);
  await figure.getByRole("button", { name: "다음 단계" }).click();
  assert.match(await figure.locator("[data-visual-frame]").textContent(), /합성 단계 1-2/);
  await figure.getByLabel("조건").selectOption("alternate");
  assert.match(await figure.locator("[data-visual-frame]").textContent(), /합성 단계 2-1/);
  await figure.focus();
  await page.keyboard.press("ArrowRight");
  assert.match(await figure.locator("[data-visual-frame]").textContent(), /합성 단계 2-2/);
  await page.keyboard.press("End");
  assert.equal(await figure.getByRole("button", { name: "다음 단계" }).isDisabled(), true);
  await figure.getByRole("button", { name: "처음으로" }).click();
  assert.match(await figure.locator("[data-visual-frame]").textContent(), /합성 단계 2-1/);
  await page.waitForTimeout(1700);
  assert.match(await figure.locator("[data-visual-frame]").textContent(), /합성 단계 2-1/);
});

test("playback stops on navigation, and logout clears all private visual DOM", async t => {
  const { page } = await openApp(t, "markdown", "no-preference");
  const figure = page.locator("#lesson-paper [data-visual-id]");
  await figure.getByRole("button", { name: "재생", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#lesson-paper [data-visual-frame]")?.textContent.includes("합성 단계 1-2"));
  await page.locator('[data-view="admin"]').click();
  assert.equal(await figure.getByRole("button", { name: "재생", exact: true, includeHidden: true }).count(), 1);
  await page.waitForTimeout(1700);
  assert.match(await figure.locator("[data-visual-frame]").textContent(), /합성 단계 1-2/);
  await page.locator("#local-logout").click();
  assert.equal(await page.locator("[data-visual-id]").count(), 0);
  assert.doesNotMatch(await page.locator("body").textContent(), /합성 흐름 살펴보기|두 상자가/);
});

test("late visual responses cannot repopulate private content after logout", async t => {
  const { page } = await openApp(t, "markdown");
  let release, received;
  const pending = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { received = resolve; });
  await page.route("**/functions/v1/owner-api", async route => {
    if (route.request().postDataJSON().action !== "reader.today") return route.fallback();
    received();
    await pending;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: { day: { date: "2026-10-19", title: "합성 지연 문서", documentKind: "markdown", document: { markdown: "지연 본문", visuals: [visual] } } } }) });
  });
  await page.locator("#reader-today").click();
  await started;
  await page.locator("#local-logout").click();
  const response = page.waitForResponse(item => item.url().endsWith("owner-api") && item.request().postDataJSON().action === "reader.today");
  release();
  await response;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator("[data-visual-id]").count(), 0);
  assert.doesNotMatch(await page.locator("body").textContent(), /합성 지연 문서|합성 흐름 살펴보기|지연 본문/);
});

test("changing from a final long frame to one step stays valid and Space cannot play it", async t => {
  const { page } = await openApp(t);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const figure = page.locator("#lesson-paper [data-visual-id]");
  await figure.focus();
  await page.keyboard.press("End");
  await figure.getByLabel("조건").selectOption("short");
  assert.match(await figure.locator("[data-visual-frame]").textContent(), /합성 단계 1-1/);
  assert.equal(await figure.getByRole("button", { name: "재생", exact: true }).isDisabled(), true);
  await figure.focus();
  await page.keyboard.press("Space");
  await page.waitForTimeout(1700);
  assert.match(await figure.locator("[data-visual-frame]").textContent(), /합성 단계 1-1/);
  assert.deepEqual(errors, []);
});

test("responsive visual controls and readable frame fit all approved viewports", async t => {
  const { page } = await openApp(t);
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    const figure = page.locator("#lesson-paper [data-visual-id]");
    await figure.scrollIntoViewIfNeeded();
    await figure.getByRole("button", { name: "다음 단계" }).focus();
    await page.screenshot({ path: path.join(evidence, `visual-${width}.png`), fullPage: true, animations: "disabled" });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await figure.locator("[data-visual-frame]").isVisible(), true);
    assert.equal(await figure.getByRole("button", { name: "이전 단계" }).isDisabled(), true);
    assert.equal(await figure.getByRole("button", { name: "다음 단계" }).evaluate(node => node.getBoundingClientRect().height >= 44), true);
  }
});
