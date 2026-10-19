const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const generatorFile = path.resolve(__dirname, "../scripts/render-visual-png.js");
function sample() {
  return { version: 1, id: "sample", title: "샘플 도식", description: "샘플 처리 흐름", alt: "입력에서 출력으로 전달됩니다.",
    emailAssetId: "0".repeat(64), emailScenarioId: "basic", emailStep: 0,
    scenarios: [{ id: "basic", label: "기본", steps: [{ title: "전달", description: "입력 데이터를 출력으로 전달합니다.",
      nodes: [{ id: "input", label: "입력", detail: "가나다 한글 표시", tone: "active" }, { id: "output", label: "출력", tone: "success" }],
      edges: [{ from: "input", to: "output", label: "전달" }], metrics: [{ label: "처리", value: "1회" }] }] }] };
}

test("PNG generator rejects public output before launching the browser", async () => {
  // Given
  assert.ok(fs.existsSync(generatorFile), "private PNG generator exists");
  const { renderVisualPng } = require(generatorFile);
  // When / Then
  await assert.rejects(renderVisualPng(sample(), { outputDir: path.resolve(__dirname, "../dist/private-image") }), /outside public checkout/);
});

test("PNG generator creates a decodable private hash-named Korean diagram", async () => {
  // Given
  assert.ok(fs.existsSync(generatorFile), "private PNG generator exists");
  const { renderVisualPng } = require(generatorFile);
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-cs-visual-"));
  try {
    // When
    const result = await renderVisualPng(sample(), { outputDir });
    // Then
    const bytes = fs.readFileSync(result.file);
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(result.assetId, crypto.createHash("sha256").update(bytes).digest("hex"));
    assert.equal(path.basename(result.file), `${result.assetId}.png`);
    assert.equal(bytes.readUInt32BE(16), 720);
    assert.ok(bytes.readUInt32BE(20) > 200 && bytes.readUInt32BE(20) < 1800, "canonical frame is cropped to content");
    assert.equal(result.layoutWidth, 360, "email image uses a narrow reflowed layout");
    assert.ok(result.minFontSize * 375 / result.layoutWidth >= 16, "every diagram text remains readable at375px email width");
    assert.ok(bytes.length <= 256 * 1024);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
