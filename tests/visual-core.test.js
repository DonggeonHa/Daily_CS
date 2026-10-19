const assert = require("node:assert/strict");
const test = require("node:test");
const render = require("../lib/render.js");
const { validateLessonRecord } = require("../lib/validation.js");

function visual() {
  return {
    version: 1, id: "sample-flow", title: "교육 흐름", description: "조건별 처리 흐름입니다.",
    alt: "요청이 처리로 전달됩니다.", emailAssetId: "a".repeat(64), emailScenarioId: "normal", emailStep: 0,
    scenarios: [{ id: "normal", label: "기본 조건", steps: [{ title: "요청 전달", description: "화살표는 전달 방향입니다.",
      nodes: [{ id: "request", label: "요청", tone: "active" }, { id: "process", label: "처리", detail: "순서대로 처리", tone: "neutral" }],
      edges: [{ from: "request", to: "process", label: "전달" }], metrics: [{ label: "단계", value: "1" }] }] }]
  };
}

test("accepts optional visuals and complete bounded scenarios", () => {
  // Given / When / Then: both old documents and precomputed visual scenarios are valid.
  assert.equal(typeof render.validateVisuals, "function");
  assert.deepEqual(render.validateVisuals(undefined), []);
  assert.deepEqual(render.validateVisuals([visual()]), []);
});

for (const [name, value] of [
  ["empty", ""], ["spaces", "   "], ["Unicode spaces", "\u00a0\u2003\ufeff"],
]) {
  test(`rejects ${name} edge labels`, () => {
    // Given
    const valueWithEdge = visual();
    valueWithEdge.scenarios[0].steps[0].edges[0].label = value;
    // When
    const errors = render.validateVisuals([valueWithEdge]);
    // Then
    assert.ok(errors.some((error) => error.includes("edges[0].label")));
  });
}

for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127, 133, 159]) {
  for (const field of ["title", "description"]) {
    test(`rejects control U+${code.toString(16).padStart(4, "0")} in ${field}`, () => {
      // Given
      const value = { ...visual(), [field]: `before${String.fromCodePoint(code)}after` };
      // When
      const errors = render.validateVisuals([value]);
      // Then
      assert.ok(errors.some((error) => error.includes(`].${field}`)));
    });
  }
}

for (const [field, maximum] of [["title", 120], ["description", 1200]]) {
  test(`accepts exactly ${maximum} Unicode code points in ${field}`, () => {
    // Given
    const value = { ...visual(), [field]: "😀".repeat(maximum) };
    // When
    const errors = render.validateVisuals([value]);
    // Then
    assert.deepEqual(errors, []);
  });
  test(`rejects ${maximum + 1} Unicode code points in ${field}`, () => {
    // Given
    const value = { ...visual(), [field]: "😀".repeat(maximum + 1) };
    // When
    const errors = render.validateVisuals([value]);
    // Then
    assert.ok(errors.some((error) => error.includes(`].${field}`)));
  });
}

for (const value of ["javascript :alert(1)", "data\u00a0:text/plain,example", "javascript\ufeff:alert(1)"]) {
  test(`rejects spaced URL scheme ${JSON.stringify(value)}`, () => {
    // Given
    const withScheme = { ...visual(), description: value };
    // When
    const errors = render.validateVisuals([withScheme]);
    // Then
    assert.ok(errors.some((error) => error.includes("].description")));
  });
}

const malformed = [
  ["version", (v) => { v.version = 2; }],
  ["duplicate visual ids", (v) => [v, v]],
  ["missing scenario reference", (v) => { v.emailScenarioId = "missing"; }],
  ["negative step", (v) => { v.emailStep = -1; }],
  ["non-finite step", (v) => { v.emailStep = Infinity; }],
  ["out of range step", (v) => { v.emailStep = 1; }],
  ["wrong hash", (v) => { v.emailAssetId = "abc"; }],
  ["unknown properties", (v) => { v.html = "text"; }],
  ["HTML", (v) => { v.title = "<svg onload=alert(1)>"; }],
  ["URL", (v) => { v.description = "https://example.com"; }],
  ["node reference", (v) => { v.scenarios[0].steps[0].edges[0].to = "missing"; }],
  ["duplicate nodes", (v) => { v.scenarios[0].steps[0].nodes[1].id = "request"; }],
  ["invalid tone", (v) => { v.scenarios[0].steps[0].nodes[0].tone = "neutral\" onclick=alert(1)"; }],
  ["oversized labels", (v) => { v.title = "x".repeat(121); }],
  ["too many scenarios", (v) => { v.scenarios = Array.from({ length: 9 }, (_, i) => ({ ...v.scenarios[0], id: `case-${i}` })); }],
  ["too many steps", (v) => { v.scenarios[0].steps = Array(13).fill(v.scenarios[0].steps[0]); }],
  ["too many nodes", (v) => { v.scenarios[0].steps[0].nodes = Array.from({ length: 13 }, (_, i) => ({ id: `node-${i}`, label: "node", tone: "neutral" })); }],
  ["too many visuals", (v) => [v, v, v, v]],
  ["too many edges", (v) => { v.scenarios[0].steps[0].edges = Array(25).fill(v.scenarios[0].steps[0].edges[0]); }],
  ["too many metrics", (v) => { v.scenarios[0].steps[0].metrics = Array(7).fill({ label: "count", value: "1" }); }]
];
for (const [name, mutate] of malformed) {
  test(`rejects visual payload with ${name}`, () => {
    // Given
    const value = visual();
    const result = mutate(value);
    // When
    assert.equal(typeof render.validateVisuals, "function");
    const errors = render.validateVisuals(Array.isArray(result) ? result : [value]);
    // Then
    assert.ok(errors.length > 0);
  });
}

test("renders escaped diagram boxes, named arrows and readable metrics", () => {
  // Given
  const step = visual().scenarios[0].steps[0];
  step.nodes[0].label = "A & <img src=x>";
  // When
  assert.equal(typeof render.renderVisualFrameHtml, "function");
  const html = render.renderVisualFrameHtml(step);
  // Then
  assert.match(html, /A &amp; &lt;img src=x&gt;/);
  assert.match(html, /data-node-id="request"/);
  assert.match(html, /visual-arrow/);
  assert.match(html, /전달/);
  assert.match(html, /<dt>단계<\/dt><dd>1<\/dd>/);
  assert.doesNotMatch(html, /<img/);
});

test("email uses only canonical CID asset and explanatory alt", () => {
  // Given / When
  assert.equal(typeof render.renderVisualsHtml, "function");
  const html = render.renderVisualsHtml([visual()], { email: true });
  // Then
  assert.match(html, new RegExp(`src="cid:visual-${"a".repeat(64)}"`));
  assert.match(html, /alt="요청이 처리로 전달됩니다\."/);
  assert.doesNotMatch(html, /data-visual-frame|<select|<button|<script/);
});

test("lesson rendering includes visuals for structured and markdown documents", () => {
  // Given
  const documents = [{ kind: "structured", title: "Sample" }, { kind: "markdown", markdown: "Sample" }];
  // When / Then
  for (const document of documents) {
    const html = render.renderLessonHtml({ documentKind: document.kind, document: { ...document, visuals: [visual()] } });
    assert.match(html, /data-visual-id="sample-flow"/);
    assert.match(html, /data-visual-frame/);
  }
});

test("partial draft validation still rejects malformed visuals", () => {
  // Given
  const document = { markdown: "Sample", visuals: [{ ...visual(), emailStep: 20 }] };
  // When
  const errors = validateLessonRecord({ state: "draft", lesson: { documentKind: "markdown", document } });
  // Then
  assert.ok(errors.some((error) => error.includes("visuals")));
});

test("plain mail retains the diagram explanation", () => {
  // Given
  const lesson = { documentKind: "markdown", document: { markdown: "Sample", visuals: [visual()] } };
  // When
  const text = render.renderLessonText(lesson);
  // Then
  assert.match(text, /교육 흐름/);
  assert.match(text, /요청이 처리로 전달됩니다\./);
});

module.exports = { visual };
