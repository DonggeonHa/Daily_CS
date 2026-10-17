const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const test = require("node:test");
const vm = require("node:vm");

for (const filename of ["backend-data-sql.test.js", "hook-sql.test.js", "import-revision-guard-sql.test.js", "integration-sql-rls.test.js", "schedule-sql.test.js"]) {
  test(`${filename} waits for the final TCP server instead of the temporary initialization socket`, () => {
    // Given the initialization socket accepts connections before TCP is ready.
    const sourcePath = path.join(__dirname, filename);
    const nativeRequire = createRequire(sourcePath);
    const probes = [];
    let tcpReady = false;
    const hooks = [];
    const ignoredTest = () => {};
    ignoredTest.before = callback => hooks.push(callback);
    ignoredTest.after = ignoredTest.beforeEach = () => {};
    const fakeExec = (_command, args) => {
      if (args.includes("pg_isready")) {
        probes.push(args);
        if (args[args.indexOf("-h") + 1] === "127.0.0.1") {
          if (!tcpReady) { tcpReady = true; throw new Error("TCP server is still initializing"); }
        }
      }
      return "1";
    };
    const context = vm.createContext({
      require: name => name === "node:test" ? ignoredTest : name === "node:child_process" ? { execFileSync: fakeExec } : nativeRequire(name),
      __dirname, process, module: { exports: {} },
      Atomics: { wait: () => "timed-out" }, Int32Array, SharedArrayBuffer, Buffer
    });
    // When the actual harness readiness code runs with the Docker command seam recorded.
    vm.runInContext(fs.readFileSync(sourcePath, "utf8"), context);
    if (filename === "schedule-sql.test.js") hooks[0]();
    else vm.runInContext("waitForPostgres('synthetic-container')", context);
    // Then it retries TCP and never accepts readiness from the temporary socket.
    assert.ok(probes.length >= 2, "must wait through the temporary initialization phase");
    assert.ok(probes.every(args => args[args.indexOf("-h") + 1] === "127.0.0.1"), "readiness must use the final TCP listener");
  });
}

test("manual frozen snapshot fixture advances its cursor atomically without rewriting history", () => {
  // Given the data test seeds an immutable Sep15 snapshot directly.
  const source = fs.readFileSync(path.join(__dirname, "backend-data-sql.test.js"), "utf8");
  const seed = source.split("function pg_temp.seed_lesson_snapshot(target_lesson_id uuid)")[1].split("$$;")[0];
  // When that helper declares the day frozen.
  const insert = seed.indexOf("insert into daily_cs_private.day_snapshots");
  const cursor = seed.indexOf("update daily_cs_private.schedule_state");
  // Then the scheduler resumes after Sep15 and the historical snapshot stays immutable.
  assert.ok(cursor > insert, "the seeded frozen day must advance the schedule cursor in the same helper");
  assert.match(seed, /last_frozen_date\s*=\s*greatest\(last_frozen_date,\s*date '2026-09-15'\)/);
  assert.doesNotMatch(seed, /update daily_cs_private\.day_snapshots|on conflict/i);
  assert.match(source, /function daily_cs_private\.schedule_now\(\)[\s\S]*?2026-09-15T01:00:00Z/);
});
