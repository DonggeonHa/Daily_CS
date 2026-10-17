const { build } = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");
const { buildSharedRender } = require("./build-shared-render.js");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const web = path.join(root, "web");

const publicConfig = {
  supabaseUrl: process.env.DAILY_CS_SUPABASE_URL || "https://gdraufrjlmzhnegrrjhj.supabase.co",
  supabaseAnonKey: process.env.DAILY_CS_SUPABASE_ANON_KEY || "sb_publishable__sNrJT5Ussixjapx4yfloA_-TroIxxm",
  basePath: "/Daily_CS/",
  enableMock: process.env.DAILY_CS_ENABLE_MOCK === "1"
};

function rmrf(target) {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

function copyDir(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function writeConfig() {
  fs.writeFileSync(path.join(dist, "assets", "config.js"), `window.DAILY_CS_CONFIG = ${JSON.stringify(publicConfig, null, 2)};\n`);
}

async function bundle() {
  await build({
    entryPoints: {
      app: path.join(web, "assets", "app.js"),
      callback: path.join(web, "assets", "callback.js")
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    outdir: path.join(dist, "assets"),
    entryNames: "[name]",
    sourcemap: false,
    minify: true,
    legalComments: "none"
  });
}

async function buildSite() {
  rmrf(dist);
  copyDir(web, dist);
  await buildSharedRender();
  await bundle();
  writeConfig();
  const appStat = fs.statSync(path.join(dist, "assets", "app.js"));
  const callbackStat = fs.statSync(path.join(dist, "assets", "callback.js"));
  return { dist, appBytes: appStat.size, callbackBytes: callbackStat.size, config: publicConfig };
}

if (require.main === module) {
  buildSite()
    .then((result) => {
      console.log(`Built Daily_CS v2 to ${result.dist}`);
      console.log(`app.js ${result.appBytes} bytes`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

module.exports = { buildSite, publicConfig };
