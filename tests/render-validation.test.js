const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { buildSharedRender, edgeOutfile, outfile } = require("../scripts/build-shared-render.js");
const { markdownToSafeHtml, renderLessonHtml, renderLessonText, renderMailFromSnapshot } = require("../lib/render.js");
const { validateImportPayload, validateLessonRecord } = require("../lib/validation.js");

test("structured renderer escapes legacy lesson fields", () => {
  const record = structuredRecord("safe-001");
  record.lesson.document.title = "List<String> & <unsafe>";
  record.lesson.document.example.code = "List<String> values = new ArrayList<>();";

  const html = renderLessonHtml(record.lesson);

  assert.match(html, /List&lt;String&gt; &amp; &lt;unsafe&gt;/);
  assert.match(html, /List&lt;String&gt; values = new ArrayList&lt;&gt;\(\);/);
  assert.doesNotMatch(html, /<unsafe>/);
});

test("markdown renderer escapes executable raw HTML but preserves code-fenced generics", () => {
  const html = markdownToSafeHtml([
    "## 예시",
    "",
    "```java",
    "List<String> values = new ArrayList<>();",
    "```",
    "",
    "<img src=x onerror=alert(1)>",
    "<script>alert('blocked')</script>",
    "",
    "[bad](javascript:alert(1)) [good](https://example.com)"
  ].join("\n"));

  assert.match(html, /List&lt;String&gt; values = new ArrayList&lt;&gt;\(\);/);
  assert.doesNotMatch(html, /<script|<img|href="javascript:/i);
  assert.doesNotMatch(html, /<img/i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /https:\/\/example\.com/);
});

test("markdown renderer blocks encoded script links, data URLs, SVG, and image handlers", () => {
  const html = markdownToSafeHtml([
    "[encoded](jav&#x61;script&#x3a;alert(1))",
    "[colon](java&colon;script:alert(1))",
    "[spaced](java&#x0a;script:alert(1))",
    "[data](data:text/html;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)",
    '<svg><a xlink:href="javascript:alert(1)"><circle /></a></svg>',
    '<img src="x" onerror="alert(1)">',
    '[safe](mailto:study@example.com)'
  ].join("\n\n"));

  assert.doesNotMatch(html, /href="[^"]*(?:javascript|data):/i);
  assert.doesNotMatch(html, /<(?:svg|img|circle)\b/i);
  assert.doesNotMatch(html, /<(?:[^>]+)\son[a-z]+\s*=/i);
  assert.match(html, />encoded</);
  assert.match(html, /&lt;svg&gt;/);
  assert.match(html, /href="mailto:study@example.com"/);
});

test("bundled Edge renderer matches CommonJS renderer output", async () => {
  await buildSharedRender();
  const bundleUrl = pathToFileURL(path.resolve(__dirname, "../dist/shared/render.mjs"));
  bundleUrl.search = `v=${Date.now()}`;
  const bundled = await import(bundleUrl.href);
  const input = [
    "## 링크",
    "",
    "```java",
    "List<String> values = new ArrayList<>();",
    "```",
    "",
    "[safe](https://example.com?a=1&b=2)",
    "[bad](jav&#x61;script&#x3a;alert(1))",
    "<img src=x onerror=alert(1)>"
  ].join("\n");

  assert.equal(bundled.markdownToSafeHtml(input), markdownToSafeHtml(input));
  assert.equal(bundled.renderLessonHtml(structuredRecord("safe-001").lesson), renderLessonHtml(structuredRecord("safe-001").lesson));
});

test("shared renderer build refreshes dist and Edge modules deterministically", async () => {
  const first = await buildSharedRender();
  const firstDist = fs.readFileSync(outfile);
  const firstEdge = fs.readFileSync(edgeOutfile);
  const firstHash = sha256(firstDist);

  const second = await buildSharedRender();
  const secondDist = fs.readFileSync(outfile);
  const secondEdge = fs.readFileSync(edgeOutfile);

  assert.equal(first.outfile, outfile);
  assert.equal(first.edgeOutfile, edgeOutfile);
  assert.equal(second.outfile, outfile);
  assert.equal(second.edgeOutfile, edgeOutfile);
  assert.equal(firstHash, sha256(secondDist));
  assert.deepEqual(firstDist, firstEdge);
  assert.deepEqual(secondDist, secondEdge);
});

test("actual Edge shared renderer includes private snapshot mail metadata", async () => {
  await buildSharedRender();
  const sharedUrl = pathToFileURL(path.resolve(__dirname, "../supabase/functions/_shared/render.mjs"));
  sharedUrl.search = `v=${Date.now()}`;
  const shared = await import(sharedUrl.href);
  const snapshotId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const mail = shared.renderMailFromSnapshot({
    snapshotId,
    date: "2026-09-15",
    round: 3,
    dayOrdinal: 42,
    kind: "test",
    lesson: structuredRecord("safe-001").lesson
  });

  assert.equal(typeof shared.renderMailFromSnapshot, "function");
  assert.match(mail.html, /테스트 발송 · 2026-09-15 · 3회차 · 42번째 글/);
  assert.match(mail.html, /https:\/\/donggeonha\.github\.io\/Daily_CS\/\?snapshot=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/);
  assert.match(mail.text, /웹에서 보기: https:\/\/donggeonha\.github\.io\/Daily_CS\/\?snapshot=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/);
  assert.match(mail.html, /data-section="question"/);
  assert.match(mail.text, /꼬리 질문:/);
});

test("mail snapshot renderer returns safe html and text with markdown generics preserved", () => {
  const mail = renderMailFromSnapshot({
    id: "snapshot-1",
    title: "메일 렌더",
    documentKind: "markdown",
    document: {
      markdown: [
        "# 메일 렌더",
        "",
        "```java",
        "List<String> values = new ArrayList<>();",
        "```",
        "",
        "[bad](javascript:alert(1))"
      ].join("\n")
    }
  });

  assert.equal(mail.subject, "[Daily CS] 메일 렌더");
  assert.match(mail.html, /List&lt;String&gt; values = new ArrayList&lt;&gt;\(\);/);
  assert.doesNotMatch(mail.html, /javascript:/i);
  assert.match(mail.text, /List<String> values = new ArrayList<>\(\);/);
});

test("mail snapshot renderer includes metadata link and all structured sections in html and text", () => {
  const lesson = structuredRecord("safe-001").lesson;
  const mail = renderMailFromSnapshot({
    id: "snapshot id/with spaces?and=chars",
    date: "2026-09-15",
    cycle: 2,
    ordinal: 37,
    kind: "test",
    lesson
  });

  assert.match(mail.html, /테스트 발송 · 2026-09-15 · 2회차 · 37번째 글/);
  assert.match(mail.html, /https:\/\/donggeonha\.github\.io\/Daily_CS\/\?snapshot=snapshot%20id%2Fwith%20spaces%3Fand%3Dchars/);
  assert.match(mail.html, /data-section="question"/);
  assert.match(mail.html, /data-section="core"/);
  assert.match(mail.html, /data-section="comparison"/);
  assert.match(mail.html, /data-section="example"/);
  assert.match(mail.html, /data-section="answer"/);
  assert.match(mail.html, /data-section="pitfalls"/);
  assert.match(mail.html, /data-section="followups"/);
  assert.match(mail.html, /data-section="quiz"/);
  assert.match(mail.html, /data-section="sources"/);
  assert.match(mail.html, /<strong>정답:<\/strong>/);

  for (const expected of [
    "테스트 발송 · 2026-09-15 · 2회차 · 37번째 글",
    "웹에서 보기: https://donggeonha.github.io/Daily_CS/?snapshot=snapshot%20id%2Fwith%20spaces%3Fand%3Dchars",
    "면접 질문:",
    "핵심 설명:",
    "비교표:",
    "예시:",
    "1분 답변:",
    "주의할 점:",
    "꼬리 질문:",
    "퀴즈:",
    "정답: 1. A",
    "출처:",
    "버전 참고:"
  ]) {
    assert.match(mail.text, new RegExp(escapeRegExp(expected)));
  }
});

test("mail snapshot renderer inlines mobile-safe styles within byte budget", () => {
  const record = structuredRecord("long-mail-001");
  const lesson = record.lesson;
  lesson.document.summary = "긴 한국어 요약 ".repeat(80);
  lesson.document.explanation = [
    "긴 한국어 본문은 모바일 메일 앱에서 줄바꿈이 자연스러워야 합니다. ".repeat(120)
  ];
  lesson.document.example.code = [
    "Map<String, List<CompletionStage<AccountLedgerEntry>>> ledgerEntriesByAccount = new ConcurrentHashMap<>();",
    "String veryLongToken = \"",
    "가나다라마바사아자차카타파하".repeat(120),
    "\";"
  ].join("");
  lesson.document.comparison.rows = Array.from({ length: 8 }, (_value, index) => [
    `긴 비교 항목 ${index + 1}`,
    "메일 표 셀은 좁은 폭에서도 테두리와 여백이 유지되어야 합니다. ".repeat(8)
  ]);

  const mail = renderMailFromSnapshot({
    id: "long-mail-snapshot",
    date: "2026-09-15",
    ordinal: 375,
    lesson
  });

  assert(Buffer.byteLength(mail.html, "utf8") < 120_000);
  assert.match(mail.html, /data-mail-wrapper="daily-cs"/);
  assert.match(mail.html, /max-width:720px/);
  assert.match(mail.html, /font-size:16px/);
  assert.match(mail.html, /line-height:1\.75/);
  assert.match(mail.html, /white-space:pre-wrap/);
  assert.match(mail.html, /overflow-wrap:anywhere/);
  assert.match(mail.html, /border-collapse:collapse/);
  assert.match(mail.html, /padding:8px/);
  assert.doesNotMatch(mail.html, /<style\b/i);
  assert.match(mail.html, /Map&lt;String, List&lt;CompletionStage&lt;AccountLedgerEntry&gt;&gt;&gt;/);
});

test("lesson validation accepts mock records and rejects malformed imports", () => {
  assert.deepEqual(validateLessonRecord(structuredRecord("safe-001")), []);

  const errors = validateImportPayload({ lessons: [{}] });

  assert(errors.some((error) => error.includes("title")));
  assert(errors.some((error) => error.includes("category")));
});

test("lesson validation supports v2 ids, optional legacy metadata, and partial drafts", () => {
  const record = structuredRecord("uuid-record");
  record.lesson.document.id = "0ed0b744-9f30-4582-8ffc-14fcbfd2d7e7";
  record.lesson.document.order = 900;
  record.lesson.document.week = 90;

  assert.deepEqual(validateLessonRecord(record), []);

  delete record.lesson.document.id;
  delete record.lesson.document.order;
  delete record.lesson.document.week;

  assert.deepEqual(validateLessonRecord(record), []);
  assert.deepEqual(validateLessonRecord({
    state: "draft",
    lesson: {
      documentKind: "structured",
      document: {}
    }
  }), []);
  assert.deepEqual(validateLessonRecord({
    state: "draft",
    lesson: {
      documentKind: "markdown",
      document: {}
    }
  }), []);
});

test("backend LessonDetail markdown shape rejects raw HTML outside fenced code", () => {
  const errors = validateImportPayload({
    lessons: [{
      id: "lsn-md",
      legacyId: 2,
      state: "draft",
      title: "Markdown",
      category: "database",
      documentKind: "markdown",
      document: { markdown: "Safe\n\n<script>alert(1)</script>" }
    }]
  });

  assert(errors.some((error) => /raw html/i.test(error)));
});

test("markdown text renderer preserves code fenced Java generics", () => {
  const text = renderLessonText({
    documentKind: "markdown",
    document: { markdown: "```java\nList<String> values = new ArrayList<>();\n```" }
  });

  assert.equal(text, "List<String> values = new ArrayList<>();");
});

function structuredRecord(id) {
  return {
    id,
    state: "published",
    draftRevision: 3,
    publishedRevision: 3,
    lesson: {
      id,
      legacyId: 1,
      state: "published",
      title: "합성 트랜잭션 격리 노트",
      category: "database",
      documentKind: "structured",
      document: {
        id: "001",
        order: 1,
        week: 1,
        track: "common",
        category: "database",
        level: "foundation",
        title: "합성 트랜잭션 격리 노트",
        summary: "테스트용 원장 변경 예시입니다.",
        keywords: ["트랜잭션", "격리"],
        question: "무엇을 보장해야 하나요?",
        explanation: ["함께 성공하거나 실패합니다."],
        example: { language: "java", description: "제네릭 예시", code: "List<String> values = new ArrayList<>();" },
        answer: "모두 반영되거나 모두 취소됩니다.",
        pitfalls: ["부분 성공을 조심합니다."],
        followUps: [{ question: "왜 필요한가요?", answer: "정합성을 위해서입니다." }],
        quiz: { question: "정답은?", choices: ["A", "B"], answerIndex: 0, explanation: "A입니다." },
        sources: [{ title: "Synthetic", url: "https://example.com", note: "테스트" }],
        versionNote: "합성 데이터입니다.",
        comparison: { headers: ["상황", "기준"], rows: [["조회", "일관성"]] }
      }
    }
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
