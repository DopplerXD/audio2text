const state = {
  records: [],
  currentRecord: null,
  selectedFile: null,
  isTranscribing: false,
  isExporting: false,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function setMessage(text, isError = false) {
  const message = $("#message");
  message.textContent = text || "";
  message.classList.toggle("error", Boolean(isError));
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

async function loadHealth() {
  try {
    const health = await api("/api/health");
    $("#outputDir").textContent = health.output_dir || "outputs/";
    setStatus($("#backendStatus"), "completed", "可用");
  } catch (error) {
    setStatus($("#backendStatus"), "failed", "不可用");
    setMessage(error.message, true);
  }
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
    item.className = "history-item";
    item.innerHTML = `
      <strong class="history-title">${escapeHtml(record.original_filename)}</strong>
      <span class="history-meta">${statusText(record.status)} · ${record.created_at || "-"} · ${record.elapsed_seconds || "-"}s</span>
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
  setStatus($("#backendStatus"), record.status === "running" ? "running" : "completed", record.status === "running" ? "识别中" : "空闲");
  $("#textEditor").value = record.text || "";
  $("#textStats").textContent = `字数 ${(record.text || "").length} · 分段 ${(record.segments || []).length} · 语言 ${record.language || "-"}`;
  renderSegments();
  renderExports();
  renderInfo();
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
      <span>
        <button data-copy="${escapeHtml(file.absolute_path || file.path)}">复制路径</button>
        <a href="/api/files/${file.id}"><button>下载</button></a>
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
    ["模型", record.model_name],
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
      ${value && value !== "-" ? `<button data-copy="${escapeHtml(value)}">复制路径</button>` : ""}
    `;
    info.appendChild(row);
  });
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

  state.isTranscribing = true;
  $("#transcribeBtn").disabled = true;
  setStatus($("#backendStatus"), "running", "识别中");
  setMessage("正在识别，首次加载或下载 FunASR 模型可能需要较长时间。");
  try {
    state.currentRecord = await api("/api/transcriptions", {
      method: "POST",
      body: form,
    });
    await loadRecords();
    renderCurrentRecord();
    setMessage("识别完成。");
  } catch (error) {
    setStatus($("#backendStatus"), "failed", "失败");
    setMessage(error.message, true);
    await loadRecords().catch(() => {});
  } finally {
    state.isTranscribing = false;
    $("#transcribeBtn").disabled = false;
  }
}

function collectSegments() {
  const segments = (state.currentRecord?.segments || []).map((segment) => ({ ...segment }));
  $$(".segment-input").forEach((input) => {
    const index = Number(input.dataset.index);
    if (segments[index]) {
      segments[index].text = input.value;
    }
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

async function exportFormat(format) {
  if (!state.currentRecord) {
    setMessage("暂无可导出记录。", true);
    return;
  }
  state.isExporting = true;
  setMessage("正在导出...");
  try {
    const result = await api(`/api/transcriptions/${encodeURIComponent(state.currentRecord.id)}/exports`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format }),
    });
    state.currentRecord = result.record;
    renderCurrentRecord();
    setMessage("导出完成。");
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    state.isExporting = false;
  }
}

async function exportAll() {
  if (!state.currentRecord) {
    setMessage("暂无可导出记录。", true);
    return;
  }
  setMessage("正在生成全部格式和 ZIP...");
  try {
    const result = await api(`/api/transcriptions/${encodeURIComponent(state.currentRecord.id)}/exports/all`, {
      method: "POST",
    });
    state.currentRecord = result.record;
    renderCurrentRecord();
    setMessage("全部导出完成。");
  } catch (error) {
    setMessage(error.message, true);
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setupEvents() {
  $("#fileInput").addEventListener("change", (event) => {
    state.selectedFile = event.target.files[0] || null;
    renderSelectedFile();
  });

  const dropzone = $("#dropzone");
  dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropzone.classList.add("dragging");
  });
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
  $$("[data-export]").forEach((button) => {
    button.addEventListener("click", () => exportFormat(button.dataset.export));
  });

  $$(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      $$(".tab").forEach((tab) => tab.classList.remove("active"));
      $$(".tab-panel").forEach((panel) => panel.classList.remove("active"));
      button.classList.add("active");
      $(`#tab-${button.dataset.tab}`).classList.add("active");
    });
  });

  document.body.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-copy]");
    if (!button) return;
    await navigator.clipboard.writeText(button.dataset.copy);
    setMessage("路径已复制。");
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
