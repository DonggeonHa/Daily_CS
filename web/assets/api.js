export const OWNER_API_PATH = "/functions/v1/owner-api";

export const ACTIONS = Object.freeze({
  settingsGet: "settings.get",
  settingsUpdate: "settings.update",
  dashboardGet: "dashboard.get",
  lessonList: "lesson.list",
  lessonGet: "lesson.get",
  lessonCreate: "lesson.create",
  lessonSaveDraft: "lesson.saveDraft",
  lessonPublish: "lesson.publish",
  lessonUnpublish: "lesson.unpublish",
  lessonRestoreRevision: "lesson.restoreRevision",
  lessonMoveToTrash: "lesson.moveToTrash",
  lessonRestoreTrash: "lesson.restoreTrash",
  lessonDuplicate: "lesson.duplicate",
  lessonBulkUpdateState: "lesson.bulkUpdateState",
  lessonPurge: "lesson.purge",
  revisionList: "revision.list",
  revisionGet: "revision.get",
  scheduleGet: "schedule.get",
  scheduleSetOverride: "schedule.setOverride",
  scheduleRebuildFuture: "schedule.rebuildFuture",
  readerToday: "reader.today",
  readerSnapshot: "reader.snapshot",
  readerHistory: "reader.history",
  readerSearch: "reader.search",
  mailStatus: "mail.status",
  mailEnqueueTest: "mail.enqueueTest",
  mailRetryUncertain: "mail.retryUncertain",
  importPreview: "import.preview",
  importCommit: "import.commit",
  exportCreate: "export.create",
  backupRestore: "backup.restore"
});

export class DailyCsApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "DailyCsApiError";
    this.code = code;
    this.status = status;
  }
}

export function createOwnerApi(options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (typeof fetchImpl !== "function") throw new Error("fetch is not available");
  const endpoint = new URL(options.path ?? OWNER_API_PATH, options.origin ?? globalThis.location?.origin ?? "https://donggeonha.github.io").href;

  async function action(name, payload = {}) {
    const token = await options.getAccessToken();
    if (!token) throw new DailyCsApiError("unauthorized", "owner login required", 401);
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ action: name, payload })
    });
    const envelope = await response.json().catch(() => ({}));
    if (!response.ok || envelope.error) {
      throw new DailyCsApiError(
        envelope.error?.code ?? String(response.status),
        envelope.error?.message ?? "owner action failed",
        response.status
      );
    }
    return envelope.data ?? {};
  }

  return { action };
}

export function lessonRevision(lesson) {
  return Number(
    lesson?.rowRevision ??
    lesson?.row_revision ??
    lesson?.revision ??
    lesson?.draftRevision ??
    lesson?.draft_revision ??
    lesson?.publishedRevision ??
    lesson?.published_revision ??
    0
  );
}

export function normalizeLesson(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    ...raw,
    id: raw.id,
    legacyId: raw.legacyId ?? raw.legacy_id ?? null,
    state: raw.state ?? "draft",
    title: raw.title ?? raw.draft_document?.title ?? raw.document?.title ?? "",
    category: raw.category ?? raw.draft_document?.category ?? raw.document?.category ?? "database",
    documentKind: raw.documentKind ?? raw.document_kind ?? "structured",
    draftDocument: raw.draftDocument ?? raw.draft_document ?? raw.document ?? {},
    publishedRevision: raw.publishedRevision ?? raw.published_revision ?? null,
    draftRevision: raw.draftRevision ?? raw.draft_revision ?? null,
    rowRevision: lessonRevision(raw),
    updatedAt: raw.updatedAt ?? raw.updated_at ?? ""
  };
}

export function normalizeRevision(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    ...raw,
    id: raw.id,
    lessonId: raw.lessonId ?? raw.lesson_id,
    revisionNumber: raw.revisionNumber ?? raw.revision_number,
    documentKind: raw.documentKind ?? raw.document_kind,
    contentHash: raw.contentHash ?? raw.content_hash,
    createdAt: raw.createdAt ?? raw.created_at,
    createdBy: raw.createdBy ?? raw.created_by,
    document: raw.document ?? {}
  };
}

export function documentForRender(lesson) {
  const normalized = normalizeLesson(lesson);
  if (!normalized) return null;
  const document = normalized.draftDocument ?? {};
  if (normalized.documentKind === "markdown") {
    return {
      id: normalized.legacyId ? String(normalized.legacyId).padStart(3, "0") : normalized.id,
      legacyAlias: normalized.legacyId,
      category: normalized.category,
      title: normalized.title,
      summary: document.summary ?? "",
      keywords: Array.isArray(document.keywords) ? document.keywords : [],
      track: document.track ?? "common",
      level: document.level ?? "foundation",
      week: document.week ?? "",
      versionNote: document.versionNote ?? "",
      sources: Array.isArray(document.sources) ? document.sources : [],
      document: { kind: "markdown", markdown: document.markdown ?? "" }
    };
  }
  return {
    ...document,
    id: document.id ?? (normalized.legacyId ? String(normalized.legacyId).padStart(3, "0") : normalized.id),
    legacyAlias: normalized.legacyId,
    category: normalized.category,
    title: normalized.title,
    summary: document.summary ?? "",
    keywords: Array.isArray(document.keywords) ? document.keywords : [],
    track: document.track ?? "common",
    level: document.level ?? "foundation",
    week: document.week ?? "",
    explanation: Array.isArray(document.explanation) ? document.explanation : [],
    pitfalls: Array.isArray(document.pitfalls) ? document.pitfalls : [],
    followUps: Array.isArray(document.followUps) ? document.followUps : [],
    sources: Array.isArray(document.sources) ? document.sources : []
  };
}


