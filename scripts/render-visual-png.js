const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { chromium } = require("playwright");
const { validateVisuals, renderVisualFrameHtml } = require("../lib/visuals.js");
const { escapeHtml } = require("../lib/markdown-renderer.js");

const publicRoot = fs.realpathSync(path.resolve(__dirname, ".."));
function insidePublic(candidate) {
  const relative = path.relative(publicRoot, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function privateOutputDirectory(outputDir) {
  if (typeof outputDir !== "string" || !path.isAbsolute(outputDir) || insidePublic(path.resolve(outputDir))) {
    throw new Error("PNG output must be an absolute directory outside public checkout");
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const resolved = fs.realpathSync(outputDir);
  if (insidePublic(resolved)) throw new Error("PNG output must be outside public checkout");
  return resolved;
}

async function renderVisualPng(visual, { outputDir } = {}) {
  const errors = validateVisuals([visual]);
  if (errors.length) throw new Error(`Invalid visuals: ${errors.join("; ")}`);
  const directory = privateOutputDirectory(outputDir);
  const step = visual.scenarios.find((scenario) => scenario.id === visual.emailScenarioId).steps[visual.emailStep];
  // Styles and font stack come from the maintained web design system; the frame is the same trusted renderer.
  const css = fs.readFileSync(path.join(publicRoot, "web/assets/styles.css"), "utf8");
  const html = `<!doctype html><html lang="ko" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Diagram</title><style>${css}\nhtml,body{margin:0;width:360px;background:var(--surface-paper,#FFFCF6)}body{padding:var(--space-2);box-sizing:border-box}figure.lesson-visual{margin:0;width:100%;box-sizing:border-box;padding:var(--space-3)}.lesson-visual p,.lesson-visual li,.lesson-visual dt,.lesson-visual dd,.lesson-visual strong,.lesson-visual span{font-size:16px}.visual-nodes{grid-template-columns:1fr}.visual-step h3{margin-top:var(--space-3)}*{animation:none!important;transition:none!important}</style></head><body><figure class="lesson-visual"><figcaption><h2 class="visual-title">${escapeHtml(visual.title)}</h2><p class="visual-description">${escapeHtml(visual.description)}</p></figcaption><div data-visual-frame>${renderVisualFrameHtml(step)}</div><p class="visual-alt">${escapeHtml(visual.alt)}</p></figure></body></html>`;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 900 }, deviceScaleFactor: 2, colorScheme: "light", reducedMotion: "reduce" });
    await page.route("**/*", (route) => route.abort());
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await document.fonts.load('16px "Malgun Gothic"', "가나다 한글");
      if (!document.fonts.check('16px "Malgun Gothic"', "가나다 한글")) throw new Error("Korean font is not ready");
    });
    const dimensions = await page.evaluate(() => {
      const textElements = [...document.querySelectorAll(".lesson-visual *")].filter((element) => [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim()));
      return { width: document.documentElement.scrollWidth, height: Math.ceil(document.body.getBoundingClientRect().height), minFontSize: Math.min(...textElements.map((element) => parseFloat(getComputedStyle(element).fontSize))) };
    });
    if (dimensions.width !== 360 || dimensions.height > 1024) throw new Error("Diagram exceeds 360 logical px width or 1024 logical px height; shorten the canonical frame");
    if (dimensions.minFontSize < 16) throw new Error("Diagram text is too small for mobile email");
    const buffer = await page.locator("body").screenshot({ type: "png", animations: "disabled" });
    if (buffer.length > 256 * 1024) throw new Error("Diagram PNG exceeds 256KiB; shorten the canonical frame");
    const assetId = crypto.createHash("sha256").update(buffer).digest("hex");
    const file = path.join(directory, `${assetId}.png`);
    if (fs.existsSync(file)) {
      if (!buffer.equals(fs.readFileSync(file))) throw new Error("Existing asset bytes do not match their hash");
    } else fs.writeFileSync(file, buffer, { flag: "wx" });
    return { assetId, file, mimeType: "image/png", bytes: buffer.length, width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), layoutWidth: dimensions.width, minFontSize: dimensions.minFontSize };
  } finally {
    await browser.close();
  }
}

async function main(args) {
  const flags = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!["--input", "--out-dir"].includes(args[i]) || !args[i + 1] || flags.has(args[i])) throw new Error("Usage: --input ABS_JSON --out-dir ABS_PRIVATE_DIR");
    flags.set(args[i], args[i + 1]);
  }
  if (!flags.has("--input") || !flags.has("--out-dir") || !path.isAbsolute(flags.get("--input"))) throw new Error("Usage: --input ABS_JSON --out-dir ABS_PRIVATE_DIR");
  const payload = JSON.parse(fs.readFileSync(flags.get("--input"), "utf8"));
  const visuals = payload.document?.visuals ?? payload.visuals ?? (Array.isArray(payload) ? payload : [payload]);
  const errors = validateVisuals(visuals);
  if (errors.length) throw new Error(`Invalid visuals: ${errors.join("; ")}`);
  const assets = [];
  for (const visual of visuals) assets.push(await renderVisualPng(visual, { outputDir: flags.get("--out-dir") }));
  process.stdout.write(`${JSON.stringify({ assets })}\n`);
}

if (require.main === module) main(process.argv.slice(2)).catch((error) => {
  // Input values and browser HTML can contain private lesson content: emit a fixed failure category only.
  process.stderr.write(`Visual PNG generation failed: ${error.message.startsWith("Invalid visuals:") ? error.message : "check private input, output path, browser, font and diagram bounds"}\n`);
  process.exitCode = 1;
});

module.exports = { renderVisualPng };
