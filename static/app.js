const state = {
  records: [],
  currentRecord: null,
  selectedFile: null,
  aiConfig: null,
  workingText: "",
  workingSource: "",
  currentReview: null,
  resolvedIssueIds: new Set(),
  busy: new Set(),
};

const AI_BUTTON_LABELS = {
  organize: { idle: "开始智能整理", busy: "正在整理…" },
  review: { idle: "开始检查", busy: "正在检查…" },
  analysis: { idle: "生成面试分析", busy: "正在分析…" },
};

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
  state.currentRecord = await api(`/api/transcriptions/${encodeURIComponent(id)}`);
  renderCurrentRecord();
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
  if (!files.length) {
    list.innerHTML = '<p class="message">暂无导出文件</p>';
    return;
  }
  list.innerHTML = "";
  files.forEach((file) => {
    const item = document.createElement("div");
    item.className = "export-item";
    item.innerHTML = `
      <strong>${escapeHtml(file.format.toUpperCase())}</strong>
      <span class="path" title="${escapeHtml(file.absolute_path || file.path)}">${escapeHtml(file.path)}</span>
      <span>${formatBytes(file.size)}</span>
      <span class="file-actions">
        <button data-copy="${escapeHtml(file.absolute_path || file.path)}" class="compact">复制路径</button>
        <a class="button-link compact" href="/api/files/${file.id}">下载</a>
      </span>
    `;
    list.appendChild(item);
  });
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
  renderReviewResult(workingRun?.stage === "review" ? review : null);
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
    return;
  }
  workspace.classList.remove("hidden");
  const text = run.result_text || run.source_text || "";
  const issues = Array.isArray(run.result?.issues) ? run.result.issues : [];
  $("#reviewEditor").innerHTML = highlightedTextHtml(text, issues);
  renderIssueList();
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
}

function renderAnalysisResult(run) {
  const container = $("#analysisResult");
  if (!run || !run.result) {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }
  const result = run.result;
  const score = Math.max(0, Math.min(100, Number(result.overall_score) || 0));
  const dimensions = Array.isArray(result.dimensions) ? result.dimensions : [];
  const questions = Array.isArray(result.questions) ? result.questions : [];
  const actions = Array.isArray(result.action_items) ? result.action_items : [];
  const uncertainties = Array.isArray(result.uncertainties) ? result.uncertainties : [];
  container.classList.remove("hidden");
  container.innerHTML = `
    <section class="analysis-overview">
      <div class="score-ring" style="--score:${score}"><strong>${score}</strong><span>综合分</span></div>
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
      ${questions.length ? questions.map((item, index) => `
        <details class="question-card" ${index === 0 ? "open" : ""}>
          <summary><span>Q${escapeHtml(item.index || index + 1)}</span><strong>${escapeHtml(item.question || "未识别题目")}</strong><b>${Math.round(Number(item.score) || 0)} 分</b></summary>
          <div class="question-body">
            <div class="answer-summary"><span>回答摘要</span><p>${escapeHtml(item.answer_summary || "未识别到明确回答。")}</p></div>
            <div class="pros-cons">
              <div><h4>优点</h4>${renderStringList(item.strengths, "暂无明确优点")}</div>
              <div><h4>可改进</h4>${renderStringList(item.weaknesses, "暂无明确问题")}</div>
            </div>
            <div class="better-answer"><h4>更好的回答思路</h4><p>${escapeHtml(item.better_answer || "暂无建议。")}</p></div>
          </div>
        </details>
      `).join("") : '<p class="muted-text">未能从当前文本识别出成对问答。</p>'}
    </section>
    ${actions.length ? `<section class="action-list"><span class="eyebrow">提升建议</span><h3>下一步行动</h3>${renderStringList(actions)}</section>` : ""}
    ${uncertainties.length ? `<section class="uncertainty"><strong>分析限制</strong>${renderStringList(uncertainties)}</section>` : ""}
  `;
}

function renderStringList(items, fallback = "暂无") {
  const normalized = Array.isArray(items) ? items.filter(Boolean) : [];
  return `<ul>${(normalized.length ? normalized : [fallback]).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function updateAIAvailability() {
  const hasRecord = Boolean(state.currentRecord?.text);
  $$(".ai-action").forEach((button) => {
    const stage = button.id === "organizeBtn" ? "organize" : button.id === "reviewBtn" ? "review" : "analysis";
    const isBusy = state.busy.has(stage);
    button.disabled = !hasRecord || isBusy;
    button.title = !hasRecord
      ? "请先选择一条有文本内容的识别记录"
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
    renderCurrentRecord();
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
  const sourceText = currentWorkingText();
  setAIBusy("review", true, "#reviewStatus", "正在确认 DeepSeek 配置…");
  try {
    if (!(await ensureAIReady("#reviewStatus"))) return;
    setInlineStatus("#reviewStatus", "正在检查上下文与非常用词…", "loading");
    const response = await api(`/api/transcriptions/${encodeURIComponent(state.currentRecord.id)}/ai/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: sourceText }),
    });
    state.currentRecord.ai_runs = [response.run, ...(state.currentRecord.ai_runs || [])];
    state.workingText = sourceText;
    state.workingSource = `检查版本 #${response.run.id}`;
    $("#workingSource").textContent = `当前输入 · ${state.workingSource}`;
    renderReviewResult(response.run);
    setInlineStatus("#reviewStatus", `检查完成 · ${response.issue_count} 处待确认`, "success");
  } catch (error) {
    setInlineStatus("#reviewStatus", error.message, "error");
  } finally {
    setAIBusy("review", false);
  }
}

async function saveReview() {
  if (!state.currentRecord || !state.currentReview) return;
  const text = readReviewEditorText();
  $("#saveReviewBtn").disabled = true;
  setInlineStatus("#reviewStatus", "正在保存检查修改…", "loading");
  try {
    const response = await api(
      `/api/transcriptions/${encodeURIComponent(state.currentRecord.id)}/ai/reviews/${state.currentReview.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, resolved_issue_ids: Array.from(state.resolvedIssueIds) }),
      },
    );
    state.currentRecord.ai_runs = [
      response.run,
      ...(state.currentRecord.ai_runs || []).filter((run) => run.id !== response.run.id),
    ];
    state.workingText = response.run.result_text;
    state.workingSource = `检查版本 #${response.run.id}`;
    $("#workingSource").textContent = `当前输入 · ${state.workingSource}`;
    renderReviewResult(response.run);
    setInlineStatus("#reviewStatus", "检查修改已保存。", "success");
  } catch (error) {
    setInlineStatus("#reviewStatus", error.message, "error");
  } finally {
    $("#saveReviewBtn").disabled = false;
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

async function exportFormat(format) {
  if (!state.currentRecord) return setMessage("暂无可导出记录。", true);
  setMessage("正在导出…");
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
  }
}

async function exportAll() {
  if (!state.currentRecord) return setMessage("暂无可导出记录。", true);
  setMessage("正在生成全部格式和 ZIP…");
  try {
    const result = await api(`/api/transcriptions/${encodeURIComponent(state.currentRecord.id)}/exports/all`, { method: "POST" });
    state.currentRecord = result.record;
    renderCurrentRecord();
    activateMainTab("exports");
    setMessage("全部导出完成。");
  } catch (error) {
    setMessage(error.message, true);
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
  $("#exportAllBtn").addEventListener("click", exportAll);
  $$("[data-export]").forEach((button) => button.addEventListener("click", () => exportFormat(button.dataset.export)));
  $$(".tab").forEach((button) => button.addEventListener("click", () => activateMainTab(button.dataset.tab)));
  $$(".workflow-step").forEach((button) => button.addEventListener("click", () => activateAIStage(button.dataset.aiStage)));

  $("#organizeBtn").addEventListener("click", organizeContent);
  $("#reviewBtn").addEventListener("click", startReview);
  $("#saveReviewBtn").addEventListener("click", saveReview);
  $("#analyzeBtn").addEventListener("click", analyzeContent);
  $("#copyOrganizedBtn").addEventListener("click", () => copyText($("#organizedPreview").value));
  $("#reviewEditor").addEventListener("input", handleReviewEdit);
  window.addEventListener("focus", () => loadHealth({ silent: true }));

  document.body.addEventListener("click", async (event) => {
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
