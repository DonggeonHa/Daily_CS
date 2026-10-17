const { build } = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const root = path.resolve(__dirname, "..");
const outdir = path.join(root, "dist", "shared");
const outfile = path.join(outdir, "render.mjs");
const edgeOutfile = path.join(root, "supabase", "functions", "_shared", "render.mjs");
const lockfile = path.join(root, ".build-shared-render.lock");

function readPositiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function isPidLive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

function lockAgeMs(stat) {
  return Date.now() - stat.mtimeMs;
}

function removeLock() {
  const stalePath = `${lockfile}.stale-${process.pid}-${Date.now()}`;
  try {
    fs.renameSync(lockfile, stalePath);
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
  fs.unlinkSync(stalePath);
}

function shouldRemoveLock(staleMs) {
  let stat;
  try {
    stat = fs.statSync(lockfile);
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
  if (stat.size === 0) return lockAgeMs(stat) >= staleMs;

  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(lockfile, "utf8"));
  } catch (error) {
    return lockAgeMs(stat) >= staleMs;
  }

  if (isPidLive(lock.pid)) return false;
  return true;
}

async function withBuildLock(task) {
  const waitMs = readPositiveIntEnv("DAILY_CS_SHARED_RENDER_LOCK_WAIT_MS", 5000);
  const staleMs = readPositiveIntEnv("DAILY_CS_SHARED_RENDER_LOCK_STALE_MS", 30000);
  const startedAt = Date.now();
  while (Date.now() - startedAt < waitMs) {
    try {
      fs.writeFileSync(lockfile, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), { flag: "wx" });
      try {
        return await task();
      } finally {
        removeLock();
      }
    } catch (error) {
      if (error && error.code === "EEXIST") {
        if (shouldRemoveLock(staleMs)) {
          removeLock();
          continue;
        }
        await delay(20);
        continue;
      }
      throw error;
    }
  }
  throw new Error("timed out waiting for shared renderer build lock");
}

function copyIfChanged(from, to) {
  const source = fs.readFileSync(from);
  if (fs.existsSync(to) && source.equals(fs.readFileSync(to))) return;
  fs.copyFileSync(from, to);
}

async function buildSharedRender() {
  return withBuildLock(async () => {
    fs.mkdirSync(outdir, { recursive: true });
    fs.mkdirSync(path.dirname(edgeOutfile), { recursive: true });
    await build({
      entryPoints: [path.join(root, "lib", "render-esm-entry.mjs")],
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: ["es2022"],
      outfile,
      sourcemap: false,
      minify: true,
      legalComments: "none"
    });
    copyIfChanged(outfile, edgeOutfile);
    const stat = fs.statSync(outfile);
    return { outfile, edgeOutfile, bytes: stat.size };
  });
}

if (require.main === module) {
  buildSharedRender()
    .then((result) => {
      console.log(`Built shared renderer to ${result.outfile}`);
      console.log(`render.mjs ${result.bytes} bytes`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

module.exports = { buildSharedRender, outfile, edgeOutfile };
