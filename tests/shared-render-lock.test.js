const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const lockfile = path.join(root, ".build-shared-render.lock");
const outfile = path.join(root, "dist", "shared", "render.mjs");
const edgeOutfile = path.join(root, "supabase", "functions", "_shared", "render.mjs");
const builder = require("../scripts/build-shared-render.js");

function isPidLive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

function assertNoForeignLiveLock() {
  if (!fs.existsSync(lockfile)) return;
  const body = fs.readFileSync(lockfile, "utf8").trim();
  if (!body) return;
  const lock = JSON.parse(body);
  if (lock.pid !== process.pid && isPidLive(lock.pid)) {
    throw new Error(`shared renderer lock is active for pid ${lock.pid}`);
  }
}

function writeLock(body) {
  assertNoForeignLiveLock();
  fs.writeFileSync(lockfile, body);
}

function removeTestLock() {
  if (!fs.existsSync(lockfile)) return;
  assertNoForeignLiveLock();
  const stalePath = `${lockfile}.test-${process.pid}-${Date.now()}`;
  fs.renameSync(lockfile, stalePath);
  fs.unlinkSync(stalePath);
}

async function buildWithShortLockWait() {
  const previousWait = process.env.DAILY_CS_SHARED_RENDER_LOCK_WAIT_MS;
  const previousStale = process.env.DAILY_CS_SHARED_RENDER_LOCK_STALE_MS;
  process.env.DAILY_CS_SHARED_RENDER_LOCK_WAIT_MS = "300";
  process.env.DAILY_CS_SHARED_RENDER_LOCK_STALE_MS = "50";
  try {
    return await builder.buildSharedRender();
  } finally {
    if (previousWait === undefined) delete process.env.DAILY_CS_SHARED_RENDER_LOCK_WAIT_MS;
    else process.env.DAILY_CS_SHARED_RENDER_LOCK_WAIT_MS = previousWait;
    if (previousStale === undefined) delete process.env.DAILY_CS_SHARED_RENDER_LOCK_STALE_MS;
    else process.env.DAILY_CS_SHARED_RENDER_LOCK_STALE_MS = previousStale;
  }
}

function runBuildProcess() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/build-shared-render.js"], {
      cwd: root,
      env: {
        ...process.env,
        DAILY_CS_SHARED_RENDER_LOCK_WAIT_MS: "5000",
        DAILY_CS_SHARED_RENDER_LOCK_STALE_MS: "1000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`build exited ${code}: ${stderr || stdout}`));
    });
  });
}

test("shared render build recovers from a stale zero-byte lock", async () => {
  writeLock("");

  const result = await buildWithShortLockWait();

  assert.equal(fs.existsSync(lockfile), false);
  assert.equal(result.outfile, outfile);
  assert.ok(result.bytes > 0);
});

test("shared render build keeps a live owner lock and times out", async () => {
  writeLock(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));

  await assert.rejects(() => buildWithShortLockWait(), /timed out waiting for shared renderer build lock/);

  assert.equal(JSON.parse(fs.readFileSync(lockfile, "utf8")).pid, process.pid);
  removeTestLock();
});

test("shared render concurrent builds both finish with identical outputs", async () => {
  removeTestLock();

  await Promise.all([runBuildProcess(), runBuildProcess()]);

  assert.equal(fs.existsSync(lockfile), false);
  assert.ok(fs.statSync(outfile).size > 0);
  assert.deepEqual(fs.readFileSync(outfile), fs.readFileSync(edgeOutfile));
});
