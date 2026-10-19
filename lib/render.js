const { escapeHtml, markdownToSafeHtml, markdownToText, safeHref } = require("./markdown-renderer.js");
const { validateVisuals, renderVisualFrameHtml, renderVisualsHtml } = require("./visuals.js");

const SECTION_TITLES = {
  question: "면접 질문",
  core: "핵심 설명",
  comparison: "비교표",
  example: "예시",
  answer: "1분 답변",
  pitfalls: "주의할 점",
  followups: "꼬리 질문",
  quiz: "퀴즈",
  sources: "출처"
};

const CATEGORY_LABELS = {
  "os-architecture": "OS/아키텍처",
  "network-security": "네트워크/보안",
  database: "데이터베이스",
  algorithms: "알고리즘",
  "java-spring": "Java/Spring",
  "financial-transactions": "금융 거래",
  "financial-operations": "금융 운영",
  review: "종합 복습"
};

const TRACK_LABELS = { common: "공통 CS", finance: "금융 CS", review: "종합 복습" };
const LEVEL_LABELS = { foundation: "기초", applied: "응용", advanced: "심화" };

const EMAIL_STYLES = {
  wrapper: [
    "max-width:720px",
    "margin:0 auto",
    "padding:24px 16px",
    "background:#FFFCF6",
    "color:#1E241F",
    "font-family:system-ui,-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic','Noto Sans KR',sans-serif",
    "font-size:16px",
    "line-height:1.75"
  ].join(";"),
  meta: "margin:0 0 8px;color:#667064;font-size:14px;line-height:1.6",
  link: "color:#1F5B3F;text-decoration:underline;text-underline-offset:2px",
  article: "max-width:720px;margin:0 auto",
  pre: [
    "white-space:pre-wrap",
    "overflow-wrap:anywhere",
    "word-break:break-word",
    "background:#F0EADF",
    "border:1px solid #DDD5C7",
    "border-radius:10px",
    "padding:12px",
    "margin:12px 0 20px",
    "font-size:13px",
    "line-height:1.6"
  ].join(";"),
  code: [
    "white-space:pre-wrap",
    "overflow-wrap:anywhere",
    "word-break:break-word",
    "font-family:'SFMono-Regular',Consolas,'Liberation Mono',monospace",
    "font-size:13px",
    "line-height:1.6"
  ].join(";"),
  table: [
    "width:100%",
    "border-collapse:collapse",
    "margin:16px 0",
    "font-size:14px",
    "line-height:1.6"
  ].join(";"),
  cell: "border:1px solid #DDD5C7;padding:8px;vertical-align:top;text-align:left"
};

function decorateEmailHtml(html) {
  return String(html ?? "")
    .replace(/<article class="lesson"/g, `<article class="lesson" style="${EMAIL_STYLES.article}"`)
    .replace(/<pre><code>/g, `<pre style="${EMAIL_STYLES.pre}"><code style="${EMAIL_STYLES.code}">`)
    .replace(/<table(\s[^>]*)?>/g, (_match, attrs = "") => `<table${attrs} style="${EMAIL_STYLES.table}">`)
    .replace(/<th scope="col">/g, `<th scope="col" style="${EMAIL_STYLES.cell}">`)
    .replace(/<td>/g, `<td style="${EMAIL_STYLES.cell}">`);
}


function list(items, mapper) {
  return (items ?? []).map((item, index) => `<li>${mapper(item, index)}</li>`).join("");
}

function section(name, body) {
  return `<section data-section="${name}"><h2>${SECTION_TITLES[name]}</h2>${body}</section>`;
}

function lessonDocument(lesson) {
  if (lesson?.documentKind === "markdown") return { kind: "markdown", document: lesson.document ?? {} };
  if (lesson?.documentKind === "structured") return { kind: "structured", document: lesson.document ?? {} };
  if (lesson?.document?.kind === "markdown") return { kind: "markdown", document: lesson.document };
  if (lesson?.document?.kind === "structured") return { kind: "structured", document: lesson.document };
  return { kind: "structured", document: lesson ?? {} };
}

function displayLesson(lesson) {
  const wrapped = lessonDocument(lesson);
  const document = wrapped.document;
  if (wrapped.kind === "markdown") {
    return {
      id: lesson.id ?? lesson.legacyId ?? "",
      legacyId: lesson.legacyId,
      category: lesson.category,
      title: lesson.title ?? document.title ?? "",
      summary: lesson.summary ?? document.summary ?? "",
      keywords: lesson.keywords ?? document.keywords ?? [],
      documentKind: "markdown",
      document
    };
  }
  return {
    ...document,
    id: document.id ?? lesson.id ?? "",
    legacyId: lesson.legacyId ?? document.legacyId,
    category: document.category ?? lesson.category,
    title: document.title ?? lesson.title ?? "",
    summary: document.summary ?? lesson.summary ?? "",
    keywords: document.keywords ?? lesson.keywords ?? []
  };
}

function structuredBody(lesson, options) {
  const email = Boolean(options.email);
  const followUps = email
    ? list(lesson.followUps, (item) => `<strong>${escapeHtml(item.question)}</strong><p>${escapeHtml(item.answer)}</p>`)
    : list(lesson.followUps, (item) => `<details><summary>${escapeHtml(item.question)}</summary><p>${escapeHtml(item.answer)}</p></details>`);
  const quiz = lesson.quiz ?? { question: "", choices: [], answerIndex: 0, explanation: "" };
  const answerChoice = quiz.choices?.[quiz.answerIndex] ?? "";
  const quizChoices = list(quiz.choices, (choice, index) => `<span${index === quiz.answerIndex ? ' data-answer="true"' : ""}>${escapeHtml(choice)}</span>`);
  const quizAnswer = email
    ? `<p><strong>정답:</strong> ${escapeHtml(String(quiz.answerIndex + 1))}. ${escapeHtml(answerChoice)}</p><p>${escapeHtml(quiz.explanation)}</p>`
    : `<details class="quiz-answer"><summary>정답 보기</summary><p>정답: ${escapeHtml(String(quiz.answerIndex + 1))}. ${escapeHtml(answerChoice)}</p><p>${escapeHtml(quiz.explanation)}</p></details>`;
  const comparison = lesson.comparison
    ? section("comparison", `<table class="lesson-comparison" role="table"><thead><tr>${list(lesson.comparison.headers, (header) => `<th scope="col">${escapeHtml(header)}</th>`)}</tr></thead><tbody>${(lesson.comparison.rows ?? []).map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`)
    : "";
  const sourceList = list(lesson.sources, (source) => {
    const href = safeHref(source.url);
    const title = escapeHtml(source.title);
    const link = href
      ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer" target="_blank">${title}</a>`
      : title;
    return `${link}<span> - ${escapeHtml(source.note)}</span>`;
  });
  return [
    section("question", `<p>${escapeHtml(lesson.question)}</p>`),
    section("core", (lesson.explanation ?? []).map((item) => `<p>${escapeHtml(item)}</p>`).join("")),
    comparison,
    section("example", `<p>${escapeHtml(lesson.example?.description)}</p><pre><code>${escapeHtml(lesson.example?.code)}</code></pre>`),
    section("answer", `<p>${escapeHtml(lesson.answer)}</p>`),
    section("pitfalls", `<ul>${list(lesson.pitfalls, escapeHtml)}</ul>`),
    section("followups", `<ul>${followUps}</ul>`),
    section("quiz", `<p>${escapeHtml(quiz.question)}</p><ol>${quizChoices}</ol>${quizAnswer}`),
    section("sources", `<ul>${sourceList}</ul><p><strong>버전 참고:</strong> ${escapeHtml(lesson.versionNote)}</p>`)
  ].join("");
}

function renderLessonHtml(lesson, options = {}) {
  const content = displayLesson(lesson);
  const wrapped = lessonDocument(lesson);
  const metadata = [
    content.legacyId ? `${escapeHtml(String(content.legacyId).padStart(3, "0"))}번` : "",
    content.week ? `${escapeHtml(content.week)}주차` : "",
    CATEGORY_LABELS[content.category] ?? content.category,
    TRACK_LABELS[content.track] ?? content.track,
    LEVEL_LABELS[content.level] ?? content.level
  ].filter(Boolean).join(" · ");
  const body = wrapped.kind === "markdown"
    ? markdownToSafeHtml(wrapped.document.markdown, options)
    : structuredBody(content, options);
  return [
    `<article class="lesson" data-lesson-id="${escapeHtml(content.id)}">`,
    '<header data-section="overview">',
    `<p class="lesson-meta">${metadata}</p>`,
    `<h1>${escapeHtml(content.title)}</h1>`,
    `<p class="summary">${escapeHtml(content.summary)}</p>`,
    `<ul class="keywords">${list(content.keywords, escapeHtml)}</ul>`,
    "</header>",
    body,
    renderVisualsHtml(wrapped.document.visuals ?? lesson.visuals, options),
    "</article>"
  ].join("");
}

function renderLessonText(lesson) {
  const content = displayLesson(lesson);
  const wrapped = lessonDocument(lesson);
  const visualText = (wrapped.document.visuals ?? lesson.visuals ?? []).map((visual) => `${visual.title}\n${visual.description}\n${visual.alt}`).join("\n\n");
  if (wrapped.kind === "markdown") {
    return [markdownToText(wrapped.document.markdown), visualText].filter(Boolean).join("\n\n");
  }
  const quiz = content.quiz ?? { question: "", choices: [], answerIndex: 0, explanation: "" };
  const answerChoice = quiz.choices?.[quiz.answerIndex] ?? "";
  const comparison = content.comparison
    ? [
      "비교표:",
      (content.comparison.headers ?? []).join(" | "),
      ...(content.comparison.rows ?? []).map((row) => row.join(" | "))
    ].filter(Boolean).join("\n")
    : "";
  return [
    content.title,
    "",
    content.summary,
    "",
    `면접 질문: ${content.question}`,
    "",
    "핵심 설명:",
    (content.explanation ?? []).join("\n\n"),
    "",
    comparison,
    comparison ? "" : null,
    "예시:",
    content.example?.description,
    content.example?.code,
    "",
    `1분 답변: ${content.answer}`,
    "",
    "주의할 점:",
    (content.pitfalls ?? []).map((item) => `- ${item}`).join("\n"),
    "",
    "꼬리 질문:",
    (content.followUps ?? []).map((item) => `- ${item.question}\n  ${item.answer}`).join("\n"),
    "",
    "퀴즈:",
    quiz.question,
    (quiz.choices ?? []).map((choice, index) => `${index + 1}. ${choice}`).join("\n"),
    `정답: ${Number(quiz.answerIndex ?? 0) + 1}. ${answerChoice}`,
    quiz.explanation,
    "",
    "출처:",
    (content.sources ?? []).map((source) => `- ${source.title}: ${source.url} (${source.note})`).join("\n"),
    content.versionNote ? `버전 참고: ${content.versionNote}` : "",
    ...(visualText ? ["", visualText] : [])
  ].filter((line) => line !== null && line !== undefined).join("\n");
}

function snapshotLesson(snapshot) {
  const lesson = snapshot?.lesson ?? snapshot ?? {};
  const documentKind = lesson.documentKind ?? snapshot?.documentKind;
  const document = lesson.document ?? snapshot?.document ?? {};
  return {
    ...lesson,
    id: lesson.id ?? snapshot?.lessonId ?? snapshot?.id ?? "",
    legacyId: lesson.legacyId ?? snapshot?.legacyId,
    category: lesson.category ?? snapshot?.category,
    title: lesson.title ?? snapshot?.title ?? document.title ?? "",
    summary: lesson.summary ?? snapshot?.summary ?? document.summary ?? "",
    keywords: lesson.keywords ?? snapshot?.keywords ?? document.keywords ?? [],
    documentKind,
    document
  };
}

function renderMailFromSnapshot(snapshot) {
  const lesson = snapshotLesson(snapshot);
  const title = lesson.title || "Daily CS";
  const meta = snapshotMailMeta(snapshot, lesson);
  const metadataHtml = [
    '<section data-section="mail-meta">',
    `<p class="lesson-meta" style="${EMAIL_STYLES.meta}">${escapeHtml(meta.label)}</p>`,
    `<p style="${EMAIL_STYLES.meta}"><a href="${escapeHtml(meta.webUrl)}" rel="noopener noreferrer" target="_blank" style="${EMAIL_STYLES.link}">웹에서 보기</a></p>`,
    "</section>"
  ].join("");
  const metadataText = [meta.label, `웹에서 보기: ${meta.webUrl}`].filter(Boolean).join("\n");
  const lessonHtml = decorateEmailHtml(renderLessonHtml(lesson, { email: true }));
  return {
    subject: `[Daily CS] ${title}`,
    html: `<div data-mail-wrapper="daily-cs" style="${EMAIL_STYLES.wrapper}">${metadataHtml}${lessonHtml}</div>`,
    text: `${metadataText}\n\n${renderLessonText(lesson)}`
  };
}
function snapshotMailMeta(snapshot, lesson) {
  const snapshotId = snapshot?.snapshotId ?? snapshot?.snapshot_id ?? snapshot?.id ?? "";
  const date = snapshot?.date ?? snapshot?.snapshotDate ?? snapshot?.snapshot_date ?? snapshot?.scheduledDate ?? snapshot?.scheduled_date ?? "";
  const cycle = snapshot?.cycle ?? snapshot?.round ?? snapshot?.roundNumber ?? snapshot?.round_number ?? "";
  const ordinal = snapshot?.ordinal ?? snapshot?.dayOrdinal ?? snapshot?.day_ordinal ?? "";
  const isTest = snapshot?.kind === "test" || snapshot?.test === true || snapshot?.isTest === true;
  const label = [
    isTest ? "테스트 발송" : "",
    date,
    cycle ? `${cycle}회차` : "",
    ordinal ? `${ordinal}번째 글` : ""
  ].filter(Boolean).join(" · ");
  return {
    label: label || "Daily CS",
    webUrl: snapshotWebUrl(snapshotId, date, lesson.id || lesson.legacyId)
  };
}

function snapshotWebUrl(snapshotId, date, lessonId) {
  const base = "https://donggeonha.github.io/Daily_CS/";
  if (snapshotId) return `${base}?snapshot=${encodeURIComponent(String(snapshotId))}`;
  if (date) return `${base}?date=${encodeURIComponent(String(date))}`;
  if (lessonId) return `${base}?lesson=${encodeURIComponent(String(lessonId))}`;
  return base;
}

module.exports = {
  CATEGORY_LABELS,
  LEVEL_LABELS,
  SECTION_TITLES,
  TRACK_LABELS,
  escapeHtml,
  markdownToSafeHtml,
  markdownToText,
  lessonDocument,
  renderLessonHtml,
  renderLessonText,
  renderMailFromSnapshot,
  validateVisuals,
  renderVisualFrameHtml,
  renderVisualsHtml
};
