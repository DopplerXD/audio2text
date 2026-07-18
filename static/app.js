const state = {
  records: [],
  currentRecord: null,
  selectedFile: null,
  aiConfig: null,
  workingText: "",
  workingSource: "",
  currentReview: null,
  resolvedIssueIds: new Set(),
  textVersions: [],
  leftVersionId: null,
  rightVersionId: null,
  versionLoadId: 0,
  diffRequestId: 0,
  reviewEditDiffRequestId: 0,
  reviewEditDiffTimer: null,
  reviewEditScrollSync: false,
  reviewSaveBusy: false,
  pendingExport: null,
  pendingExportDeletion: null,
  selectedExportIds: new Set(),
  exportSourceId: "record",
  exportBusy: false,
  busy: new Set(),
};

const AI_BUTTON_LABELS = {
  organize: { idle: "开始智能整理", busy: "正在整理…" },
  review: { idle: "开始检查", busy: "正在检查…" },
  analysis: { idle: "生成面试分析", busy: "正在分析…" },
};

const EXPORT_FORMAT_LABELS = {
  txt: "TXT 文本",
  md: "Markdown 文档",
  pdf: "PDF 文档",
  srt: "SRT 字幕",
  vtt: "VTT 字幕",
  json: "JSON 数据",
};

const REVIEW_EXPORT_FORMATS = new Set(["txt", "md", "pdf", "json"]);

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function setMessage(text, isError = false) {
  const message = $("#message");
  message.textContent = text || "";
  message.classList.toggle("error", Boolean(isError));
}

function setInlineStatus(selector, text, tone = "neutral") {
  const element = $(selector);
  const normalizedTone = tone === true ? "error" : tone;
  element.textContent = text || "";
  element.classList.toggle("error", normalizedTone === "error");
  element.classList.toggle("loading", normalizedTone === "loading");
  element.classList.toggle("success", normalizedTone === "success");
}

function setStatus(element, status, text) {
  element.className = `status ${status || "idle"}`;
  element.textContent = text || statusText(status);
}

function statusText(status) {
  return {
    idle: "空闲",
    running: "识别中",
    completed: "完成",
    failed: "失败",
    ok: "可用",
  }[status] || status || "空闲";
}

function formatBytes(bytes) {
  if (!bytes) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatTime(seconds) {
  const ms = Math.round(Math.max(Number(seconds) || 0, 0) * 1000);
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function exportFilePresentation(file) {
  const rawFormat = String(file?.format || "");
  if (rawFormat.startsWith("ai-review-")) {
    const format = rawFormat.replace(/^ai-review-/, "");
    return { format, source: "STEP 2 修改", sourceClass: "review", isAI: true };
  }
  if (rawFormat.startsWith("ai-")) {
    const format = rawFormat.replace(/^ai-/, "");
    return { format, source: "AI 整理", sourceClass: "ai", isAI: true };
  }
  return { format: rawFormat, source: "常规导出", sourceClass: "", isAI: false };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let detail = `请求失败：${response.status}`;
    try {
      const data = await response.json();
      detail = data.detail || detail;
    } catch (_) {
      detail = await response.text();
    }
    throw new Error(detail);
  }
  return response.json();
}

async function copyText(text) {
  if (!text) return;
  await navigator.clipboard.writeText(text);
  setMessage("已复制到剪贴板。");
}

async function loadHealth({ silent = false } = {}) {
  try {
    const health = await api("/api/health");
    state.aiConfig = health.ai || { configured: false, model: "deepseek-v4-flash" };
    $("#outputDir").textContent = health.output_dir || "outputs/";
    setStatus($("#backendStatus"), "completed", "服务可用");
    setStatus(
      $("#aiStatus"),
      state.aiConfig.configured ? "completed" : "idle",
      state.aiConfig.configured ? `${state.aiConfig.model} 可用` : "AI 未配置",
    );
    updateAIAvailability();
    return health;
  } catch (error) {
    setStatus($("#backendStatus"), "failed", "服务不可用");
    setStatus($("#aiStatus"), "failed", "AI 状态未知");
    if (!silent) setMessage(error.message, true);
    updateAIAvailability();
    return null;
  }
}

async function ensureAIReady(statusSelector) {
  setInlineStatus(statusSelector, "正在确认 DeepSeek 配置…", "loading");
  const health = await loadHealth({ silent: true });
  if (!health) {
    setInlineStatus(statusSelector, "无法连接本地服务，请确认服务正在运行后重试。", "error");
    return false;
  }
  if (!health.ai?.configured) {
    setInlineStatus(
      statusSelector,
      "DeepSeek API Key 尚未生效。请检查 .env 中的 DEEPSEEK_API_KEY 并重启服务。",
      "error",
    );
    return false;
  }
  return true;
}

async function loadRecords() {
  state.records = await api("/api/transcriptions");
  renderHistory();
}

async function loadRecord(id) {
  const record = await api(`/api/transcriptions/${encodeURIComponent(id)}`);
  state.currentRecord = record;
  state.selectedExportIds.clear();
  state.exportSourceId = "record";
  setInlineStatus("#exportBatchStatus", "", "neutral");
  resetVersionComparison();
  renderCurrentRecord();
  await loadTextVersions({ resetDefaults: true });
}

function renderHistory() {
  const list = $("#historyList");
  if (!state.records.length) {
    list.innerHTML = '<p class="message">暂无历史记录</p>';
    return;
  }
  list.innerHTML = "";
  state.records.forEach((record) => {
    const item = document.createElement("button");
    item.className = `history-item${state.currentRecord?.id === record.id ? " selected" : ""}`;
    item.innerHTML = `
      <strong class="history-title">${escapeHtml(record.original_filename)}</strong>
      <span class="history-meta">${statusText(record.status)} · ${escapeHtml(record.created_at || "-")} · ${record.elapsed_seconds || "-"}s</span>
    `;
    item.addEventListener("click", () => loadRecord(record.id));
    list.appendChild(item);
  });
}

function renderCurrentRecord() {
  const record = state.currentRecord;
  if (!record) return;
  $("#recordTitle").textContent = record.original_filename;
  $("#recordSub").textContent = `${record.id} · ${record.model_name || "-"}`;
  setStatus($("#recordStatus"), record.status);
  setStatus(
    $("#backendStatus"),
    record.status === "running" ? "running" : "completed",
    record.status === "running" ? "识别中" : "服务可用",
  );
  $("#textEditor").value = record.text || "";
  $("#textStats").textContent = `字数 ${(record.text || "").length} · 分段 ${(record.segments || []).length} · 语言 ${record.language || "-"}`;
  renderSegments();
  renderExports();
  renderExportSourceOptions();
  renderInfo();
  hydrateAIWorkspace();
  renderHistory();
  updateAIAvailability();
}

function renderSegments() {
  const body = $("#segmentsBody");
  const segments = state.currentRecord?.segments || [];
  if (!segments.length) {
    body.innerHTML = '<tr><td colspan="3">暂无分段</td></tr>';
    return;
  }
  body.innerHTML = "";
  segments.forEach((segment, index) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td class="time">${formatTime(segment.start)}</td>
      <td class="time">${formatTime(segment.end)}</td>
      <td><textarea class="segment-input" data-index="${index}">${escapeHtml(segment.text || "")}</textarea></td>
    `;
    body.appendChild(row);
  });
}

function renderExports() {
  const list = $("#exportList");
  const files = state.currentRecord?.export_files || [];
  const availableIds = new Set(files.map((file) => Number(file.id)));
  state.selectedExportIds = new Set(
    Array.from(state.selectedExportIds).filter((fileId) => availableIds.has(Number(fileId))),
  );
  if (!files.length) {
    list.innerHTML = '<p class="message">暂无导出文件</p>';
    $("#exportBatchToolbar").classList.add("hidden");
    updateExportSelectionUI();
    return;
  }
  $("#exportBatchToolbar").classList.remove("hidden");
  list.innerHTML = "";
  files.forEach((file) => {
    const fileId = Number(file.id);
    const presentation = exportFilePresentation(file);
    const baseFormat = presentation.format;
    const formatLabel = baseFormat === "md" ? "Markdown" : baseFormat.toUpperCase();
    const item = document.createElement("div");
    item.className = `export-item${state.selectedExportIds.has(fileId) ? " is-selected" : ""}`;
    item.dataset.exportFileId = String(fileId);
    item.innerHTML = `
      <label class="export-row-select">
        <input type="checkbox" data-export-select="${fileId}" aria-label="选择 ${escapeHtml(file.filename)}"${state.selectedExportIds.has(fileId) ? " checked" : ""} />
      </label>
      <span class="export-file-kind">
        <strong>${escapeHtml(formatLabel)}</strong>
        <span class="export-source-badge${presentation.sourceClass ? ` ${presentation.sourceClass}` : ""}">${escapeHtml(presentation.source)}</span>
      </span>
      <span class="path" title="${escapeHtml(file.absolute_path || file.path)}">${escapeHtml(file.path)}</span>
      <span class="export-file-size">${formatBytes(file.size)}</span>
      <span class="file-actions">
        <button data-copy="${escapeHtml(file.absolute_path || file.path)}" class="compact" aria-label="复制 ${escapeHtml(file.filename)} 的路径">复制路径</button>
        <a class="button-link compact" href="/api/files/${file.id}" aria-label="下载 ${escapeHtml(file.filename)}">下载</a>
        <button data-delete-export="${fileId}" class="compact delete-export-button" aria-label="删除 ${escapeHtml(file.filename)}">删除</button>
      </span>
    `;
    list.appendChild(item);
  });
  updateExportSelectionUI();
}

function selectedExportSource() {
  const sourceId = String(state.exportSourceId || "record");
  const match = sourceId.match(/^review:(\d+)$/);
  if (!match) return { source: "record", runId: null, version: null };
  const runId = Number(match[1]);
  const run = (state.currentRecord?.ai_runs || []).find(
    (item) => item.stage === "review" && Number(item.id) === runId,
  );
  const version = state.textVersions.find((item) => item.id === sourceId) || null;
  if (!run || !version) return { source: "record", runId: null, version: null };
  return { source: "review", runId, version, run };
}

function renderExportSourceOptions() {
  const select = $("#exportSourceSelect");
  const record = state.currentRecord;
  select.innerHTML = '<option value="record">当前识别结果</option>';
  const reviewVersions = state.textVersions.filter((version) => version.stage === "review");
  reviewVersions.forEach((version) => {
    const option = document.createElement("option");
    option.value = version.id;
    option.textContent = version.label;
    select.appendChild(option);
  });
  const availableIds = new Set(["record", ...reviewVersions.map((version) => version.id)]);
  if (!availableIds.has(state.exportSourceId)) state.exportSourceId = "record";
  select.value = state.exportSourceId;
  select.disabled = !record;
  updateExportFormatAvailability();
}

function updateExportFormatAvailability() {
  const selection = selectedExportSource();
  const isReview = selection.source === "review";
  $$('[data-export]').forEach((button) => {
    const supported = !isReview || REVIEW_EXPORT_FORMATS.has(button.dataset.export);
    button.disabled = state.exportBusy || !state.currentRecord || !supported;
    button.title = supported ? "" : "STEP 2 修改结果未同步字幕时间轴，不支持该格式。";
  });
  $("#exportAllBtn").disabled = state.exportBusy || !state.currentRecord || isReview;
  $("#exportAllBtn").title = isReview ? "STEP 2 修改结果仅支持 TXT、Markdown、PDF 和 JSON。" : "";
  if (!state.currentRecord) {
    $("#exportSourceDescription").textContent = "请先选择一条识别记录。";
    $("#exportFormatHint").textContent = "选择记录后可生成导出文件。";
    return;
  }
  if (!isReview) {
    $("#exportSourceDescription").textContent = `当前识别结果 · ${String(state.currentRecord.text || "").length} 字。`;
    $("#exportFormatHint").textContent = "当前识别结果支持全部格式。";
    return;
  }
  const hasUnsavedDraft = Number(state.currentReview?.id) === Number(selection.runId)
    && reviewHasUnsavedChanges();
  $("#exportSourceDescription").textContent = hasUnsavedDraft
    ? `已保存的 STEP 2 版本 #${selection.runId} · ${String(selection.version.text || "").length} 字。当前编辑区仍有未保存修改，不会纳入本次导出。`
    : `已保存的 STEP 2 人工修改版本 #${selection.runId} · ${String(selection.version.text || "").length} 字。`;
  $("#exportFormatHint").textContent = "STEP 2 结果支持 TXT、Markdown、PDF 和 JSON；由于未同步时间轴，SRT、VTT 与全部 ZIP 不可用。";
}

function handleExportSourceChange() {
  state.exportSourceId = $("#exportSourceSelect").value || "record";
  updateExportFormatAvailability();
  setInlineStatus("#exportBatchStatus", "", "neutral");
}

function selectedExportFiles() {
  const selectedIds = state.selectedExportIds;
  return (state.currentRecord?.export_files || []).filter((file) => selectedIds.has(Number(file.id)));
}

function updateExportSelectionUI() {
  const files = state.currentRecord?.export_files || [];
  const availableIds = new Set(files.map((file) => Number(file.id)));
  state.selectedExportIds = new Set(
    Array.from(state.selectedExportIds).filter((fileId) => availableIds.has(Number(fileId))),
  );
  const selectedCount = state.selectedExportIds.size;
  const selectAll = $("#selectAllExports");
  selectAll.checked = files.length > 0 && selectedCount === files.length;
  selectAll.indeterminate = selectedCount > 0 && selectedCount < files.length;
  selectAll.disabled = state.exportBusy || !files.length;
  $("#exportSelectionCount").textContent = `已选择 ${selectedCount} 个文件`;
  $("#downloadSelectedExportsBtn").disabled = state.exportBusy || selectedCount === 0;
  $("#deleteSelectedExportsBtn").disabled = state.exportBusy || selectedCount === 0;
  $$("[data-export-select]").forEach((checkbox) => {
    const selected = state.selectedExportIds.has(Number(checkbox.dataset.exportSelect));
    checkbox.checked = selected;
    checkbox.disabled = state.exportBusy;
    checkbox.closest(".export-item")?.classList.toggle("is-selected", selected);
  });
  $$("[data-delete-export]").forEach((button) => { button.disabled = state.exportBusy; });
}

function toggleAllExports(checked) {
  const files = state.currentRecord?.export_files || [];
  state.selectedExportIds = checked
    ? new Set(files.map((file) => Number(file.id)))
    : new Set();
  updateExportSelectionUI();
}

function handleExportSelectionChange(checkbox) {
  const fileId = Number(checkbox.dataset.exportSelect);
  if (checkbox.checked) state.selectedExportIds.add(fileId);
  else state.selectedExportIds.delete(fileId);
  updateExportSelectionUI();
}

function renderInfo() {
  const record = state.currentRecord;
  const info = $("#infoList");
  const rows = [
    ["记录 ID", record.id],
    ["原始文件", record.original_path],
    ["原始绝对路径", record.original_absolute_path],
    ["临时音频", record.temp_audio_path],
    ["输出目录", record.output_dir],
    ["输出绝对目录", record.output_absolute_dir],
    ["识别模型", record.model_name],
    ["语言", record.language || "-"],
    ["音频时长", record.duration ? `${record.duration}s` : "-"],
    ["识别耗时", record.elapsed_seconds ? `${record.elapsed_seconds}s` : "-"],
    ["最后更新", record.updated_at],
    ["错误信息", record.error_message || "-"],
  ];
  info.innerHTML = "";
  rows.forEach(([label, value]) => {
    const row = document.createElement("div");
    row.innerHTML = `
      <dt>${escapeHtml(label)}</dt>
      <dd class="info-value" title="${escapeHtml(value || "-")}">${escapeHtml(value || "-")}</dd>
      ${value && value !== "-" ? `<button data-copy="${escapeHtml(value)}" class="compact">复制</button>` : ""}
    `;
    info.appendChild(row);
  });
}

function latestRun(stage) {
  return (state.currentRecord?.ai_runs || [])
    .filter((run) => run.stage === stage)
    .sort((a, b) => Number(b.id) - Number(a.id))[0] || null;
}

function textVersion(versionId) {
  return state.textVersions.find((version) => version.id === versionId) || null;
}

function resetVersionComparison() {
  state.textVersions = [];
  state.leftVersionId = null;
  state.rightVersionId = null;
  state.currentReview = null;
  state.versionLoadId += 1;
  state.diffRequestId += 1;
  [$("#leftVersionSelect"), $("#rightVersionSelect")].forEach((select) => {
    select.disabled = true;
    select.innerHTML = "<option>正在加载版本…</option>";
  });
  $("#sourcePreview").textContent = "正在加载文本版本…";
  clearPostReviewDiff();
  clearReviewEditDiff();
  updateAIAvailability();
}

function renderVersionSelectors() {
  const selections = [
    [$("#leftVersionSelect"), state.leftVersionId],
    [$("#rightVersionSelect"), state.rightVersionId],
  ];
  selections.forEach(([select, selectedId]) => {
    select.innerHTML = "";
    state.textVersions.forEach((version) => {
      const option = document.createElement("option");
      option.value = version.id;
      option.textContent = version.label;
      option.selected = version.id === selectedId;
      select.appendChild(option);
    });
    select.disabled = !state.textVersions.length;
  });
}

async function loadTextVersions({ preferLeftId = null, resetDefaults = false, resetRightToOriginal = false } = {}) {
  const recordId = state.currentRecord?.id;
  if (!recordId) return;
  const loadId = ++state.versionLoadId;
  $("#sourcePreview").textContent = "正在加载文本版本…";
  try {
    const response = await api(`/api/transcriptions/${encodeURIComponent(recordId)}/versions`);
    if (state.currentRecord?.id !== recordId || loadId !== state.versionLoadId) return;
    state.textVersions = Array.isArray(response.versions) ? response.versions : [];
    const original = state.textVersions.find((version) => version.stage === "original") || state.textVersions[0] || null;
    const latestOrganized = state.textVersions.find((version) => version.stage === "organize") || null;
    const preferred = textVersion(preferLeftId);
    const previousLeft = textVersion(state.leftVersionId);
    const previousRight = textVersion(state.rightVersionId);

    if (resetDefaults) {
      state.leftVersionId = (preferred || latestOrganized || original)?.id || null;
      state.rightVersionId = original?.id || state.leftVersionId;
    } else {
      state.leftVersionId = (preferred || previousLeft || latestOrganized || original)?.id || null;
      state.rightVersionId = (resetRightToOriginal ? original : previousRight || original)?.id || state.leftVersionId;
    }
    renderVersionSelectors();
    renderSourcePreview();
    syncReviewForSelectedVersion();
    renderExportSourceOptions();
    updateAIAvailability();
  } catch (error) {
    if (state.currentRecord?.id !== recordId || loadId !== state.versionLoadId) return;
    $("#sourcePreview").textContent = error.message;
    clearPostReviewDiff();
    renderExportSourceOptions();
    updateAIAvailability();
  }
}

function renderSourcePreview() {
  const version = textVersion(state.leftVersionId);
  $("#sourcePreview").textContent = version?.text || "暂无可送检正文。";
}

function reviewRunForVersion(version) {
  if (!version) return null;
  const reviewRuns = (state.currentRecord?.ai_runs || [])
    .filter((run) => run.stage === "review")
    .sort((a, b) => Number(b.id) - Number(a.id));
  if (version.stage === "review") {
    const directRun = reviewRuns.find((run) => Number(run.id) === Number(version.run_id));
    if (directRun) return directRun;
  }
  return reviewRuns.find((run) => run.options?.source_version_id === version.id)
    || reviewRuns.find((run) => !run.options?.source_version_id && run.source_text === version.text)
    || null;
}

function syncReviewForSelectedVersion() {
  const run = reviewRunForVersion(textVersion(state.leftVersionId));
  renderReviewResult(run);
  if (run) refreshVersionDiff();
}

function clearPostReviewDiff() {
  state.diffRequestId += 1;
  $("#postReviewDiff").setAttribute("aria-busy", "false");
  $("#unifiedDiffText").textContent = "";
  $("#diffStats").textContent = "等待检查结果";
  setInlineStatus("#diffStatus", "", "neutral");
}

function renderUnifiedDiff(chunks) {
  return chunks.map((chunk) => {
    if (chunk.type === "equal") {
      return `<span class="diff-equal">${escapeHtml(chunk.left_text || chunk.right_text || "")}</span>`;
    }
    if (chunk.type === "left_only") {
      return `<span class="diff-added">${escapeHtml(chunk.left_text || "")}</span>`;
    }
    if (chunk.type === "right_only") {
      return `<span class="diff-removed">${escapeHtml(chunk.right_text || "")}</span>`;
    }
    return `<span class="diff-removed">${escapeHtml(chunk.right_text || "")}</span><span class="diff-added">${escapeHtml(chunk.left_text || "")}</span>`;
  }).join("");
}

function clearReviewEditDiff() {
  window.clearTimeout(state.reviewEditDiffTimer);
  state.reviewEditDiffTimer = null;
  state.reviewEditDiffRequestId += 1;
  const surface = $("#reviewEditDiffSurface");
  if (!surface) return;
  surface.setAttribute("aria-busy", "false");
  $("#reviewEditDiffText").textContent = "";
  $("#reviewEditDiffStats").textContent = "等待检查结果";
  setInlineStatus("#reviewEditDiffStatus", "", "neutral");
}

function scheduleReviewEditDiff({ immediate = false } = {}) {
  window.clearTimeout(state.reviewEditDiffTimer);
  state.reviewEditDiffTimer = null;
  state.reviewEditDiffRequestId += 1;
  if (!state.currentRecord || !state.currentReview) {
    clearReviewEditDiff();
    return;
  }
  $("#reviewEditDiffSurface").setAttribute("aria-busy", "true");
  setInlineStatus("#reviewEditDiffStatus", "正在同步本次修改…", "loading");
  if (immediate) {
    refreshReviewEditDiff();
    return;
  }
  state.reviewEditDiffTimer = window.setTimeout(refreshReviewEditDiff, 250);
}

async function refreshReviewEditDiff() {
  state.reviewEditDiffTimer = null;
  const recordId = state.currentRecord?.id;
  const runId = state.currentReview?.id;
  if (!recordId || !runId) {
    clearReviewEditDiff();
    return;
  }
  const requestId = ++state.reviewEditDiffRequestId;
  const surface = $("#reviewEditDiffSurface");
  surface.setAttribute("aria-busy", "true");
  try {
    const result = await api(
      `/api/transcriptions/${encodeURIComponent(recordId)}/ai/reviews/${encodeURIComponent(runId)}/diff`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: readReviewEditorText() }),
      },
    );
    if (
      requestId !== state.reviewEditDiffRequestId
      || state.currentRecord?.id !== recordId
      || Number(state.currentReview?.id) !== Number(runId)
    ) return;
    const chunks = Array.isArray(result.chunks) ? result.chunks : [];
    $("#reviewEditDiffText").innerHTML = renderUnifiedDiff(chunks) || '<span class="diff-empty">空文本</span>';
    if (result.identical) {
      $("#reviewEditDiffStats").textContent = "内容一致";
      setInlineStatus("#reviewEditDiffStatus", "与 AI 检查初稿一致。", "success");
    } else {
      const counts = result.counts || {};
      $("#reviewEditDiffStats").textContent = `新增 ${Number(counts.added_chars) || 0} · 删除 ${Number(counts.removed_chars) || 0} · 修改 ${Number(counts.changed_chars) || 0}`;
      setInlineStatus("#reviewEditDiffStatus", "已实时标出尚未保存的手动修改。", "success");
    }
  } catch (error) {
    if (requestId !== state.reviewEditDiffRequestId || state.currentRecord?.id !== recordId) return;
    setInlineStatus("#reviewEditDiffStatus", error.message, "error");
    $("#reviewEditDiffStats").textContent = "Diff 更新失败";
  } finally {
    if (requestId === state.reviewEditDiffRequestId) surface.setAttribute("aria-busy", "false");
  }
}

function syncReviewEditScroll(event) {
  if (state.reviewEditScrollSync || window.matchMedia("(max-width: 720px)").matches) return;
  const source = event.currentTarget;
  const target = source.id === "reviewEditDiffText" ? $("#reviewEditor") : $("#reviewEditDiffText");
  const sourceRange = source.scrollHeight - source.clientHeight;
  const targetRange = target.scrollHeight - target.clientHeight;
  if (sourceRange <= 0 || targetRange <= 0) return;
  state.reviewEditScrollSync = true;
  target.scrollTop = (source.scrollTop / sourceRange) * targetRange;
  window.requestAnimationFrame(() => { state.reviewEditScrollSync = false; });
}

async function refreshVersionDiff() {
  const recordId = state.currentRecord?.id;
  const reviewedVersion = state.currentReview?.id ? textVersion(`review:${state.currentReview.id}`) : null;
  const leftVersion = reviewedVersion || textVersion(state.leftVersionId);
  const rightVersion = textVersion(state.rightVersionId);
  if (!state.currentReview) {
    clearPostReviewDiff();
    return;
  }
  if (!recordId || !leftVersion || !rightVersion) {
    $("#unifiedDiffText").textContent = "暂无可对比版本。";
    $("#diffStats").textContent = "暂无版本";
    return;
  }

  const requestId = ++state.diffRequestId;
  const diffSurface = $("#postReviewDiff");
  diffSurface.setAttribute("aria-busy", "true");
  setInlineStatus("#diffStatus", "正在计算版本差异…", "loading");
  try {
    const result = await api(`/api/transcriptions/${encodeURIComponent(recordId)}/versions/diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        left_version_id: leftVersion.id,
        right_version_id: rightVersion.id,
      }),
    });
    if (requestId !== state.diffRequestId || state.currentRecord?.id !== recordId) return;
    const chunks = Array.isArray(result.chunks) ? result.chunks : [];
    $("#unifiedDiffText").innerHTML = renderUnifiedDiff(chunks) || '<span class="diff-empty">空文本</span>';
    if (result.identical) {
      $("#diffStats").textContent = "内容一致 · 0 处差异";
      setInlineStatus("#diffStatus", "两个版本内容一致。", "success");
    } else {
      const counts = result.counts || {};
      $("#diffStats").textContent = `新增 ${Number(counts.added_chars) || 0} 字 · 删除 ${Number(counts.removed_chars) || 0} 字 · 修改 ${Number(counts.changed_chars) || 0} 字`;
      setInlineStatus("#diffStatus", "已在左侧统一标出相对对照版本的变化。", "success");
    }
    $("#unifiedDiffText").scrollTop = 0;
  } catch (error) {
    if (requestId !== state.diffRequestId || state.currentRecord?.id !== recordId) return;
    setInlineStatus("#diffStatus", error.message, "error");
    $("#diffStats").textContent = "Diff 计算失败";
  } finally {
    if (requestId === state.diffRequestId) diffSurface.setAttribute("aria-busy", "false");
  }
}

function handleVersionSelection(side) {
  if (side === "left") {
    state.leftVersionId = $("#leftVersionSelect").value;
    renderSourcePreview();
    syncReviewForSelectedVersion();
  } else {
    state.rightVersionId = $("#rightVersionSelect").value;
    refreshVersionDiff();
  }
  updateAIAvailability();
}

function hydrateAIWorkspace() {
  const record = state.currentRecord;
  const organized = latestRun("organize");
  const review = latestRun("review");
  const analysis = latestRun("analysis");
  const contentRuns = [organized, review]
    .filter(Boolean)
    .filter((run) => String(run.updated_at || "") >= String(record.updated_at || ""))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || Number(b.id) - Number(a.id));
  const workingRun = contentRuns[0];

  state.workingText = workingRun?.result_text || record.text || "";
  state.workingSource = workingRun
    ? `${workingRun.stage === "review" ? "检查版本" : "整理版本"} #${workingRun.id}`
    : "原始识别结果";
  $("#workingSource").textContent = `当前输入 · ${state.workingSource}`;

  renderOrganizedResult(organized);
  renderReviewResult(null);
  renderAnalysisResult(analysis);
}

function renderOrganizedResult(run) {
  const surface = $("#organizedResult");
  if (!run) {
    surface.classList.add("hidden");
    $("#organizedPreview").value = "";
    return;
  }
  surface.classList.remove("hidden");
  $("#organizedPreview").value = run.result_text || "";
  const ids = new Set(run.result?.export_file_ids || []);
  const files = (state.currentRecord?.export_files || []).filter((file) => ids.has(file.id));
  const fileList = $("#organizedFiles");
  if (!files.length) {
    fileList.innerHTML = '<span class="muted-text">本次未生成独立文件，结果已保存为处理版本。</span>';
    return;
  }
  fileList.innerHTML = files.map((file) => `
    <a class="artifact" href="/api/files/${file.id}">
      <span>${escapeHtml(file.format.replace("ai-", "").toUpperCase())}</span>
      <strong>${escapeHtml(file.filename)}</strong>
      <small>${formatBytes(file.size)} · 下载</small>
    </a>
  `).join("");
}

function renderReviewResult(run) {
  const workspace = $("#reviewWorkspace");
  state.currentReview = run;
  state.resolvedIssueIds = new Set();
  if (!run) {
    workspace.classList.add("hidden");
    $("#reviewEditor").innerHTML = "";
    $("#issueList").innerHTML = "";
    clearPostReviewDiff();
    clearReviewEditDiff();
    setInlineStatus("#reviewActionStatus", "", "neutral");
    updateReviewSaveUI();
    return;
  }
  workspace.classList.remove("hidden");
  const text = run.result_text || run.source_text || "";
  const issues = Array.isArray(run.result?.issues) ? run.result.issues : [];
  $("#reviewEditor").innerHTML = highlightedTextHtml(text, issues);
  renderIssueList();
  setInlineStatus("#reviewActionStatus", "保存后可在“导出结果”中选择该 STEP 2 版本。", "neutral");
  updateReviewSaveUI();
  scheduleReviewEditDiff({ immediate: true });
}

function highlightedTextHtml(text, issues) {
  const activeIssues = issues
    .filter((issue) => !issue.resolved)
    .sort((a, b) => Number(a.start) - Number(b.start));
  let cursor = 0;
  let html = "";
  activeIssues.forEach((issue) => {
    const start = Number(issue.start);
    const end = Number(issue.end);
    if (start < cursor || end <= start || text.slice(start, end) !== issue.text) return;
    html += escapeHtml(text.slice(cursor, start));
    html += `<mark data-issue-id="${escapeHtml(issue.id)}" data-original="${escapeHtml(issue.text)}">${escapeHtml(issue.text)}</mark>`;
    cursor = end;
  });
  html += escapeHtml(text.slice(cursor));
  return html;
}

function activeReviewIssues() {
  const issues = Array.isArray(state.currentReview?.result?.issues) ? state.currentReview.result.issues : [];
  return issues.filter((issue) => !issue.resolved && !state.resolvedIssueIds.has(String(issue.id)));
}

function renderIssueList() {
  const issues = activeReviewIssues();
  $("#issueCount").textContent = String(issues.length);
  const list = $("#issueList");
  if (!issues.length) {
    list.innerHTML = `
      <div class="empty-state success-state">
        <span aria-hidden="true">✓</span><strong>已处理全部标记</strong><small>保存修改后即可进入分析。</small>
      </div>`;
    return;
  }
  list.innerHTML = issues.map((issue) => `
    <article class="issue-card" data-issue-card="${escapeHtml(issue.id)}">
      <button class="issue-jump" data-issue-focus="${escapeHtml(issue.id)}">
        <strong>${escapeHtml(issue.text)}</strong><span>${Math.round(Number(issue.confidence || 0) * 100)}%</span>
      </button>
      <p>${escapeHtml(issue.reason || "疑似不符合当前语境。")}</p>
      ${issue.suggestion ? `
        <div class="suggestion"><span>建议</span><strong>${escapeHtml(issue.suggestion)}</strong></div>
        <button class="apply-suggestion" data-issue-apply="${escapeHtml(issue.id)}">采用建议</button>
      ` : ""}
    </article>
  `).join("");
}

function readReviewEditorText() {
  return $("#reviewEditor").innerText.replaceAll("\u00a0", " ").replace(/\n$/, "");
}

function reviewHasUnsavedChanges() {
  if (!state.currentReview || $("#reviewWorkspace").classList.contains("hidden")) return false;
  return readReviewEditorText() !== String(state.currentReview.result_text || "")
    || state.resolvedIssueIds.size > 0;
}

function updateReviewSaveUI() {
  const hasReview = Boolean(state.currentReview);
  const isDirty = hasReview && reviewHasUnsavedChanges();
  const saveState = $("#reviewSaveState");
  saveState.dataset.state = isDirty ? "dirty" : "saved";
  saveState.lastChild.textContent = isDirty ? "有未保存修改" : "已保存";
  $("#saveReviewBtn").disabled = !hasReview || state.reviewSaveBusy || !isDirty;
  updateExportFormatAvailability();
}

function setReviewSaveBusy(isBusy) {
  state.reviewSaveBusy = isBusy;
  $("#reviewEditor").setAttribute("aria-busy", String(isBusy));
  $("#saveReviewBtn").textContent = isBusy ? "正在保存…" : "保存 STEP 2 结果";
  updateReviewSaveUI();
}

function handleReviewEdit() {
  const editor = $("#reviewEditor");
  const issues = Array.isArray(state.currentReview?.result?.issues) ? state.currentReview.result.issues : [];
  const issueIds = new Set(issues.filter((issue) => !issue.resolved).map((issue) => String(issue.id)));
  editor.querySelectorAll("mark[data-issue-id]").forEach((mark) => {
    const issueId = mark.dataset.issueId;
    if (mark.textContent !== mark.dataset.original) {
      state.resolvedIssueIds.add(issueId);
      mark.replaceWith(document.createTextNode(mark.textContent));
    }
  });
  const remaining = new Set(
    Array.from(editor.querySelectorAll("mark[data-issue-id]")).map((mark) => mark.dataset.issueId),
  );
  issueIds.forEach((issueId) => {
    if (!remaining.has(issueId)) state.resolvedIssueIds.add(issueId);
  });
  editor.normalize();
  state.workingText = readReviewEditorText();
  renderIssueList();
  updateReviewSaveUI();
  scheduleReviewEditDiff();
}

function focusIssue(issueId) {
  const mark = $("#reviewEditor").querySelector(`mark[data-issue-id="${CSS.escape(issueId)}"]`);
  if (!mark) return;
  mark.scrollIntoView({ behavior: "smooth", block: "center" });
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(mark);
  selection.removeAllRanges();
  selection.addRange(range);
}

function applySuggestion(issueId) {
  const issues = Array.isArray(state.currentReview?.result?.issues) ? state.currentReview.result.issues : [];
  const issue = issues.find((item) => String(item.id) === issueId);
  const mark = $("#reviewEditor").querySelector(`mark[data-issue-id="${CSS.escape(issueId)}"]`);
  if (!issue || !mark) return;
  mark.replaceWith(document.createTextNode(issue.suggestion || issue.text));
  state.resolvedIssueIds.add(issueId);
  $("#reviewEditor").normalize();
  state.workingText = readReviewEditorText();
  renderIssueList();
  updateReviewSaveUI();
  scheduleReviewEditDiff();
}

function renderAnalysisResult(run) {
  const container = $("#analysisResult");
  if (!run || !run.result) {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }
  const result = run.result;
  const hasOverallScore = result.overall_score !== null && result.overall_score !== undefined && Number.isFinite(Number(result.overall_score));
  const score = hasOverallScore ? Math.max(0, Math.min(100, Number(result.overall_score))) : 0;
  const dimensions = Array.isArray(result.dimensions) ? result.dimensions : [];
  const questions = Array.isArray(result.questions) ? result.questions : [];
  const actions = Array.isArray(result.action_items) ? result.action_items : [];
  const uncertainties = Array.isArray(result.uncertainties) ? result.uncertainties : [];
  container.classList.remove("hidden");
  container.innerHTML = `
    <section class="analysis-overview">
      <div class="score-ring${hasOverallScore ? "" : " no-score"}" style="--score:${score}"><strong>${hasOverallScore ? Math.round(score) : "—"}</strong><span>${hasOverallScore ? "综合分" : "未评分"}</span></div>
      <div><span class="recommendation">${escapeHtml(result.hiring_recommendation || "信息不足")}</span>
        <h3>总体评价</h3><p>${escapeHtml(result.summary || "暂无总体评价。")}</p>
      </div>
    </section>
    ${dimensions.length ? `<section class="dimension-grid">${dimensions.map((item) => `
      <article><div><strong>${escapeHtml(item.name || "维度")}</strong><span>${Math.round(Number(item.score) || 0)}</span></div>
        <div class="score-bar"><i style="width:${Math.max(0, Math.min(100, Number(item.score) || 0))}%"></i></div>
        <p>${escapeHtml(item.comment || "")}</p></article>
    `).join("")}</section>` : ""}
    <section class="question-analysis">
      <div class="result-header"><div><span class="eyebrow">逐题复盘</span><h3>${questions.length} 道题目</h3></div></div>
      ${questions.length ? questions.map(renderQuestionAnalysis).join("") : '<p class="muted-text">未能从当前文本识别出明确题目。</p>'}
    </section>
    ${actions.length ? `<section class="action-list"><span class="eyebrow">提升建议</span><h3>下一步行动</h3>${renderStringList(actions)}</section>` : ""}
    ${uncertainties.length ? `<section class="uncertainty"><strong>分析限制</strong>${renderStringList(uncertainties)}</section>` : ""}
  `;
}

function renderQuestionAnalysis(item, index) {
  const hasAnswer = item.has_answer !== false && item.score !== null && item.score !== undefined;
  const scoreLabel = hasAnswer ? `${Math.round(Number(item.score) || 0)} 分` : "未评分";
  const focusAreas = Array.isArray(item.focus_areas) ? item.focus_areas.filter(Boolean) : [];
  return `
    <details class="question-card${hasAnswer ? "" : " no-answer"}" ${index === 0 ? "open" : ""}>
      <summary><span>Q${escapeHtml(item.index || index + 1)}</span><strong>${escapeHtml(item.question || "未识别题目")}</strong><b>${scoreLabel}</b></summary>
      <div class="question-body">
        ${hasAnswer ? `
          <div class="answer-summary"><span>回答摘要</span><p>${escapeHtml(item.answer_summary || "暂无回答摘要。")}</p></div>
          <div class="pros-cons">
            <div><h4>优点</h4>${renderStringList(item.strengths, "暂无明确优点")}</div>
            <div><h4>可改进</h4>${renderStringList(item.weaknesses, "暂无明确问题")}</div>
          </div>
          <div class="better-answer"><h4>更好的回答思路</h4><p>${escapeHtml(item.better_answer || "暂无建议。")}</p></div>
        ` : `
          <div class="no-answer-note"><strong>未识别到回答</strong><p>${escapeHtml(item.answer_summary || "当前转写中没有找到与该问题对应的回答，因此不评分。")}</p></div>
        `}
        ${focusAreas.length ? `<div class="focus-areas"><h4>考察方向</h4>${renderStringList(focusAreas)}</div>` : ""}
      </div>
    </details>
  `;
}

function renderStringList(items, fallback = "暂无") {
  const normalized = Array.isArray(items) ? items.filter(Boolean) : [];
  return `<ul>${(normalized.length ? normalized : [fallback]).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function updateAIAvailability() {
  const hasRecord = Boolean(state.currentRecord?.text);
  const hasReviewSource = Boolean(textVersion(state.leftVersionId)?.text);
  $$(".ai-action").forEach((button) => {
    const stage = button.id === "organizeBtn" ? "organize" : button.id === "reviewBtn" ? "review" : "analysis";
    const isBusy = state.busy.has(stage);
    const missingSource = stage === "review" && !hasReviewSource;
    button.disabled = !hasRecord || isBusy || missingSource;
    button.title = !hasRecord
      ? "请先选择一条有文本内容的识别记录"
      : missingSource
        ? "正在加载可送检的文本版本"
      : state.aiConfig?.configured
        ? ""
        : "点击后将重新检查 DeepSeek 配置";
  });
}

function setAIBusy(stage, busy, statusSelector = null, message = null) {
  if (busy) state.busy.add(stage);
  else state.busy.delete(stage);
  const button = $(`#${stage === "analysis" ? "analyze" : stage}Btn`);
  const labels = AI_BUTTON_LABELS[stage];
  if (button && labels) {
    button.textContent = busy ? labels.busy : labels.idle;
    button.classList.toggle("is-loading", busy);
    button.setAttribute("aria-busy", busy ? "true" : "false");
  }
  if (statusSelector && message !== null) setInlineStatus(statusSelector, message, busy ? "loading" : "neutral");
  updateAIAvailability();
}

function activateMainTab(tabName) {
  $$(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === tabName));
  $$(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `tab-${tabName}`));
}

function activateAIStage(stage) {
  $$(".workflow-step").forEach((button) => button.classList.toggle("active", button.dataset.aiStage === stage));
  $$(".workflow-panel").forEach((panel) => panel.classList.toggle("active", panel.dataset.aiPanel === stage));
}

function currentWorkingText() {
  if (state.currentReview && !$("#reviewWorkspace").classList.contains("hidden")) {
    const editorText = readReviewEditorText();
    if (editorText) return editorText;
  }
  return state.workingText || state.currentRecord?.text || "";
}

async function startTranscription() {
  if (!state.selectedFile) {
    setMessage("请选择一个音频或视频文件。", true);
    return;
  }
  const form = new FormData();
  form.append("file", state.selectedFile);
  form.append("language", $("#languageSelect").value);
  form.append("model_mode", $("#modelSelect").value);
  form.append("word_timestamps", $("#wordTimestamps").checked ? "true" : "false");
  $("#transcribeBtn").disabled = true;
  setStatus($("#backendStatus"), "running", "识别中");
  setMessage("正在识别，首次加载或下载 FunASR 模型可能需要较长时间。");
  try {
    state.currentRecord = await api("/api/transcriptions", { method: "POST", body: form });
    await loadRecords();
    resetVersionComparison();
    renderCurrentRecord();
    await loadTextVersions({ resetDefaults: true });
    setMessage("识别完成，可进入智能处理。");
  } catch (error) {
    setStatus($("#backendStatus"), "failed", "失败");
    setMessage(error.message, true);
    await loadRecords().catch(() => {});
  } finally {
    $("#transcribeBtn").disabled = false;
  }
}

function collectSegments() {
  const segments = (state.currentRecord?.segments || []).map((segment) => ({ ...segment }));
  $$(".segment-input").forEach((input) => {
    const index = Number(input.dataset.index);
    if (segments[index]) segments[index].text = input.value;
  });
  return segments;
}

async function saveCurrentRecord(useSegments = true) {
  if (!state.currentRecord) {
    setMessage("暂无可保存记录。", true);
    return;
  }
  try {
    state.currentRecord = await api(`/api/transcriptions/${encodeURIComponent(state.currentRecord.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: $("#textEditor").value,
        segments: useSegments ? collectSegments() : state.currentRecord.segments || [],
      }),
    });
    renderCurrentRecord();
    await loadRecords();
    setMessage("修改已保存。");
  } catch (error) {
    setMessage(error.message, true);
  }
}

async function organizeContent() {
  if (!state.currentRecord) return setInlineStatus("#organizeStatus", "请先选择一条识别记录。", true);
  const operations = $$('input[name="organizeOperation"]:checked').map((input) => input.value);
  if (!operations.length) return setInlineStatus("#organizeStatus", "请至少选择一项整理功能。", true);
  setAIBusy("organize", true, "#organizeStatus", "正在确认 DeepSeek 配置…");
  try {
    if (!(await ensureAIReady("#organizeStatus"))) return;
    setInlineStatus("#organizeStatus", "正在整理并生成结果，请稍候…", "loading");
    const response = await api(`/api/transcriptions/${encodeURIComponent(state.currentRecord.id)}/ai/organize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: state.currentRecord.text,
        operations,
        save_as_new: $("#saveAsNew").checked,
        sync_subtitles: $("#syncSubtitles").checked,
        save_markdown: $("#saveMarkdown").checked,
      }),
    });
    state.currentRecord = response.record;
    renderCurrentRecord();
    await loadTextVersions({
      preferLeftId: `organize:${response.run.id}`,
      resetRightToOriginal: true,
    });
    activateAIStage("organize");
    setInlineStatus("#organizeStatus", `整理完成 · 版本 #${response.run.id}`, "success");
    setMessage("智能整理完成，结果已作为后续检查与分析的输入。");
  } catch (error) {
    setInlineStatus("#organizeStatus", error.message, "error");
  } finally {
    setAIBusy("organize", false);
  }
}

async function startReview() {
  if (!state.currentRecord) return setInlineStatus("#reviewStatus", "请先选择一条识别记录。", true);
  const sourceVersion = textVersion(state.leftVersionId);
  if (!sourceVersion?.text) return setInlineStatus("#reviewStatus", "请选择左侧送检版本。", true);
  const sourceText = sourceVersion.text;
  setAIBusy("review", true, "#reviewStatus", "正在确认 DeepSeek 配置…");
  try {
    if (!(await ensureAIReady("#reviewStatus"))) return;
    setInlineStatus("#reviewStatus", "正在检查上下文与非常用词…", "loading");
    const response = await api(`/api/transcriptions/${encodeURIComponent(state.currentRecord.id)}/ai/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source_version_id: sourceVersion.id,
        text: sourceText,
      }),
    });
    state.currentRecord.ai_runs = [response.run, ...(state.currentRecord.ai_runs || [])];
    state.workingText = sourceText;
    state.workingSource = `检查版本 #${response.run.id}`;
    $("#workingSource").textContent = `当前输入 · ${state.workingSource}`;
    renderReviewResult(response.run);
    await loadTextVersions();
    setInlineStatus("#reviewStatus", `检查完成 · ${response.issue_count} 处待确认`, "success");
  } catch (error) {
    setInlineStatus("#reviewStatus", error.message, "error");
  } finally {
    setAIBusy("review", false);
  }
}

async function saveReview() {
  if (!state.currentRecord || !state.currentReview) return null;
  const text = readReviewEditorText();
  if (!text.trim()) {
    setInlineStatus("#reviewActionStatus", "STEP 2 正文不能为空。", "error");
    return null;
  }
  if (!reviewHasUnsavedChanges()) {
    setInlineStatus(
      "#reviewActionStatus",
      "当前 STEP 2 结果已保存，可在“导出结果”中选择。",
      "success",
    );
    return state.currentReview;
  }
  const recordId = state.currentRecord.id;
  const runId = state.currentReview.id;
  setReviewSaveBusy(true);
  setInlineStatus("#reviewActionStatus", "正在保存 STEP 2 修改…", "loading");
  try {
    const response = await api(
      `/api/transcriptions/${encodeURIComponent(recordId)}/ai/reviews/${encodeURIComponent(runId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, resolved_issue_ids: Array.from(state.resolvedIssueIds) }),
      },
    );
    if (state.currentRecord?.id !== recordId || Number(state.currentReview?.id) !== Number(runId)) return null;
    state.currentRecord.ai_runs = [
      response.run,
      ...(state.currentRecord.ai_runs || []).filter((run) => run.id !== response.run.id),
    ];
    state.workingText = response.run.result_text;
    state.workingSource = `检查版本 #${response.run.id}`;
    $("#workingSource").textContent = `当前输入 · ${state.workingSource}`;
    renderReviewResult(response.run);
    await loadTextVersions({ preferLeftId: `review:${response.run.id}` });
    setInlineStatus(
      "#reviewActionStatus",
      "STEP 2 人工修改结果已明确保存，可前往“导出结果”选择该版本。",
      "success",
    );
    return response.run;
  } catch (error) {
    setInlineStatus("#reviewActionStatus", error.message, "error");
    return null;
  } finally {
    setReviewSaveBusy(false);
  }
}

async function analyzeContent() {
  if (!state.currentRecord) return setInlineStatus("#analysisStatus", "请先选择一条识别记录。", true);
  setAIBusy("analysis", true, "#analysisStatus", "正在确认 DeepSeek 配置…");
  try {
    if (!(await ensureAIReady("#analysisStatus"))) return;
    setInlineStatus("#analysisStatus", "正在逐题分析面试回答…", "loading");
    const response = await api(`/api/transcriptions/${encodeURIComponent(state.currentRecord.id)}/ai/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: currentWorkingText(), preset: $("#analysisPreset").value }),
    });
    state.currentRecord.ai_runs = [response.run, ...(state.currentRecord.ai_runs || [])];
    renderAnalysisResult(response.run);
    setInlineStatus("#analysisStatus", `分析完成 · 版本 #${response.run.id}`, "success");
  } catch (error) {
    setInlineStatus("#analysisStatus", error.message, "error");
  } finally {
    setAIBusy("analysis", false);
  }
}

function setExportBusy(isBusy) {
  state.exportBusy = isBusy;
  $$('[data-export], #exportAllBtn').forEach((button) => { button.disabled = isBusy; });
  $("#confirmExportBtn").disabled = isBusy;
  $("#confirmDeleteExportBtn").disabled = isBusy;
  $("#exportConfirmDialog").setAttribute("aria-busy", String(isBusy));
  $("#deleteExportDialog").setAttribute("aria-busy", String(isBusy));
  updateExportSelectionUI();
  updateReviewSaveUI();
}

function openExportConfirmation(format, { source = "record", runId = null } = {}) {
  if (!state.currentRecord) return setMessage("暂无可导出记录。", true);
  if (state.exportBusy) return;
  const isAll = format === "all";
  const isReview = source === "review";
  const formatLabel = EXPORT_FORMAT_LABELS[format];
  if (!isAll && !formatLabel) return setMessage("导出格式不支持。", true);
  const reviewRun = isReview
    ? (state.currentRecord.ai_runs || []).find(
      (run) => run.stage === "review" && Number(run.id) === Number(runId),
    )
    : null;
  if (isReview && (!reviewRun || isAll || !REVIEW_EXPORT_FORMATS.has(format))) {
    return setInlineStatus("#exportBatchStatus", "所选 STEP 2 版本或导出格式已不可用，请重新选择。", "error");
  }
  state.pendingExport = { format, recordId: state.currentRecord.id, source, runId };
  $("#exportConfirmTitle").textContent = isAll
    ? "生成全部导出文件？"
    : isReview ? `导出 STEP 2 ${formatLabel}？` : `生成 ${formatLabel}？`;
  $("#exportConfirmDescription").textContent = isAll
    ? "确认后将生成六种格式文件，并额外打包为一个 ZIP。"
    : isReview
      ? `确认后将从已保存的 STEP 2 版本 #${runId} 生成一个 ${formatLabel}。`
      : `确认后将从当前识别结果生成一个 ${formatLabel}。`;
  $("#exportConfirmRecord").textContent = state.currentRecord.original_filename || state.currentRecord.id;
  $("#exportConfirmScope").textContent = isAll
    ? "TXT、Markdown、PDF、SRT、VTT、JSON 与 ZIP"
    : isReview ? `STEP 2 人工修改结果 · ${formatLabel}` : formatLabel;
  $("#confirmExportBtn").textContent = isAll
    ? "确认生成全部文件"
    : `确认生成 ${formatLabel}`;
  const dialog = $("#exportConfirmDialog");
  if (!dialog.open) dialog.showModal();
  window.requestAnimationFrame(() => $("#confirmExportBtn").focus());
}

function closeExportConfirmation() {
  const dialog = $("#exportConfirmDialog");
  if (dialog.open) dialog.close();
  state.pendingExport = null;
}

async function confirmExportGeneration() {
  const pending = state.pendingExport;
  if (!pending || state.exportBusy) return;
  if (!state.currentRecord || state.currentRecord.id !== pending.recordId) {
    closeExportConfirmation();
    return setMessage("当前记录已变化，请重新选择导出格式。", true);
  }
  closeExportConfirmation();
  if (pending.source === "review") await exportReviewFormat(pending);
  else if (pending.format === "all") await exportAll();
  else await exportFormat(pending.format);
}

function openSelectedExportConfirmation(format) {
  const selection = selectedExportSource();
  openExportConfirmation(format, {
    source: selection.source,
    runId: selection.runId,
  });
}

async function downloadResponseError(response) {
  let detail = `请求失败：${response.status}`;
  try {
    const data = await response.json();
    detail = data.detail || detail;
  } catch (_) {
    detail = await response.text();
  }
  return detail;
}

async function downloadSelectedExports() {
  const files = selectedExportFiles();
  if (!state.currentRecord || !files.length) {
    return setInlineStatus("#exportBatchStatus", "请先选择需要下载的文件。", "error");
  }
  const recordId = state.currentRecord.id;
  const fileIds = files.map((file) => Number(file.id));
  setExportBusy(true);
  setInlineStatus("#exportBatchStatus", `正在打包 ${files.length} 个文件…`, "loading");
  try {
    const response = await fetch(
      `/api/transcriptions/${encodeURIComponent(recordId)}/exports/download`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_ids: fileIds }),
      },
    );
    if (!response.ok) throw new Error(await downloadResponseError(response));
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = `${recordId}-selected-exports.zip`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    setInlineStatus("#exportBatchStatus", `已打包下载 ${files.length} 个文件。`, "success");
  } catch (error) {
    setInlineStatus("#exportBatchStatus", error.message, "error");
  } finally {
    setExportBusy(false);
  }
}

function openDeleteExportConfirmation(fileIds) {
  if (!state.currentRecord || state.exportBusy) return;
  const requestedIds = new Set(fileIds.map(Number));
  const files = (state.currentRecord.export_files || []).filter((file) => requestedIds.has(Number(file.id)));
  if (!files.length) return setInlineStatus("#exportBatchStatus", "请选择需要删除的文件。", "error");
  state.pendingExportDeletion = {
    recordId: state.currentRecord.id,
    fileIds: files.map((file) => Number(file.id)),
  };
  $("#deleteExportTitle").textContent = files.length === 1
    ? `删除 ${files[0].filename}？`
    : `删除选中的 ${files.length} 个文件？`;
  $("#deleteExportDescription").textContent = files.length === 1
    ? "文件将从磁盘和导出列表中永久删除，此操作无法撤销。"
    : "所选文件将从磁盘和导出列表中永久删除，此操作无法撤销。";
  $("#deleteExportList").innerHTML = files.map((file) => {
    const presentation = exportFilePresentation(file);
    return `<li><strong>${escapeHtml(file.filename)}</strong><span>${escapeHtml(presentation.source)}</span></li>`;
  }).join("");
  $("#confirmDeleteExportBtn").textContent = files.length === 1 ? "确认删除文件" : `确认删除 ${files.length} 个文件`;
  const dialog = $("#deleteExportDialog");
  if (!dialog.open) dialog.showModal();
  window.requestAnimationFrame(() => $("#cancelDeleteExportBtn").focus());
}

function closeDeleteExportConfirmation() {
  const dialog = $("#deleteExportDialog");
  if (dialog.open) dialog.close();
  state.pendingExportDeletion = null;
}

async function confirmDeleteExports() {
  const pending = state.pendingExportDeletion;
  if (!pending || state.exportBusy) return;
  if (!state.currentRecord || state.currentRecord.id !== pending.recordId) {
    closeDeleteExportConfirmation();
    return setInlineStatus("#exportBatchStatus", "当前记录已变化，请重新选择文件。", "error");
  }
  const fileIds = [...pending.fileIds];
  closeDeleteExportConfirmation();
  setExportBusy(true);
  setInlineStatus("#exportBatchStatus", `正在删除 ${fileIds.length} 个文件…`, "loading");
  try {
    const response = await api(
      `/api/transcriptions/${encodeURIComponent(state.currentRecord.id)}/exports/delete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_ids: fileIds }),
      },
    );
    state.currentRecord = response.record;
    fileIds.forEach((fileId) => state.selectedExportIds.delete(Number(fileId)));
    renderCurrentRecord();
    activateMainTab("exports");
    setInlineStatus("#exportBatchStatus", `已删除 ${fileIds.length} 个文件。`, "success");
  } catch (error) {
    setInlineStatus("#exportBatchStatus", error.message, "error");
  } finally {
    setExportBusy(false);
  }
}

async function exportReviewFormat(pending) {
  const reviewRun = (state.currentRecord?.ai_runs || []).find(
    (run) => run.stage === "review" && Number(run.id) === Number(pending.runId),
  );
  if (!state.currentRecord || state.currentRecord.id !== pending.recordId || !reviewRun) {
    return setInlineStatus("#exportBatchStatus", "所选 STEP 2 已保存版本不再可用，请重新选择。", "error");
  }
  const recordId = state.currentRecord.id;
  const runId = reviewRun.id;
  const formatLabel = EXPORT_FORMAT_LABELS[pending.format] || pending.format.toUpperCase();
  setExportBusy(true);
  setInlineStatus("#exportBatchStatus", `正在从 STEP 2 已保存版本 #${runId} 生成 ${formatLabel}…`, "loading");
  try {
    const result = await api(
      `/api/transcriptions/${encodeURIComponent(recordId)}/ai/reviews/${encodeURIComponent(runId)}/exports`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format: pending.format }),
      },
    );
    if (state.currentRecord?.id !== recordId) return;
    state.currentRecord = result.record;
    state.selectedExportIds.add(Number(result.export_file.id));
    renderExports();
    renderExportSourceOptions();
    renderInfo();
    renderHistory();
    setInlineStatus(
      "#exportBatchStatus",
      `STEP 2 ${formatLabel} 已生成并选中，可直接下载。`,
      "success",
    );
    setMessage(`STEP 2 已保存版本 #${runId} 已导出。`);
  } catch (error) {
    setInlineStatus("#exportBatchStatus", error.message, "error");
    setMessage(error.message, true);
  } finally {
    setExportBusy(false);
  }
}

async function exportFormat(format) {
  if (!state.currentRecord) return setMessage("暂无可导出记录。", true);
  setExportBusy(true);
  setMessage(`正在生成 ${EXPORT_FORMAT_LABELS[format] || format.toUpperCase()}…`);
  try {
    const result = await api(`/api/transcriptions/${encodeURIComponent(state.currentRecord.id)}/exports`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format }),
    });
    state.currentRecord = result.record;
    renderCurrentRecord();
    activateMainTab("exports");
    setMessage("导出完成。");
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    setExportBusy(false);
  }
}

async function exportAll() {
  if (!state.currentRecord) return setMessage("暂无可导出记录。", true);
  setExportBusy(true);
  setMessage("正在生成全部格式和 ZIP…");
  try {
    const result = await api(`/api/transcriptions/${encodeURIComponent(state.currentRecord.id)}/exports/all`, { method: "POST" });
    state.currentRecord = result.record;
    renderCurrentRecord();
    activateMainTab("exports");
    setMessage("全部导出完成。");
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    setExportBusy(false);
  }
}

function setupEvents() {
  $("#fileInput").addEventListener("change", (event) => {
    state.selectedFile = event.target.files[0] || null;
    renderSelectedFile();
  });
  const dropzone = $("#dropzone");
  dropzone.addEventListener("dragover", (event) => { event.preventDefault(); dropzone.classList.add("dragging"); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragging"));
  dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragging");
    state.selectedFile = event.dataTransfer.files[0] || null;
    $("#fileInput").files = event.dataTransfer.files;
    renderSelectedFile();
  });

  $("#transcribeBtn").addEventListener("click", startTranscription);
  $("#refreshBtn").addEventListener("click", () => loadRecords().catch((error) => setMessage(error.message, true)));
  $("#saveTextBtn").addEventListener("click", () => saveCurrentRecord(false));
  $("#saveSegmentsBtn").addEventListener("click", () => saveCurrentRecord(true));
  $("#exportAllBtn").addEventListener("click", () => openSelectedExportConfirmation("all"));
  $$("[data-export]").forEach((button) => button.addEventListener("click", () => openSelectedExportConfirmation(button.dataset.export)));
  $("#exportSourceSelect").addEventListener("change", handleExportSourceChange);
  $("#confirmExportBtn").addEventListener("click", confirmExportGeneration);
  $("#cancelExportBtn").addEventListener("click", closeExportConfirmation);
  $("#selectAllExports").addEventListener("change", (event) => toggleAllExports(event.target.checked));
  $("#downloadSelectedExportsBtn").addEventListener("click", downloadSelectedExports);
  $("#deleteSelectedExportsBtn").addEventListener("click", () => {
    openDeleteExportConfirmation(Array.from(state.selectedExportIds));
  });
  $("#exportList").addEventListener("change", (event) => {
    const checkbox = event.target.closest("[data-export-select]");
    if (checkbox) handleExportSelectionChange(checkbox);
  });
  $("#exportConfirmDialog").addEventListener("cancel", (event) => {
    event.preventDefault();
    closeExportConfirmation();
  });
  $("#exportConfirmDialog").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeExportConfirmation();
  });
  $("#confirmDeleteExportBtn").addEventListener("click", confirmDeleteExports);
  $("#cancelDeleteExportBtn").addEventListener("click", closeDeleteExportConfirmation);
  $("#deleteExportDialog").addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDeleteExportConfirmation();
  });
  $("#deleteExportDialog").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeDeleteExportConfirmation();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if ($("#deleteExportDialog").open) {
      event.preventDefault();
      closeDeleteExportConfirmation();
    } else if ($("#exportConfirmDialog").open) {
      event.preventDefault();
      closeExportConfirmation();
    }
  });
  $$(".tab").forEach((button) => button.addEventListener("click", () => activateMainTab(button.dataset.tab)));
  $$(".workflow-step").forEach((button) => button.addEventListener("click", () => activateAIStage(button.dataset.aiStage)));

  $("#organizeBtn").addEventListener("click", organizeContent);
  $("#reviewBtn").addEventListener("click", startReview);
  $("#saveReviewBtn").addEventListener("click", () => saveReview());
  $("#analyzeBtn").addEventListener("click", analyzeContent);
  $("#copyOrganizedBtn").addEventListener("click", () => copyText($("#organizedPreview").value));
  $("#reviewEditor").addEventListener("input", handleReviewEdit);
  $("#reviewEditor").addEventListener("scroll", syncReviewEditScroll, { passive: true });
  $("#reviewEditDiffText").addEventListener("scroll", syncReviewEditScroll, { passive: true });
  $("#leftVersionSelect").addEventListener("change", () => handleVersionSelection("left"));
  $("#rightVersionSelect").addEventListener("change", () => handleVersionSelection("right"));
  window.addEventListener("focus", () => loadHealth({ silent: true }));

  document.body.addEventListener("click", async (event) => {
    const deleteExportButton = event.target.closest("[data-delete-export]");
    if (deleteExportButton) {
      openDeleteExportConfirmation([Number(deleteExportButton.dataset.deleteExport)]);
      return;
    }
    const copyButton = event.target.closest("[data-copy]");
    if (copyButton) {
      await copyText(copyButton.dataset.copy).catch((error) => setMessage(error.message, true));
      return;
    }
    const focusButton = event.target.closest("[data-issue-focus]");
    if (focusButton) return focusIssue(focusButton.dataset.issueFocus);
    const applyButton = event.target.closest("[data-issue-apply]");
    if (applyButton) applySuggestion(applyButton.dataset.issueApply);
  });
}

function renderSelectedFile() {
  const file = state.selectedFile;
  $("#fileLabel").textContent = file ? file.name : "拖拽或点击选择音频/视频";
  $("#selectedName").textContent = file ? file.name : "-";
  $("#selectedSize").textContent = file ? formatBytes(file.size) : "-";
  $("#selectedType").textContent = file ? file.type || "-" : "-";
}

async function init() {
  setupEvents();
  await loadHealth();
  await loadRecords();
}

init().catch((error) => setMessage(error.message, true));
