const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("Pages deploys only main while feature dispatches retain the build checks", () => {
  const workflow = fs.readFileSync(path.resolve(__dirname, "../.github/workflows/pages.yml"), "utf8");
  const buildJob = workflow.split(/^  build:\s*$/m)[1].split(/^  deploy:\s*$/m)[0];
  const deployJob = workflow.split(/^  deploy:\s*$/m)[1];
  assert.match(workflow, /^  workflow_dispatch:\s*$/m);
  assert.doesNotMatch(buildJob, /^    if:/m);
  assert.match(buildJob, /run: node --test --test-concurrency=1 tests\/\*\.test\.js/);
  assert.equal(deployJob.match(/^    if:\s*(.+)$/m)?.[1].trim(), "github.ref == 'refs/heads/main'");
  assert.match(deployJob, /^    needs: build\s*$/m);
});

test("Pages installs the locked Chromium browser and Linux dependencies before browser tests", () => {
  // Given a fresh Ubuntu runner installs the project's locked npm dependencies.
  const workflow = fs.readFileSync(path.resolve(__dirname, "../.github/workflows/pages.yml"), "utf8");
  const buildJob = workflow.split(/^  build:\s*$/m)[1].split(/^  deploy:\s*$/m)[0];
  const steps = buildJob.split(/^      - name:\s*/m).slice(1).map(step => ({
    name: step.split(/\r?\n/)[0],
    run: step.match(/^        run:\s*(.+)$/m)?.[1].trim()
  }));
  // When the CI commands are evaluated in execution order.
  const dependencies = steps.findIndex(step => step.run === "npm ci");
  const browser = steps.findIndex(step => step.run?.includes("playwright install"));
  const tests = steps.findIndex(step => step.name === "Test");
  // Then the browser comes from the installed CLI, includes its Linux libraries,
  // and is available before any test can call chromium.launch().
  assert.ok(dependencies >= 0, "npm ci must install the lockfile dependencies");
  assert.ok(browser > dependencies, "Chromium must be installed after npm ci");
  assert.ok(tests > browser, "Chromium must be installed before the test step");
  assert.deepEqual(steps[browser].run.split(/\s+/), ["npx", "--no-install", "playwright", "install", "--with-deps", "chromium"]);
  assert.match(steps[tests].run, /node --test\b.*tests\/\*\.test\.js/);
});
