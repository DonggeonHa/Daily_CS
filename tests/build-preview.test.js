const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { buildSite } = require("../scripts/build.js");
const { classifyRequestPath } = require("../scripts/preview-server.js");

let buildResultPromise = null;

function buildOnce() {
  if (buildResultPromise === null) {
    buildResultPromise = buildSite();
  }
  return buildResultPromise;
}

test("build writes bundled app and public config without synthetic lesson payloads", async () => {
  const result = await buildOnce();
  const app = fs.readFileSync(path.join(result.dist, "assets", "app.js"), "utf8");
  const config = fs.readFileSync(path.join(result.dist, "assets", "config.js"), "utf8");
  const index = fs.readFileSync(path.join(result.dist, "index.html"), "utf8");

  assert(result.appBytes > 10000);
  assert.match(config, /gdraufrjlmzhnegrrjhj\.supabase\.co/);
  assert.match(config, /sb_publishable__/);
  assert.doesNotMatch(app, /기존 365|Oracle Database 일반 트랜잭션|content\/lessons/);
  assert.match(index, /Google로 로그인/);
  assert.match(index, /등록된 Google 계정으로만 들어올 수 있습니다/);
  assert.doesNotMatch(index, /owner@example\.com|소유자 이메일|login-email|Google 로그인 링크 만들기/);
});

test("build writes callback as a self-contained browser bundle", async () => {
  const result = await buildOnce();
  const callback = fs.readFileSync(path.join(result.dist, "assets", "callback.js"), "utf8");
  const callbackPage = fs.readFileSync(path.join(result.dist, "auth", "callback.html"), "utf8");

  assert(result.callbackBytes > 10000);
  assert.match(callbackPage, /assets\/callback\.js/);
  assert(!callback.trimStart().startsWith("import "));
  assert.doesNotMatch(callback, /from\s+["']\.\/auth\.js["']|from\s+["']@supabase\/supabase-js["']/);
});

test("preview server confines requests to Daily_CS base path", async () => {
  const result = await buildOnce();

  assert.equal(classifyRequestPath(result.dist, "/Daily_CS/").status, 200);
  assert.equal(classifyRequestPath(result.dist, "/Daily_CS/assets/app.js").status, 200);
  assert.equal(classifyRequestPath(result.dist, "/other/").status, 403);
  assert.equal(classifyRequestPath(result.dist, "/Daily_CS/%2e%2e/package.json").status, 403);
});
