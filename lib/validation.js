const CATEGORIES = new Set([
  "os-architecture",
  "network-security",
  "database",
  "algorithms",
  "java-spring",
  "financial-transactions",
  "financial-operations",
  "review"
]);

const TRACKS = new Set(["common", "finance", "review"]);
const LEVELS = new Set(["foundation", "applied", "advanced"]);
const STATES = new Set(["draft", "published", "trash"]);
const DOCUMENT_KINDS = new Set(["structured", "markdown"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function pushTextError(errors, field, value) {
  if (!hasText(value)) errors.push(`${field} must be a non-empty string`);
}

function documentFromLessonDetail(value) {
  if (isObject(value) && DOCUMENT_KINDS.has(value.documentKind)) {
    return { kind: value.documentKind, document: value.document ?? {}, detail: value };
  }
  if (isObject(value?.document) && value.document.kind === "markdown") {
    return { kind: "markdown", document: value.document, detail: value };
  }
  return { kind: "structured", document: value ?? {}, detail: value ?? {} };
}

function validateStructuredLesson(lesson, options = {}) {
  const errors = [];
  if (!isObject(lesson)) return ["lesson must be an object"];
  if (!options.allowDraftPartial) {
    pushTextError(errors, "title", lesson.title);
    pushTextError(errors, "summary", lesson.summary);
    pushTextError(errors, "question", lesson.question);
    pushTextError(errors, "answer", lesson.answer);
    pushTextError(errors, "versionNote", lesson.versionNote);
  }
  if (lesson.id !== undefined && !hasText(lesson.id)) errors.push("id must be a non-empty string when provided");
  if (lesson.order !== undefined && (!Number.isInteger(lesson.order) || lesson.order < 1)) errors.push("order must be a positive integer when provided");
  if (lesson.week !== undefined && (!Number.isInteger(lesson.week) || lesson.week < 1)) errors.push("week must be a positive integer when provided");
  if (!options.allowDraftPartial && !CATEGORIES.has(lesson.category)) errors.push("category is not allowed");
  if (options.allowDraftPartial && lesson.category !== undefined && !CATEGORIES.has(lesson.category)) errors.push("category is not allowed");
  if (lesson.track !== undefined && !TRACKS.has(lesson.track)) errors.push("track is not allowed");
  if (lesson.level !== undefined && !LEVELS.has(lesson.level)) errors.push("level is not allowed");
  if (
    (!options.allowDraftPartial && !Array.isArray(lesson.keywords)) ||
    (Array.isArray(lesson.keywords) && ((!options.allowDraftPartial && lesson.keywords.length < 1) || lesson.keywords.some((item) => !hasText(item)))) ||
    (options.allowDraftPartial && lesson.keywords !== undefined && !Array.isArray(lesson.keywords))
  ) {
    errors.push("keywords must contain text");
  }
  if (!options.allowDraftPartial && (!Array.isArray(lesson.explanation) || lesson.explanation.length < 1 || lesson.explanation.some((item) => !hasText(item)))) {
    errors.push("explanation must contain text");
  }
  if (!options.allowDraftPartial && (!isObject(lesson.example) || !hasText(lesson.example.description) || !hasText(lesson.example.code))) {
    errors.push("example must contain description and code");
  }
  if (!options.allowDraftPartial && (!Array.isArray(lesson.pitfalls) || lesson.pitfalls.some((item) => !hasText(item)))) {
    errors.push("pitfalls must be text items");
  }
  if (!options.allowDraftPartial && (!Array.isArray(lesson.followUps) || lesson.followUps.some((item) => !isObject(item) || !hasText(item.question) || !hasText(item.answer)))) {
    errors.push("followUps must contain question and answer text");
  }
  if (!options.allowDraftPartial && (!isObject(lesson.quiz) || !hasText(lesson.quiz.question) || !Array.isArray(lesson.quiz.choices))) {
    errors.push("quiz must contain question and choices");
  } else if (isObject(lesson.quiz) && Array.isArray(lesson.quiz.choices) && (!Number.isInteger(lesson.quiz.answerIndex) || lesson.quiz.answerIndex < 0 || lesson.quiz.answerIndex >= lesson.quiz.choices.length)) {
    errors.push("quiz.answerIndex must point to a choice");
  }
  if (!options.allowDraftPartial && (!Array.isArray(lesson.sources) || lesson.sources.length < 1)) {
    errors.push("sources must contain at least one source");
  } else if (Array.isArray(lesson.sources)) {
    lesson.sources.forEach((source, index) => {
      if (!isObject(source) || !hasText(source.title) || !hasText(source.note) || !isUrl(source.url)) {
        errors.push(`sources[${index}] must contain title, note, and http(s) url`);
      }
    });
  }
  if (lesson.comparison !== undefined) {
    if (!isObject(lesson.comparison)) {
      errors.push("comparison must be an object");
    } else if (!Array.isArray(lesson.comparison.headers) || !Array.isArray(lesson.comparison.rows)) {
      errors.push("comparison must contain headers and rows arrays");
    }
  }
  return errors;
}

function validateMarkdownLesson(lesson, options = {}) {
  const errors = [];
  if (!isObject(lesson)) return ["lesson must be an object"];
  const document = lesson.documentKind === "markdown" ? lesson.document : lesson.document?.kind === "markdown" ? lesson.document : lesson;
  if (!options.allowDraftPartial) {
    pushTextError(errors, "title", lesson.title);
    pushTextError(errors, "summary", lesson.summary);
  }
  if (lesson.id !== undefined && !hasText(lesson.id)) errors.push("id must be a non-empty string when provided");
  if (!isObject(document)) {
    errors.push("document.markdown must contain Markdown text");
  } else if (!options.allowDraftPartial && !hasText(document.markdown)) {
    errors.push("document.markdown must contain Markdown text");
  } else if (hasText(document.markdown) && containsUnsafeRawHtml(document.markdown)) {
    errors.push("document.markdown contains unsafe raw html");
  }
  if (!options.allowDraftPartial && !CATEGORIES.has(lesson.category)) errors.push("category is not allowed");
  if (options.allowDraftPartial && lesson.category !== undefined && !CATEGORIES.has(lesson.category)) errors.push("category is not allowed");
  if (lesson.track !== undefined && !TRACKS.has(lesson.track)) errors.push("track is not allowed");
  if (lesson.level !== undefined && !LEVELS.has(lesson.level)) errors.push("level is not allowed");
  if (lesson.keywords !== undefined && (!Array.isArray(lesson.keywords) || lesson.keywords.some((item) => !hasText(item)))) errors.push("keywords must be text items");
  return errors;
}

function containsUnsafeRawHtml(markdown) {
  const withoutFences = String(markdown ?? "").replace(/```[\s\S]*?```/g, "");
  return /<\s*(script|style|iframe|object|embed|form|input|img|svg|math|video|audio|link|meta)\b/i.test(withoutFences) ||
    /\s+on[a-z]+\s*=/i.test(withoutFences) ||
    /javascript\s*:/i.test(withoutFences);
}

function validateLessonRecord(record) {
  const errors = [];
  if (!isObject(record)) return ["record must be an object"];
  if (!STATES.has(record.state)) errors.push("state must be draft, published, or trash");
  if (record.state !== "draft") pushTextError(errors, "record.id", record.id);
  if (record.state === "draft" && record.id !== undefined && !hasText(record.id)) errors.push("record.id must be a non-empty string when provided");
  if (record.draftRevision !== undefined && (!Number.isInteger(record.draftRevision) || record.draftRevision < 1)) errors.push("draftRevision must be positive");
  if (record.publishedRevision !== undefined && record.publishedRevision !== null && (!Number.isInteger(record.publishedRevision) || record.publishedRevision < 1)) errors.push("publishedRevision must be positive");
  const lesson = record.lesson ?? record;
  const normalized = documentFromLessonDetail(lesson);
  const allowDraftPartial = record.state === "draft";
  const contentErrors = normalized.kind === "markdown"
    ? validateMarkdownLesson(lesson, { allowDraftPartial })
    : validateStructuredLesson(normalized.document, { allowDraftPartial });
  return errors.concat(contentErrors.map((error) => `lesson.${error}`));
}

function validateImportPayload(payload) {
  if (!isObject(payload)) return ["payload must be an object"];
  if (Array.isArray(payload.lessons)) {
    return payload.lessons.flatMap((lesson, index) => {
      const normalized = documentFromLessonDetail(lesson);
      const errors = normalized.kind === "markdown" ? validateMarkdownLesson(lesson) : validateStructuredLesson(normalized.document);
      return errors.map((error) => `lessons[${index}].${error}`);
    });
  }
  if (Array.isArray(payload.records)) {
    return payload.records.flatMap((record, index) => validateLessonRecord(record).map((error) => `records[${index}].${error}`));
  }
  return ["payload.lessons must be an array"];
}

function publicLesson(record) {
  return {
    id: record.id,
    legacyAlias: record.lesson.legacyAlias,
    category: record.lesson.category,
    level: record.lesson.level,
    title: record.lesson.title,
    summary: record.lesson.summary,
    keywords: record.lesson.keywords,
    publishedAt: record.publishedAt,
    updatedAt: record.updatedAt,
    version: record.version
  };
}

module.exports = {
  CATEGORIES,
  DOCUMENT_KINDS,
  LEVELS,
  STATES,
  TRACKS,
  documentFromLessonDetail,
  publicLesson,
  validateImportPayload,
  validateLessonRecord,
  validateMarkdownLesson,
  validateStructuredLesson
};
