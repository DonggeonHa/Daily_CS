import { renderLessonHtml, CATEGORY_LABELS, TRACK_LABELS, LEVEL_LABELS } from "../../lib/render.js";
import { CATEGORIES, TRACKS, LEVELS } from "../../lib/validation.js";
import { mountVisualPlayers } from "./visual-player.js";
import {
  ACTIONS,
  DailyCsApiError,
  createOwnerApi,
  documentForRender,
  lessonRevision,
  normalizeLesson,
  normalizeRevision
} from "./api.js";
import {
  RETURN_URL_KEY,
  createAuthClient,
  getVerifiedSession,
  safeReturnUrl,
  signInWithGoogle,
  signOut,
  startSessionRefresh
} from "./auth.js";

const state = {
  api: null,
  auth: null,
  authGeneration: 0,
  cleanupRefresh: null,
  dashboard: null,
  importPreview: null,
  lessons: [],
  readerItems: [],
  selectedAdminId: "",
  selectedReaderKey: "",
  session: null,
  settings: null
};

const nodes = {};
const visualPlayers = new Map();
let editorVisuals;
let readerRequest = 0;
let editorRequest = 0;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindNodes();
  bindStaticOptions();
  injectOwnedControls();
  bindEvents();
  await configureProductionApp();
}

function bindNodes() {
  for (const id of [
    "auth-shell", "auth-status", "login-form", "mock-login", "workspace", "session-label",
    "local-logout", "global-logout", "reader-today", "reader-search-form", "reader-search", "reader-category",
    "reader-date", "reader-open-date", "reader-status", "lesson-paper", "reader-list", "reader-count",
    "admin-search", "admin-state", "admin-category", "admin-level", "admin-list", "new-draft", "bulk-publish", "bulk-trash", "editor-form",
    "editor-id", "editor-version", "editor-draft-revision", "editor-published-revision", "editor-state", "editor-lock",
    "editor-title", "editor-alias", "editor-legacy-id", "editor-document-id", "editor-order", "editor-week",
    "editor-version-note", "editor-summary", "editor-category",
    "editor-track", "editor-level", "editor-keywords", "structured-editor", "markdown-editor", "editor-question",
    "editor-explanation", "editor-comparison-headers", "editor-comparison-rows", "editor-example-description",
    "editor-example-code", "editor-example-language", "editor-answer", "editor-pitfalls", "editor-followups",
    "editor-quiz-question", "editor-quiz-choices", "editor-quiz-answer-index", "editor-quiz-explanation",
    "editor-sources", "editor-markdown", "publish-one", "unpublish-one", "duplicate-one", "restore-one",
    "restore-revision", "restore-trash-one", "trash-one", "purge-one", "editor-status", "json-preview",
    "preview-output", "revision-select", "history-output", "diff-output", "schedule-start", "schedule-hour",
    "schedule-override", "schedule-override-lesson-id", "schedule-override-date", "schedule-override-mode",
    "schedule-revision", "mail-paused", "save-schedule", "save-override", "rebuild-schedule", "send-test-mail",
    "ops-status", "export-json", "backup-json", "restore-backup", "import-json", "preview-import",
    "commit-import", "import-expected-hash", "json-output", "log-output", "account-output", "dashboard-summary", "operations-health"
  ]) {
    nodes[toKey(id)] = document.getElementById(id);
  }
  nodes.editorVersion ??= nodes.editorDraftRevision ?? hiddenInput("editor-version");
  nodes.editorAlias ??= nodes.editorLegacyId ?? hiddenInput("editor-alias");
  nodes.restoreOne ??= nodes.restoreRevision;
  nodes.scheduleOverride ??= nodes.scheduleOverrideLessonId;
  nodes.restoreBackup ??= nodes.backupJson;
  nodes.tabs = [...document.querySelectorAll(".tab")];
  nodes.docModes = [...document.querySelectorAll('input[name="doc-mode"]')];
}

function bindStaticOptions() {
  setOptions(nodes.readerCategory, [["", "전체 카테고리"], ...[...CATEGORIES].map((item) => [item, CATEGORY_LABELS[item] ?? item])]);
  setOptions(nodes.editorCategory, [...CATEGORIES].map((item) => [item, CATEGORY_LABELS[item] ?? item]));
  setOptions(nodes.editorTrack, [...TRACKS].map((item) => [item, TRACK_LABELS[item] ?? item]));
  setOptions(nodes.editorLevel, [...LEVELS].map((item) => [item, LEVEL_LABELS[item] ?? item]));
  setOptions(nodes.adminCategory, [["", "전체 카테고리"], ...[...CATEGORIES].map((item) => [item, CATEGORY_LABELS[item] ?? item])]);
  setOptions(nodes.adminLevel, [["", "전체 레벨"], ...[...LEVELS].map((item) => [item, LEVEL_LABELS[item] ?? item])]);
}

function injectOwnedControls() {
  if (nodes.mockLogin) nodes.mockLogin.hidden = true;
  configureLoginHint();
  nodes.editorStatus.textContent = "초안은 인증된 세션으로 자동 저장됩니다.";
  nodes.unpublishOne ??= button("게시 해제", "button");
  nodes.duplicateOne ??= button("복제", "button");
  nodes.restoreTrashOne ??= button("휴지통 복원", "button");
  nodes.bulkUnpublish ??= button("선택 게시 해제", "button");
  nodes.bulkRestoreTrash ??= button("선택 복원", "button");
  nodes.commitImport ??= button("검증 결과 커밋", "button button--primary");
  nodes.retryMail = button("불확실 메일 재발송", "button");
  nodes.downloadExport = button("내보내기 다운로드", "button");
  placeAfter(nodes.publishOne, nodes.unpublishOne, nodes.duplicateOne);
  placeAfter(nodes.trashOne, nodes.restoreTrashOne);
  nodes.bulkTrash.after(nodes.bulkUnpublish, nodes.bulkRestoreTrash);
  placeAfter(nodes.previewImport, nodes.commitImport);
  nodes.exportJson.after(nodes.downloadExport);
  nodes.sendTestMail.after(nodes.retryMail);
  nodes.commitImport.disabled = true;
}


function bindEvents() {
  window.addEventListener("pagehide", () => clearVisualPlayers());
  nodes.loginForm.addEventListener("submit", signIn);
  nodes.localLogout.addEventListener("click", () => signOutAndReset("local"));
  nodes.globalLogout.addEventListener("click", () => signOutAndReset("global"));
  nodes.tabs.forEach((tab) => tab.addEventListener("click", () => switchView(tab.dataset.view)));
  nodes.readerToday.addEventListener("click", openToday);
  nodes.readerSearchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    refreshReaderSearch();
  });
  nodes.readerSearch.addEventListener("input", debounce(refreshReaderSearch, 350));
  nodes.readerCategory.addEventListener("change", refreshReaderHistory);
  nodes.readerOpenDate.addEventListener("click", openDateSelection);
  nodes.adminSearch.addEventListener("input", renderAdminList);
  for (const filter of [nodes.adminState, nodes.adminCategory, nodes.adminLevel]) {
    filter.addEventListener("change", renderAdminList);
  }
  nodes.newDraft.addEventListener("click", createDraft);
  nodes.editorForm.addEventListener("submit", explicitSaveDraft);
  nodes.docModes.forEach((input) => input.addEventListener("change", syncDocMode));
  nodes.publishOne.addEventListener("click", () => mutateSelected(ACTIONS.lessonPublish));
  nodes.unpublishOne.addEventListener("click", () => mutateSelected(ACTIONS.lessonUnpublish));
  nodes.restoreOne.addEventListener("click", restoreSelectedRevision);
  nodes.duplicateOne.addEventListener("click", duplicateSelected);
  nodes.trashOne.addEventListener("click", () => mutateSelected(ACTIONS.lessonMoveToTrash));
  nodes.restoreTrashOne.addEventListener("click", () => mutateSelected(ACTIONS.lessonRestoreTrash));
  nodes.purgeOne.addEventListener("click", purgeSelected);
  nodes.bulkPublish.addEventListener("click", () => bulkTransition(ACTIONS.lessonPublish));
  nodes.bulkUnpublish.addEventListener("click", () => bulkTransition(ACTIONS.lessonUnpublish));
  nodes.bulkTrash.addEventListener("click", () => bulkTransition(ACTIONS.lessonMoveToTrash));
  nodes.bulkRestoreTrash.addEventListener("click", () => bulkTransition(ACTIONS.lessonRestoreTrash));
  nodes.jsonPreview.addEventListener("click", showEditorJson);
  nodes.saveSchedule.addEventListener("click", saveSchedule);
  nodes.saveOverride?.addEventListener("click", saveOverride);
  nodes.rebuildSchedule?.addEventListener("click", rebuildSchedule);
  nodes.sendTestMail.addEventListener("click", sendTestMail);
  nodes.retryMail.addEventListener("click", retryUncertainMail);
  nodes.exportJson.addEventListener("click", exportJson);
  nodes.backupJson.addEventListener("click", exportJson);
  nodes.restoreBackup?.addEventListener("click", restoreBackup);
  nodes.downloadExport.addEventListener("click", downloadJsonOutput);
  nodes.previewImport.addEventListener("click", previewImport);
  nodes.commitImport.addEventListener("click", commitImport);
  for (const input of editorInputs()) {
    input.addEventListener("input", () => {
      renderPreviewFromEditor();
      scheduleAutosave();
    });
  }
}

async function configureProductionApp() {
  const config = window.DAILY_CS_CONFIG ?? {};
  try {
    state.auth = createAuthClient(config, window.sessionStorage);
    state.api = createOwnerApi({
      getAccessToken: getAccessToken,
      origin: config.supabaseUrl
    });
  } catch (error) {
    showAuth(error.message, "error");
    failClosed();
    return;
  }
  try {
    const session = await getVerifiedSession(state.auth);
    if (!session) {
      showAuth("등록된 Google 계정으로 로그인해 주세요.", "info");
      failClosed();
      return;
    }
    state.session = session;
    const generation = state.authGeneration;
    state.cleanupRefresh = startSessionRefresh(state.auth, (session, error) => {
      if (generation === state.authGeneration) onSessionRefresh(session, error);
    });
    await verifyOwnerAndEnter();
  } catch (error) {
    showAuth(authMessage(error), "error");
    failClosed();
  }
}

async function signIn(event) {
  event.preventDefault();
  if (!state.auth) {
    showAuth("로그인 설정을 확인하지 못했습니다.", "error");
    return;
  }
  const config = window.DAILY_CS_CONFIG ?? {};
  const redirectTo = new URL("./auth/callback.html", location.href).href;
  sessionStorage.setItem(RETURN_URL_KEY, safeReturnUrl(location.href, location, config.basePath ?? "/Daily_CS/"));
  const result = await signInWithGoogle(state.auth, redirectTo);
  if (result.error) showAuth(result.error.message, "error");
}

async function onSessionRefresh(session, error) {
  if (error || !session) {
    clearSensitiveMemory();
    showAuth(error ? authMessage(error) : "세션이 만료되었습니다. 다시 로그인해 주세요.", "error");
    failClosed();
    return;
  }
  state.session = session;
}

async function verifyOwnerAndEnter() {
  const dashboard = await owner(ACTIONS.dashboardGet, {});
  state.dashboard = dashboard;
  state.settings = dashboard.settings ?? dashboard;
  nodes.authShell.hidden = true;
  nodes.workspace.hidden = false;
  nodes.sessionLabel.textContent = state.session.user?.email ? `${state.session.user.email} · 로그인됨` : "로그인됨";
  await refreshAll();
}

async function refreshAll() {
  await Promise.all([refreshAdminList(), refreshReaderHistory(), refreshOps()]);
  await openInitialReaderTarget();
}

async function refreshAdminList() {
  const data = await owner(ACTIONS.lessonList, { state: "all" });
  state.lessons = (data.items ?? []).map(normalizeLesson).filter(Boolean);
  renderAdminList();
}

async function refreshReaderHistory() {
  const today = todayKey();
  const from = state.settings?.startDate ?? today;
  const data = await owner(ACTIONS.readerHistory, {
    from,
    to: today,
    category: nodes.readerCategory.value || undefined
  });
  state.readerItems = normalizeReaderItems(data.days ?? data.items ?? []);
  renderReaderList();
}

async function refreshReaderSearch() {
  const query = nodes.readerSearch.value.trim();
  if (!query) {
    await refreshReaderHistory();
    return;
  }
  const data = await owner(ACTIONS.readerSearch, { query, limit: 50 });
  state.readerItems = normalizeReaderItems(data.items ?? []);
  renderReaderList();
}

async function openInitialReaderTarget() {
  const params = new URLSearchParams(location.search);
  const snapshotId = params.get("snapshot");
  const lessonId = params.get("lesson");
  const date = params.get("date");
  if (date && nodes.readerDate) nodes.readerDate.value = date;
  if (snapshotId) return openReaderDay({ snapshotId });
  if (lessonId) return openReaderDay({ lessonId });
  if (date) return openReaderDay({ date });
  return openToday();
}

async function openToday() {
  await openReaderDay({});
}

async function openDateSelection() {
  await openReaderDay({ date: nodes.readerDate.value });
}

async function openReaderDay(payload) {
  const request = ++readerRequest;
  clearVisualPlayer(nodes.lessonPaper);
  try {
    const action = payload.snapshotId ? ACTIONS.readerSnapshot : ACTIONS.readerToday;
    const data = await owner(action, payload);
    if (request !== readerRequest) return;
    const day = normalizeReaderDay(data.day ?? data);
    if (!day?.lesson) {
      renderEmptyLesson(payload.date ? "해당 날짜의 학습 스냅샷이 없습니다." : "오늘 공개된 학습 스냅샷이 없습니다.");
      return;
    }
    state.selectedReaderKey = day.date ?? day.lesson.id;
    renderVisualLesson(nodes.lessonPaper, day.lesson);
    nodes.lessonPaper.focus({ preventScroll: true });
    setStatus(nodes.readerStatus, `${day.date ?? "오늘"} 학습글을 열었습니다.`, "info");
    renderReaderList();
  } catch (error) {
    if (request !== readerRequest) return;
    handleActionError(error, nodes.readerStatus);
    renderEmptyLesson("학습글을 불러오지 못했습니다.");
  }
}

function renderReaderList() {
  nodes.readerList.replaceChildren();
  nodes.readerCount.textContent = `${state.readerItems.length}개`;
  for (const item of state.readerItems) {
    nodes.readerList.append(card(item, () => openReaderDay({ date: item.date }), item.key === state.selectedReaderKey));
  }
}

function renderEmptyLesson(message) {
  clearVisualPlayer(nodes.lessonPaper);
  nodes.lessonPaper.innerHTML = `<p class="empty-state">${escapeText(message)}</p>`;
  setStatus(nodes.readerStatus, message, "warning");
}

function renderAdminList() {
  nodes.adminList.replaceChildren();
  const query = nodes.adminSearch.value.trim().toLocaleLowerCase();
  for (const lesson of state.lessons) {
    const metadata = lesson.draftDocument;
    if (nodes.adminState.value && lesson.state !== nodes.adminState.value) continue;
    if (nodes.adminCategory.value && lesson.category !== nodes.adminCategory.value) continue;
    if (nodes.adminLevel.value && (metadata.level ?? lesson.level) !== nodes.adminLevel.value) continue;
    const searchText = [lesson.title, lesson.category, metadata.summary ?? lesson.summary, ...(metadata.keywords ?? lesson.keywords ?? [])].join(" ").toLocaleLowerCase();
    if (query && !searchText.includes(query)) continue;
    const wrapper = document.createElement("label");
    wrapper.className = "lesson-card";
    wrapper.innerHTML = `<span><input type="checkbox" value="${escapeAttr(lesson.id)}"> ${escapeText(lesson.title)}</span><span class="lesson-card__meta">${escapeText(lesson.state)} · r${lesson.rowRevision}</span>`;
    wrapper.addEventListener("click", (event) => {
      if (event.target.type !== "checkbox") loadEditor(lesson.id);
    });
    if (lesson.id === state.selectedAdminId) wrapper.setAttribute("aria-current", "true");
    nodes.adminList.append(wrapper);
  }
  if (!nodes.adminList.childElementCount) nodes.adminList.append(textBlock("조건에 맞는 학습글이 없습니다."));
  const selectedOverride = nodes.scheduleOverride.value;
  setOptions(nodes.scheduleOverride, [["", "게시된 글 선택"], ...state.lessons
    .filter((lesson) => lesson.state === "published")
    .map((lesson) => [lesson.id, lesson.title])]);
  nodes.scheduleOverride.value = selectedOverride;
}

async function loadEditor(id) {
  const request = ++editorRequest;
  const data = await owner(ACTIONS.lessonGet, { id });
  if (request !== editorRequest) return;
  const lesson = normalizeLesson(data.lesson);
  if (!lesson) return;
  mergeLesson(lesson);
  state.selectedAdminId = lesson.id;
  fillEditor(lesson);
  renderHistory((data.revisions ?? []).map(normalizeRevision).filter(Boolean));
  renderAdminList();
}

function fillEditor(lesson) {
  const document = lesson.draftDocument ?? {};
  editorVisuals = document.visuals;
  nodes.editorId.value = lesson.id;
  nodes.editorVersion.value = String(lesson.rowRevision);
  if (nodes.editorState) nodes.editorState.value = lesson.state;
  if (nodes.editorDraftRevision) nodes.editorDraftRevision.value = String(lesson.draftRevision ?? "");
  if (nodes.editorPublishedRevision) nodes.editorPublishedRevision.value = String(lesson.publishedRevision ?? "");
  nodes.editorTitle.value = lesson.title;
  nodes.editorAlias.value = lesson.legacyId ? String(lesson.legacyId).padStart(3, "0") : "";
  if (nodes.editorDocumentId) nodes.editorDocumentId.value = document.id ?? nodes.editorAlias.value;
  if (nodes.editorOrder) nodes.editorOrder.value = document.order ?? "";
  if (nodes.editorWeek) nodes.editorWeek.value = document.week ?? "";
  if (nodes.editorVersionNote) nodes.editorVersionNote.value = document.versionNote ?? "";
  nodes.editorSummary.value = document.summary ?? "";
  nodes.editorCategory.value = lesson.category;
  nodes.editorTrack.value = document.track ?? "common";
  nodes.editorLevel.value = document.level ?? "foundation";
  nodes.editorKeywords.value = Array.isArray(document.keywords) ? document.keywords.join(", ") : "";
  const markdown = lesson.documentKind === "markdown";
  documentRadio(markdown ? "markdown" : "structured").checked = true;
  syncDocMode();
  nodes.editorMarkdown.value = markdown ? document.markdown ?? "" : "";
  nodes.editorQuestion.value = document.question ?? "";
  nodes.editorExplanation.value = Array.isArray(document.explanation) ? document.explanation.join("\n") : "";
  if (nodes.editorComparisonHeaders) nodes.editorComparisonHeaders.value = Array.isArray(document.comparison?.headers) ? document.comparison.headers.join(", ") : "";
  if (nodes.editorComparisonRows) nodes.editorComparisonRows.value = Array.isArray(document.comparison?.rows) ? document.comparison.rows.map((row) => row.join(" | ")).join("\n") : "";
  nodes.editorExampleDescription.value = document.example?.description ?? "";
  nodes.editorExampleCode.value = document.example?.code ?? "";
  if (nodes.editorExampleLanguage) nodes.editorExampleLanguage.value = document.example?.language ?? "";
  nodes.editorAnswer.value = document.answer ?? "";
  nodes.editorPitfalls.value = Array.isArray(document.pitfalls) ? document.pitfalls.join("\n") : "";
  if (nodes.editorFollowups) nodes.editorFollowups.value = Array.isArray(document.followUps) ? document.followUps.map((item) => `${item.question ?? ""} | ${item.answer ?? ""}`).join("\n") : "";
  if (nodes.editorQuizQuestion) nodes.editorQuizQuestion.value = document.quiz?.question ?? "";
  if (nodes.editorQuizChoices) nodes.editorQuizChoices.value = Array.isArray(document.quiz?.choices) ? document.quiz.choices.join("\n") : "";
  if (nodes.editorQuizAnswerIndex) nodes.editorQuizAnswerIndex.value = Number.isInteger(document.quiz?.answerIndex) ? String(document.quiz.answerIndex + 1) : "";
  if (nodes.editorQuizExplanation) nodes.editorQuizExplanation.value = document.quiz?.explanation ?? "";
  if (nodes.editorSources) nodes.editorSources.value = Array.isArray(document.sources) ? document.sources.map((source) => `${source.title ?? ""} | ${source.url ?? ""} | ${source.note ?? ""}`).join("\n") : "";
  nodes.editorLock.textContent = `${lesson.state} · r${lesson.rowRevision}`;
  renderPreviewFromEditor();
}

function renderHistory(revisions) {
  nodes.historyOutput.replaceChildren();
  if (nodes.revisionSelect) {
    nodes.revisionSelect.replaceChildren(...revisions.map((revision) => {
      const option = document.createElement("option");
      option.value = revision.id;
      option.textContent = `r${revision.revisionNumber} · ${revision.title ?? "제목 없음"}`;
      return option;
    }));
  }
  if (nodes.diffOutput) {
    nodes.diffOutput.textContent = revisions.length > 1 ? revisionDiffText(revisions[0], revisions[1]) : "";
  }
  if (!revisions.length) {
    nodes.historyOutput.innerHTML = '<p class="muted">이력이 없습니다.</p>';
    return;
  }
  for (const revision of revisions.slice(0, 8)) {
    const row = document.createElement("div");
    row.className = "revision-row";
    const preview = button(`r${revision.revisionNumber} 미리보기`, "button");
    const restore = button("이 버전 복원", "button button--primary");
    preview.addEventListener("click", () => previewRevision(revision.id));
    restore.addEventListener("click", () => restoreRevision(revision.id));
    row.append(
      textBlock(`${revision.title ?? "제목 없음"} · ${revision.createdAt ?? ""}`),
      preview,
      restore
    );
    nodes.historyOutput.append(row);
  }
}

async function previewRevision(revisionId) {
  const request = ++editorRequest;
  const data = await owner(ACTIONS.revisionGet, { revisionId });
  if (request !== editorRequest) return;
  const revision = normalizeRevision(data.revision);
  renderVisualLesson(nodes.previewOutput, revisionToRenderable(revision));
  nodes.jsonOutput.textContent = JSON.stringify({ previewRevision: revision }, null, 2);
}

async function restoreSelectedRevision() {
  const revisionId = nodes.revisionSelect?.value;
  if (revisionId) await restoreRevision(revisionId);
}

async function restoreRevision(revisionId) {
  const id = nodes.editorId.value;
  if (!id) return;
  const data = await owner(ACTIONS.lessonRestoreRevision, {
    id,
    revisionId,
    expectedRevision: Number(nodes.editorVersion.value)
  });
  await loadEditor(data.lesson.id);
  setStatus(nodes.editorStatus, "선택한 리비전을 새 초안으로 복원했습니다.", "info");
}

async function createDraft() {
  const document = draftDocumentFromEditor();
  delete document.visuals;
  const nextLegacyId = nextAvailableLegacyId();
  const payload = {
    ...(nextLegacyId ? { legacyId: nextLegacyId } : {}),
    title: "새 초안",
    category: nodes.editorCategory.value || "database",
    documentKind: "structured",
    document,
    state: "draft"
  };
  const data = await owner(ACTIONS.lessonCreate, payload);
  const lesson = normalizeLesson(data.lesson);
  mergeLesson(lesson);
  fillEditor(lesson);
  renderAdminList();
  setStatus(nodes.editorStatus, "새 초안을 만들었습니다.", "info");
}

async function explicitSaveDraft(event) {
  event.preventDefault();
  await saveDraft("초안을 저장했습니다.");
}

async function saveDraft(message) {
  const id = nodes.editorId.value;
  if (!id) return;
  const data = await owner(ACTIONS.lessonSaveDraft, {
    id,
    expectedRevision: Number(nodes.editorVersion.value),
    title: nodes.editorTitle.value.trim() || "제목 없음",
    category: nodes.editorCategory.value,
    documentKind: currentDocumentKind(),
    document: draftDocumentFromEditor()
  });
  const lesson = normalizeLesson(data.lesson);
  mergeLesson(lesson);
  nodes.editorVersion.value = String(lesson.rowRevision);
  nodes.editorLock.textContent = `${lesson.state} · r${lesson.rowRevision}`;
  setStatus(nodes.editorStatus, message, "info");
}

const scheduleAutosave = debounce(async () => {
  if (!nodes.editorId.value) return;
  try {
    await saveDraft("자동 저장했습니다.");
  } catch (error) {
    handleActionError(error, nodes.editorStatus);
  }
}, 1200);

async function mutateSelected(action) {
  if (!nodes.editorId.value) return;
  const data = await owner(action, {
    id: nodes.editorId.value,
    expectedRevision: Number(nodes.editorVersion.value)
  });
  await loadEditor(data.lesson.id);
}

async function duplicateSelected() {
  if (!nodes.editorId.value) return;
  const data = await owner(ACTIONS.lessonDuplicate, {
    id: nodes.editorId.value,
    title: `${nodes.editorTitle.value.trim() || "초안"} copy`
  });
  const lesson = normalizeLesson(data.lesson);
  mergeLesson(lesson);
  fillEditor(lesson);
  renderAdminList();
}

async function purgeSelected() {
  if (!nodes.editorId.value) return;
  const ok = window.confirm(`"${nodes.editorTitle.value}"을 영구 삭제할까요?`);
  if (!ok) return;
  await owner(ACTIONS.lessonPurge, {
    id: nodes.editorId.value,
    expectedRevision: Number(nodes.editorVersion.value)
  });
  state.lessons = state.lessons.filter((lesson) => lesson.id !== nodes.editorId.value);
  nodes.editorForm.reset();
  editorVisuals = undefined;
  clearVisualPlayer(nodes.previewOutput);
  nodes.previewOutput.innerHTML = "";
  renderAdminList();
}

async function bulkTransition(action) {
  const selected = selectedAdminLessons();
  for (const lesson of selected) {
    try {
      const data = await owner(action, { id: lesson.id, expectedRevision: lesson.rowRevision });
      mergeLesson(normalizeLesson(data.lesson));
    } catch (error) {
      handleActionError(error, nodes.editorStatus);
      break;
    }
  }
  renderAdminList();
}

async function refreshOps() {
  const [settingsData, dashboard, mailData] = await Promise.all([
    owner(ACTIONS.settingsGet, {}),
    owner(ACTIONS.dashboardGet, {}),
    owner(ACTIONS.mailStatus, { from: todayKey(-13), days: 14 })
  ]);
  state.settings = normalizeSettings(settingsData, state.settings);
  state.dashboard = dashboard;
  renderOps(settingsData, dashboard, mailData);
}

function renderOps(settingsData, dashboard, mailData) {
  const settings = normalizeSettings(settingsData, state.settings);
  nodes.scheduleStart.value = settings.startDate ?? todayKey();
  nodes.scheduleHour.value = settings.sendTime ?? "09:00";
  nodes.mailPaused.checked = Boolean(settings.mailPaused);
  if (nodes.scheduleRevision) nodes.scheduleRevision.value = String(settings.scheduleRevision ?? settings.revision ?? "");
  nodes.logOutput.replaceChildren(...(mailData.items ?? []).map(mailRow));
  if (!nodes.logOutput.childElementCount) nodes.logOutput.append(textBlock("최근 메일 기록이 없습니다."));
  const counts = dashboard.counts ?? {};
  const statusLabels = { frozen: "확정", scheduled: "예정", empty: "학습글 없음", not_started: "시작 전" };
  nodes.dashboardSummary.replaceChildren(
    textBlock(`초안 ${counts.draft ?? 0} · 게시 ${counts.published ?? 0} · 휴지통 ${counts.trash ?? 0}`),
    textBlock(`대기 메일 ${counts.queuedMail ?? 0} · 확인 필요 ${counts.uncertainMail ?? 0}`),
    ...[["오늘", dashboard.today], ["내일", dashboard.tomorrow]].map(([label, day]) =>
      textBlock(`${label} · ${day?.date ?? ""} · ${day?.title ?? "학습글 없음"} · ${statusLabels[day?.status] ?? "상태 확인 중"}`))
  );
  const health = dashboard.operations ?? {};
  const formatTime = (value) => value ? new Date(value).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "기록 없음";
  const backup = health.backupLatest;
  nodes.operationsHealth.replaceChildren(
    textBlock(`메일 폴러 · 마지막 응답: ${formatTime(health.mailLastSeenAt)}`),
    textBlock(`최근 백업: ${backup ? (backup.status === "success" ? "성공" : "실패") : "기록 없음"} · ${formatTime(backup?.reportedAt)}`),
    textBlock(`마지막 성공: ${formatTime(health.backupLastSuccessAt)} · 마지막 실패: ${formatTime(health.backupLastFailureAt)}`)
  );
  if (backup && /^[0-9]{1,30}$/.test(backup.runId)) {
    const link = document.createElement("a");
    link.href = `https://github.com/donggeonha/Daily_CS-archive/actions/runs/${backup.runId}`;
    link.textContent = "비공개 백업 실행 기록";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    nodes.operationsHealth.append(link);
  }
  nodes.accountOutput.replaceChildren(
    textBlock(`계정: ${state.session?.user?.email ?? "로그인됨"}`),
    textBlock(`시간대: ${settings.timezone ?? "Asia/Seoul"}`),
    textBlock(`학습 시작일: ${settings.startDate ?? "미설정"}`),
    textBlock(`메일: ${settings.mailPaused ? "일시정지" : "발송 중"} · ${settings.sendTime ?? "09:00"}`)
  );
  if (!nodes.opsStatus.dataset.tone) setStatus(nodes.opsStatus, "운영 상태를 불러왔습니다.", "info");
}

async function saveSchedule() {
  if (!nodes.scheduleHour.reportValidity()) return;
  const sendTime = nodes.scheduleHour.value;
  const update = await owner(ACTIONS.settingsUpdate, {
    expectedRevision: state.settings?.revision,
    sendTime,
    mailPaused: nodes.mailPaused.checked
  });
  state.settings = { ...state.settings, revision: update.revision, scheduleRevision: update.scheduleRevision, sendTime, mailPaused: nodes.mailPaused.checked };
  setStatus(nodes.opsStatus, "스케줄 설정을 저장했습니다.", "info");
  await refreshOps();
}

async function saveOverride() {
  const mode = nodes.scheduleOverrideMode?.value ?? (nodes.scheduleOverride.value.trim() ? "lesson" : "auto");
  if (mode === "lesson" && !nodes.scheduleOverride.value) {
    setStatus(nodes.opsStatus, "지정할 게시 학습글을 선택해 주세요.", "warning");
    return;
  }
  const payload = {
    date: nodes.scheduleOverrideDate?.value || tomorrowKey(),
    mode,
    expectedScheduleRevision: Number(nodes.scheduleRevision?.value || state.settings?.scheduleRevision || 0)
  };
  if (mode === "lesson") payload.lessonId = nodes.scheduleOverride.value.trim();
  const data = await owner(ACTIONS.scheduleSetOverride, payload);
  state.settings = { ...state.settings, scheduleRevision: data.scheduleRevision ?? state.settings?.scheduleRevision };
  setStatus(nodes.opsStatus, "오버라이드를 저장했습니다.", "info");
  await refreshOps();
}

async function rebuildSchedule() {
  const data = await owner(ACTIONS.scheduleRebuildFuture, {
    from: nodes.scheduleStart.value || todayKey(),
    expectedScheduleRevision: Number(nodes.scheduleRevision?.value || state.settings?.scheduleRevision || 0)
  });
  state.settings = { ...state.settings, scheduleRevision: data.scheduleRevision ?? state.settings?.scheduleRevision };
  setStatus(nodes.opsStatus, "미래 일정을 다시 계산했습니다.", "info");
  await refreshOps();
}

async function sendTestMail() {
  const data = await owner(ACTIONS.mailEnqueueTest, { date: nodes.readerDate.value || todayKey(), commandId: crypto.randomUUID() });
  nodes.jsonOutput.textContent = JSON.stringify(data, null, 2);
  setStatus(nodes.opsStatus, "테스트 메일을 큐에 넣었습니다.", "info");
  await refreshOps();
}

async function retryUncertainMail() {
  const messageId = window.prompt("재발송할 uncertain messageId를 입력하세요.");
  if (!messageId) return;
  const checked = window.confirm("메일함에서 중복 수신 여부를 직접 확인했습니까?");
  const data = await owner(ACTIONS.mailRetryUncertain, {
    messageId,
    expectedState: "uncertain",
    commandId: crypto.randomUUID(),
    mailboxChecked: checked
  });
  nodes.jsonOutput.textContent = JSON.stringify(data, null, 2);
  await refreshOps();
}

async function exportJson() {
  const data = await owner(ACTIONS.exportCreate, { includeTrash: true });
  nodes.jsonOutput.textContent = JSON.stringify(data, null, 2);
  setStatus(nodes.opsStatus, "내보내기 JSON을 만들었습니다.", "info");
}

async function previewImport() {
  const payload = parseImportText();
  const data = await owner(ACTIONS.importPreview, payload);
  state.importPreview = { request: payload, response: data };
  if (nodes.importExpectedHash && data.hash) nodes.importExpectedHash.value = data.hash;
  nodes.commitImport.disabled = false;
  nodes.jsonOutput.textContent = JSON.stringify(data, null, 2);
  setStatus(nodes.opsStatus, "가져오기 검증을 완료했습니다. 커밋은 별도 버튼으로 실행합니다.", "info");
}

async function commitImport() {
  if (!state.importPreview) return;
  const hash = nodes.importExpectedHash?.value.trim() || (state.importPreview.response.hash ?? state.importPreview.response.expectedExportHash);
  const data = await owner(ACTIONS.importCommit, {
    ...state.importPreview.request,
    expectedExportHash: hash
  });
  nodes.jsonOutput.textContent = JSON.stringify(data, null, 2);
  nodes.commitImport.disabled = true;
  await refreshAll();
}

async function restoreBackup() {
  const payload = parseImportText();
  const data = await owner(ACTIONS.backupRestore, payload);
  nodes.jsonOutput.textContent = JSON.stringify(data, null, 2);
  setStatus(nodes.opsStatus, "백업 복원 요청을 완료했습니다.", "info");
  await refreshAll();
}

function downloadJsonOutput() {
  if (!nodes.jsonOutput.textContent.trim()) return;
  const blob = new Blob([nodes.jsonOutput.textContent], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `daily-cs-export-${todayKey()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function showEditorJson() {
  nodes.jsonOutput.textContent = JSON.stringify({
    id: nodes.editorId.value,
    expectedRevision: Number(nodes.editorVersion.value),
    title: nodes.editorTitle.value.trim(),
    category: nodes.editorCategory.value,
    documentKind: currentDocumentKind(),
    document: draftDocumentFromEditor()
  }, null, 2);
  switchView("ops");
}

function renderPreviewFromEditor() {
  const draft = draftDocumentFromEditor();
  renderVisualLesson(nodes.previewOutput, {
    ...draft,
    id: nodes.editorAlias.value || nodes.editorId.value || "preview",
    legacyAlias: nodes.editorAlias.value,
    title: nodes.editorTitle.value.trim() || "제목 없음",
    category: nodes.editorCategory.value,
    document: currentDocumentKind() === "markdown" ? { ...draft, kind: "markdown" } : undefined
  });
}

function syncDocMode() {
  const markdown = currentDocumentKind() === "markdown";
  nodes.structuredEditor.hidden = markdown;
  nodes.markdownEditor.hidden = !markdown;
  renderPreviewFromEditor();
}

function draftDocumentFromEditor() {
  const sourceRows = parsePipeRows(nodes.editorSources?.value ?? "", 3);
  const followUps = parsePipeRows(nodes.editorFollowups?.value ?? "", 2).map((row) => ({ question: row[0], answer: row[1] }));
  const choices = splitList(nodes.editorQuizChoices?.value ?? "", "\n");
  const answerNumber = Number.parseInt(nodes.editorQuizAnswerIndex?.value ?? "", 10);
  const comparisonRows = parsePipeRows(nodes.editorComparisonRows?.value ?? "", 2);
  const comparisonHeaders = splitList(nodes.editorComparisonHeaders?.value ?? "", ",");
  const common = {
    id: nodes.editorDocumentId?.value.trim() || nodes.editorAlias.value.trim() || nodes.editorId.value || "draft",
    order: Number.parseInt(nodes.editorOrder?.value || nodes.editorAlias.value, 10) || undefined,
    track: nodes.editorTrack.value,
    category: nodes.editorCategory.value,
    level: nodes.editorLevel.value,
    week: Number.parseInt(nodes.editorWeek?.value ?? "", 10) || 1,
    title: nodes.editorTitle.value.trim(),
    summary: nodes.editorSummary.value.trim(),
    keywords: splitList(nodes.editorKeywords.value, ","),
    versionNote: nodes.editorVersionNote?.value.trim() || "관리자 입력",
    sources: sourceRows.map((row) => ({ title: row[0], url: row[1], note: row[2] }))
  };
  if (editorVisuals !== undefined) common.visuals = editorVisuals;
  if (currentDocumentKind() === "markdown") {
    return { ...common, markdown: nodes.editorMarkdown.value };
  }
  return {
    ...common,
    question: nodes.editorQuestion.value.trim(),
    answer: nodes.editorAnswer.value.trim(),
    explanation: splitList(nodes.editorExplanation.value, "\n"),
    example: {
      language: nodes.editorExampleLanguage?.value.trim() || "text",
      description: nodes.editorExampleDescription.value.trim(),
      code: nodes.editorExampleCode.value
    },
    pitfalls: splitList(nodes.editorPitfalls.value, "\n"),
    followUps,
    quiz: {
      question: nodes.editorQuizQuestion?.value.trim() ?? "",
      choices,
      answerIndex: Number.isInteger(answerNumber) && answerNumber > 0 ? answerNumber - 1 : 0,
      explanation: nodes.editorQuizExplanation?.value.trim() ?? ""
    },
    comparison: { headers: comparisonHeaders, rows: comparisonRows }
  };
}

async function owner(action, payload) {
  const generation = state.authGeneration;
  try {
    const data = await state.api.action(action, payload);
    if (generation !== state.authGeneration) throw new DailyCsApiError("session_changed", "세션이 변경되었습니다.", 409);
    return data;
  } catch (error) {
    if (generation === state.authGeneration && error instanceof DailyCsApiError && (error.status === 401 || error.status === 403)) {
      clearSensitiveMemory();
      failClosed();
    }
    throw error;
  }
}

async function getAccessToken() {
  if (!state.session) return "";
  const generation = state.authGeneration;
  const session = await getVerifiedSession(state.auth);
  if (generation !== state.authGeneration) return "";
  state.session = session;
  return session?.access_token ?? "";
}

async function signOutAndReset(scope) {
  clearSensitiveMemory();
  failClosed();
  try {
    if (state.auth) await signOut(state.auth, scope);
  } finally {
    showAuth(scope === "global" ? "전체 세션에서 로그아웃했습니다." : "이 브라우저에서 로그아웃했습니다.", "info");
  }
}

function clearSensitiveMemory() {
  clearVisualPlayers();
  editorVisuals = undefined;
  readerRequest += 1;
  editorRequest += 1;
  state.authGeneration += 1;
  state.cleanupRefresh?.();
  state.dashboard = null;
  state.importPreview = null;
  state.lessons = [];
  state.readerItems = [];
  state.selectedAdminId = "";
  state.selectedReaderKey = "";
  state.session = null;
  state.settings = null;
  sessionStorage.removeItem(RETURN_URL_KEY);
  nodes.lessonPaper.innerHTML = '<p class="empty-state">로그인이 필요합니다.</p>';
  nodes.readerList.replaceChildren();
  nodes.adminList.replaceChildren();
  nodes.previewOutput.replaceChildren();
  nodes.historyOutput.replaceChildren();
  nodes.jsonOutput.textContent = "";
  nodes.dashboardSummary.replaceChildren();
  nodes.operationsHealth.replaceChildren();
  nodes.accountOutput.replaceChildren();
  nodes.logOutput.replaceChildren();
  setOptions(nodes.scheduleOverride, [["", "게시된 글 선택"]]);
  nodes.editorForm.reset();
  for (const input of [nodes.importJson, nodes.importExpectedHash, nodes.readerSearch, nodes.readerDate, nodes.adminSearch]) input.value = "";
  nodes.diffOutput.textContent = "";
  nodes.revisionSelect.replaceChildren();
  nodes.sessionLabel.textContent = "로그아웃됨";
  nodes.editorLock.textContent = "선택 없음";
  nodes.editorStatus.textContent = "";
}

function failClosed() {
  nodes.workspace.hidden = true;
  nodes.authShell.hidden = false;
}

function configureLoginHint() {
  const config = window.DAILY_CS_CONFIG ?? {};
  const callbackPath = new URL("./auth/callback.html", location.href).pathname;
  if (config.basePath && !callbackPath.startsWith(config.basePath)) {
    showAuth("로그인 콜백 경로가 Daily_CS 내부로 제한되지 않았습니다.", "error");
  }
}

function normalizeReaderItems(items) {
  return items.map(normalizeReaderDay).filter(Boolean).map((day) => ({
    key: day.date ?? day.lesson?.id,
    date: day.date,
    id: day.lesson?.id ?? day.lessonId,
    title: day.title ?? day.lesson?.title ?? "제목 없음",
    category: day.category ?? day.lesson?.category ?? "database",
    summary: day.lesson?.summary ?? day.summary ?? "",
    version: day.revisionNumber ?? day.lesson?.version ?? ""
  }));
}

function normalizeReaderDay(raw) {
  if (!raw || typeof raw !== "object") return null;
  const date = raw.date ?? raw.snapshot_date;
  if (raw.lesson?.document) {
    return { ...raw, date, lesson: readerLessonFromSnapshot(raw.lesson, raw.lesson.document) };
  }
  if (raw.document) {
    return { ...raw, date, lesson: readerLessonFromSnapshot(raw, raw.document) };
  }
  return { ...raw, date, lesson: null };
}

function readerLessonFromSnapshot(raw, document) {
  return documentForRender({
    id: raw.lessonId ?? raw.lesson_id ?? raw.id,
    legacyId: raw.legacyId ?? raw.legacy_id,
    title: raw.title,
    category: raw.category,
    documentKind: raw.documentKind ?? raw.document_kind ?? "structured",
    draftDocument: document
  });
}

function revisionToRenderable(revision) {
  return documentForRender({
    id: revision.lessonId,
    title: revision.title,
    category: revision.category,
    documentKind: revision.documentKind,
    draftDocument: revision.document,
    rowRevision: revision.revisionNumber
  });
}

function mailRow(item) {
  const row = document.createElement("p");
  row.textContent = `${item.date ?? item.scheduled_date ?? ""} · ${item.state ?? ""} · ${item.id ?? ""}`;
  return row;
}

function card(item, onClick, selected) {
  const buttonEl = document.createElement("button");
  buttonEl.className = "lesson-card";
  buttonEl.type = "button";
  buttonEl.setAttribute("aria-current", selected ? "true" : "false");
  buttonEl.innerHTML = `<strong>${escapeText(item.title)}</strong><span class="lesson-card__meta">${escapeText(item.date ?? "")} · ${escapeText(CATEGORY_LABELS[item.category] ?? item.category)}</span><span>${escapeText(item.summary)}</span>`;
  buttonEl.addEventListener("click", onClick);
  return buttonEl;
}

function selectedAdminLessons() {
  const ids = new Set([...nodes.adminList.querySelectorAll("input:checked")].map((input) => input.value));
  return state.lessons.filter((lesson) => ids.has(lesson.id));
}

function mergeLesson(lesson) {
  const index = state.lessons.findIndex((item) => item.id === lesson.id);
  if (index >= 0) state.lessons[index] = lesson;
  else state.lessons.unshift(lesson);
}

function nextAvailableLegacyId() {
  const maxLegacyId = state.lessons.reduce((max, lesson) => {
    const value = Number(lesson.legacyId ?? 0);
    return Number.isFinite(value) ? Math.max(max, value) : max;
  }, 365);
  return maxLegacyId + 1;
}

function normalizeSettings(data, fallback = {}) {
  const settings = data?.settings ?? data ?? fallback ?? {};
  return {
    ...fallback,
    ...settings,
    scheduleRevision: settings.scheduleRevision ?? settings.schedule_revision ?? fallback?.scheduleRevision ?? fallback?.schedule_revision ?? settings.revision
  };
}

function switchView(view) {
  readerRequest += 1;
  editorRequest += 1;
  visualPlayers.forEach(player => player.pause());
  for (const key of ["reader", "admin", "ops"]) {
    document.getElementById(`${key}-view`).hidden = key !== view;
  }
  nodes.tabs.forEach((tab) => tab.setAttribute("aria-current", tab.dataset.view === view ? "true" : "false"));
}

function renderVisualLesson(container, lesson) {
  clearVisualPlayer(container);
  container.innerHTML = renderLessonHtml(lesson);
  visualPlayers.set(container, mountVisualPlayers(container, lesson.document?.visuals ?? lesson.visuals));
}

function clearVisualPlayer(container) {
  visualPlayers.get(container)?.destroy();
  visualPlayers.delete(container);
}

function clearVisualPlayers() {
  for (const container of visualPlayers.keys()) clearVisualPlayer(container);
}

function editorInputs() {
  return [
    nodes.editorTitle, nodes.editorAlias, nodes.editorSummary, nodes.editorCategory, nodes.editorTrack, nodes.editorLevel,
    nodes.editorKeywords, nodes.editorDocumentId, nodes.editorOrder, nodes.editorWeek, nodes.editorVersionNote,
    nodes.editorQuestion, nodes.editorExplanation, nodes.editorComparisonHeaders, nodes.editorComparisonRows,
    nodes.editorExampleDescription, nodes.editorExampleCode, nodes.editorExampleLanguage, nodes.editorAnswer,
    nodes.editorPitfalls, nodes.editorFollowups, nodes.editorQuizQuestion, nodes.editorQuizChoices,
    nodes.editorQuizAnswerIndex, nodes.editorQuizExplanation, nodes.editorSources, nodes.editorMarkdown
  ].filter(Boolean);
}

function currentDocumentKind() {
  return document.querySelector('input[name="doc-mode"]:checked')?.value ?? "structured";
}

function documentRadio(value) {
  return document.querySelector(`input[name="doc-mode"][value="${value}"]`);
}

function parseImportText() {
  try {
    return JSON.parse(nodes.importJson.value);
  } catch (error) {
    throw new DailyCsApiError("validation_failed", error.message, 400);
  }
}

function button(label, className) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  return element;
}

function hiddenInput(id) {
  const element = document.createElement("input");
  element.type = "hidden";
  element.id = id;
  return element;
}

function placeAfter(anchor, ...elements) {
  for (const element of elements) {
    if (!element || element.isConnected) continue;
    anchor.after(element);
  }
}

function textBlock(text) {
  const element = document.createElement("p");
  element.textContent = text;
  return element;
}

function setOptions(select, entries) {
  select.replaceChildren(...entries.map(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    return option;
  }));
}

function setStatus(node, message, tone) {
  node.textContent = message;
  node.dataset.tone = tone;
}

function showAuth(message, tone) {
  nodes.authStatus.textContent = message;
  nodes.authStatus.dataset.tone = tone;
}

function handleActionError(error, statusNode) {
  setStatus(statusNode, error instanceof Error ? error.message : "요청에 실패했습니다.", "error");
}

function authMessage(error) {
  if (error instanceof Error) return error.message;
  return "인증 상태를 확인하지 못했습니다.";
}

function splitList(value, separator) {
  return value.split(separator).map((item) => item.trim()).filter(Boolean);
}

function parsePipeRows(value, minimumColumns) {
  return String(value ?? "")
    .split("\n")
    .map((line) => line.split("|").map((cell) => cell.trim()))
    .filter((row) => row.length >= minimumColumns && row.every(Boolean));
}

function revisionDiffText(current, previous) {
  const fields = ["title", "category", "documentKind", "contentHash"];
  return fields
    .filter((field) => current?.[field] !== previous?.[field])
    .map((field) => `${field}: ${previous?.[field] ?? ""} -> ${current?.[field] ?? ""}`)
    .join("\n");
}

function todayKey(offset = 0) {
  const korea = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  korea.setDate(korea.getDate() + offset);
  return `${korea.getFullYear()}-${String(korea.getMonth() + 1).padStart(2, "0")}-${String(korea.getDate()).padStart(2, "0")}`;
}

function tomorrowKey() {
  return todayKey(1);
}

function debounce(callback, delay) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => callback(...args), delay);
  };
}

function toKey(id) {
  return id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function escapeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function escapeAttr(value) {
  return escapeText(value).replace(/`/g, "&#96;");
}

window.DailyCsV2 = { ACTIONS };




