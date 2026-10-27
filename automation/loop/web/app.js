const $ = id => document.getElementById(id);
const tokenInput = $("token");
const TOKEN_STORAGE_KEY = "soxu.dashboard.sessionToken.v1";
const LOG_LIMIT_KEY = "soxu.dashboard.logLimit.v1";
const LOG_FILTER_KEY = "soxu.dashboard.logFilter.v1";
const PHASE_KEY = "soxu.dashboard.projectPhase.v1";
const THEME_KEY = "soxu.dashboard.theme.v1";
const FOLLOW_KEY = "soxu.dashboard.followLogs.v1";
const LOG_LIMITS = new Set([20, 50, 100, 200]);
const preferenceStorage = typeof localStorage === "undefined" ? { getItem: () => null, setItem: () => {} } : localStorage;
const stateLabels = { running: "进行中", paused: "已暂停", blocked: "已阻塞", pending: "等待", done: "本地已结束" };
const phaseLabels = {
  worktree:"准备工作树", install:"安装依赖", develop:"开发", checks:"执行检查", review:"代码审查",
  postConflictInstall:"冲突后安装", recoveryInstall:"恢复时安装依赖", finalChecks:"最终检查", commit:"提交", push:"推送",
  createPr:"创建 PR", merge:"等待合并", done:"完成"
};
const activityLabels = { waiting:"等待模型", generating:"生成中", tool:"执行工具", completed:"已完成", failed:"失败" };
let connected = false, requestInFlight = false;
let instanceId = null, latestSequence = 0, logs = [], lastTaskKey = "", renderedLogKey = "";
let agents = new Map(), streamController = null, streamToken = null, reconnectTimer = null, retries = 0;
let logLimit = 50, logFilter = "all", followLogs = true, currentIntake = null, lastIntakeKey = "", lastQueueKey = "";

function stored(storage, key) { try { return storage.getItem(key); } catch { return null; } }
function save(storage, key, value) { try { storage.setItem(key, String(value)); } catch {} }
function restoreToken() {
  const token = stored(sessionStorage, TOKEN_STORAGE_KEY);
  if (token && /^[0-9a-f]{48}$/i.test(token)) return token;
  if (token) forgetToken(token);
  return "";
}
function forgetToken(token) {
  try {
    if (sessionStorage.getItem(TOKEN_STORAGE_KEY) === token) sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {}
}
function notice(message) { $("notice").textContent = message; }
function element(tag, value, className) {
  const result = document.createElement(tag);
  if (value !== undefined) result.textContent = String(value);
  if (className) result.className = className;
  return result;
}
function disableControls() {
  for (const button of document.querySelectorAll("[data-command], [data-resume-issue]")) button.disabled = true;
  $("stop").disabled = true;
  $("autoMerge").disabled = true;
}
function lostAuthorization(token) {
  if (token !== tokenInput.value.trim()) return;
  forgetToken(token);
  tokenInput.value = "";
  connected = false;
  $("dot").classList.remove("ok");
  $("connection").textContent = "未连接";
  disableControls();
  stopStream();
  notice("访问令牌已失效或错误，请粘贴本次启动的新令牌。");
}
async function api(path, options = {}, token = tokenInput.value.trim()) {
  if (!/^[0-9a-f]{48}$/i.test(token)) throw new Error("请填写终端生成的 48 位令牌。");
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: { "X-SOXU-Control-Token": token, ...(options.method ? { "Content-Type": "application/json" } : {}) },
    ...(options.method ? { body: JSON.stringify(options.body ?? {}) } : {}),
    cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(path === "/api/intake-submit" ? 55000 : 9000)
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || "HTTP " + response.status);
    error.status = response.status;
    throw error;
  }
  return data;
}

function resetInstance(next) {
  if (instanceId === next) return;
  instanceId = next;
  latestSequence = 0;
  logs = [];
  agents.clear();
  lastTaskKey = "";
  renderedLogKey = "";
  lastIntakeKey = ""; lastQueueKey = "";
}
function mergeLog(line) {
  if (!line || !Number.isSafeInteger(line.seq) || !["system", "stdout", "stderr"].includes(line.stream)
      || typeof line.message !== "string" || typeof line.time !== "string") return;
  if (line.seq <= latestSequence) return;
  if (latestSequence && line.seq > latestSequence + 1) void refresh();
  latestSequence = line.seq;
  logs.push(line);
  if (logs.length > 500) logs.splice(0, logs.length - 500);
  renderLogs();
}
function rebuildLogs(items) {
  const incoming = Array.isArray(items) ? items : [];
  const last = incoming.at(-1)?.seq ?? 0;
  if (last < latestSequence) return;
  if (last === latestSequence && logs.length && incoming.length === logs.length) return;
  logs = incoming.filter(item => item && Number.isSafeInteger(item.seq)
    && ["system","stdout","stderr"].includes(item.stream)).slice(-500);
  latestSequence = last;
  renderLogs(true);
}
function visibleLogs() {
  return logs.filter(item => logFilter === "all" || item.stream === logFilter).slice(-logLimit);
}
function logElement(entry) {
  const line = element("div", undefined, "log");
  line.dataset.stream = entry.stream;
  line.dataset.seq = String(entry.seq);
  line.append(element("span", new Date(entry.time).toLocaleTimeString(), "time"), document.createTextNode(entry.message));
  return line;
}
function renderLogs(force = false) {
  const container = $("logs");
  const rows = visibleLogs();
  const key = logFilter + ":" + logLimit + ":" + (rows[0]?.seq ?? 0) + ":" + (rows.at(-1)?.seq ?? 0) + ":" + rows.length;
  if (!force && key === renderedLogKey) return;
  const wasAtBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 35;
  if (rows.length === 0) {
    container.replaceChildren(element("div", "暂无符合条件的日志", "empty"));
  } else {
    const previous = container.lastElementChild;
    const lastSeq = Number(previous?.dataset?.seq);
    const appendOne = !force && previous && previous.classList.contains("log")
      && rows.length > 1 && rows.at(-2).seq === lastSeq;
    if (appendOne) {
      container.append(logElement(rows.at(-1)));
      while (container.children.length > rows.length) container.firstElementChild.remove();
    } else {
      container.replaceChildren(...rows.map(logElement));
    }
  }
  renderedLogKey = key;
  $("logCount").textContent = rows.length + " / " + logs.length + " 条";
  if (followLogs && wasAtBottom) container.scrollTop = container.scrollHeight;
}
function renderTasks(data) {
  const tasks = data.tasks || [];
  const key = JSON.stringify([tasks, data.busy, data.github]);
  if (lastTaskKey === key) return;
  lastTaskKey = key;
  const node = $("tasks");
  node.replaceChildren();
  for (const task of [...tasks].sort((a, b) => a.id - b.id)) {
    const card = element("article", undefined, "task");
    card.append(element("div", "#" + task.id, "task-id"), element("div", task.title, "task-name"));
    const status = element("div", stateLabels[task.status] || task.status, "task-state");
    status.dataset.state = task.status;
    card.append(status, element("div", phaseLabels[task.phase] || task.phase || "尚未开始", "task-stage"),
      element("div", task.updatedAt ? new Date(task.updatedAt).toLocaleTimeString() : "—", "task-time"));
    if (task.status === "blocked") {
      const button = element("button", "恢复此任务", "task-resume");
      button.dataset.resumeIssue = String(task.id);
      button.disabled = Boolean(data.busy);
      button.addEventListener("click", () => void resumeBlocked(task.id));
      card.append(button);
    }
    const taskId = "TASK-" + String(task.id).padStart(3,"0");
    const remote = data.github?.status === "ok" ? data.github.tasks?.[taskId] : null;
    const details = [];
    if (remote?.pr) {
      const prState = {open:"待合并",merged:"已合并",closed:"已关闭"}[remote.pr.state] ?? "未知";
      const ciState = {pending:"运行中",success:"通过",failure:"失败",unknown:"未知"}[remote.pr.ci] ?? "未知";
      const box = element("div", undefined, "task-detail");
      if (typeof remote.pr.url === "string" && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(remote.pr.url)) {
        const link = element("a", remote.pr.title || `PR #${remote.pr.number}`, "pr-link");
        link.href = remote.pr.url; link.target = "_blank"; link.rel = "noopener noreferrer";
        box.append(link, document.createTextNode(` · ${prState} · CI ${ciState}`));
      } else box.append(document.createTextNode(`PR #${remote.pr.number} ${prState} · CI ${ciState}`));
      if (remote.pr.state === "open") {
        const button = element("button", "合并并删除远程分支", "task-merge");
        button.disabled = Boolean(data.busy) || remote.pr.ci !== "success";
        button.addEventListener("click", () => void mergePr(remote.issue, remote.pr));
        box.append(button);
      }
      card.append(box);
    } else if (task.status === "done") details.push("本地执行结束；PR 状态待核实");
    if (task.status === "pending" && remote?.missing?.length) details.push("等待依赖合并：" + remote.missing.join("、"));
    if (details.length) card.append(element("div", details.join(" · "), "task-detail"));
    node.append(card);
  }
  if (!tasks.length) node.append(element("div", "暂无任务", "empty"));
}
function renderAgents() {
  const node = $("agentCards");
  node.replaceChildren();
  const entries = [...agents.values()].sort((a,b) => a.taskId - b.taskId || a.role.localeCompare(b.role));
  for (const activity of entries) {
    const item = element("article", undefined, "agent-card");
    const role = activity.role === "developer" ? "Developer" : "Reviewer";
    const state = activityLabels[activity.state] || "未知";
    item.append(element("strong", "#" + activity.taskId + " · " + role),
      element("span", state + (activity.tool ? " · " + activity.tool : ""), "agent-state"));
    const elapsed = element("span", "", "agent-elapsed");
    elapsed.dataset.startedAt = activity.startedAt;
    elapsed.dataset.activitySince = activity.activitySince;
    item.append(elapsed);
    node.append(item);
  }
  if (!entries.length) node.append(element("div", "暂无 Dashboard 启动的 Pi 会话活动", "empty"));
  updateElapsed();
}
function updateElapsed() {
  const fmt = timestamp => {
    const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(timestamp)) / 1000));
    if (!Number.isFinite(seconds)) return "—";
    return Math.floor(seconds / 3600).toString().padStart(2,"0") + ":" +
      Math.floor(seconds % 3600 / 60).toString().padStart(2,"0") + ":" +
      (seconds % 60).toString().padStart(2,"0");
  };
  for (const label of document.querySelectorAll(".agent-elapsed"))
    label.textContent = "运行 " + fmt(label.dataset.startedAt) + " · 当前状态 " + fmt(label.dataset.activitySince);
}
function renderProjectPhase(github) {
  if (github?.status !== "ok") {
    $("projectPhaseDetail").textContent="GitHub 状态不可用；六项任务进度待核实。当前阶段由维护者在本机设置。";
    $("projectPhaseCount").textContent="—";
    $("projectProgressFill").style.width="0%";
    $("projectProgress").setAttribute("aria-valuenow","0");
    $("projectProgress").setAttribute("aria-valuetext","状态未知");
    return;
  }
  const tasks=github.tasks || {};
  const ids=["TASK-001","TASK-002","TASK-003","TASK-004","TASK-005","TASK-006"];
  if (ids.some(id=>!tasks[id] || !tasks[id].issue)) {
    $("projectPhaseDetail").textContent="当前六项任务的 Issue 不完整，合并进度待核实。当前阶段由维护者在本机设置。";
    $("projectPhaseCount").textContent="—";
    $("projectProgressFill").style.width="0%";
    $("projectProgress").setAttribute("aria-valuetext","状态未知");
    return;
  }
  const merged=id=>tasks[id].issueState === "CLOSED" && tasks[id].pr?.state === "merged";
  const count=ids.filter(merged).length;
  $("projectPhaseDetail").textContent="当前阶段由维护者在本机设置；六项任务按 Issue 关闭且 PR 合并计算，不代表阶段验收。";
  $("projectPhaseCount").textContent=`${count} / 6 已合并`;
  $("projectProgressFill").style.width=`${count / 6 * 100}%`;
  $("projectProgress").setAttribute("aria-valuenow",String(count));
  $("projectProgress").setAttribute("aria-valuetext",`${count} 项已合并，共 6 项`);
}
function render(data) {
  if (typeof data.instanceId === "string") resetInstance(data.instanceId);
  connected = true;
  $("dot").classList.add("ok");
  $("connection").textContent = "本机已连接";
  const tasks = data.tasks || [];
  for (const group of ["running", "pending", "done"]) $(group).textContent = tasks.filter(t => t.status === group).length;
  $("total").textContent = tasks.length;
  $("badge").dataset.state = data.runner ? (data.runner.stopping ? "stopping" : "running") : data.externalLocks ? "external" : "idle";
  $("badge").textContent = data.runner ? (data.runner.stopping ? "停止中" : "运行中") : data.externalLocks ? "外部任务执行中" : "空闲";
  $("runner").textContent = data.runner ? "正在执行 " + data.runner.command + " · 开始于 " + new Date(data.runner.startedAt).toLocaleTimeString()
    : data.externalLocks ? "检测到 " + data.externalLocks + " 个正在运行的工作树锁（此处不能停止）"
    : data.lastRun ? "上次执行 " + data.lastRun.command + " · 退出码 " + (data.lastRun.exitCode ?? "未知") : "未启动调度";
  $("updated").textContent = "更新于 " + new Date(data.generatedAt).toLocaleTimeString();
  for (const button of document.querySelectorAll("[data-command]")) button.disabled = data.busy;
  $("stop").disabled = !data.runner || data.runner.stopping;
  $("autoMerge").disabled = Boolean(data.busy);
  $("autoMerge").dataset.enabled = data.autoMergeEnabled ? "true" : "false";
  $("autoMerge").textContent = "Agent 自动合并：" + (data.autoMergeEnabled ? "开启" : "关闭");
  $("githubStatus").textContent = data.github?.status === "ok" ? "GitHub PR / CI 状态已更新 · " + new Date(data.github.updatedAt).toLocaleTimeString()
    : data.github?.status === "unavailable" ? "GitHub 状态不可用：请检查 gh 登录和网络；任务与 CI 状态未知" : "GitHub 状态加载中";
  $("developmentLane").textContent = data.runner ? "控制台调度运行中" : data.externalLocks ? "存在外部任务锁" : "控制台当前空闲";
  const reportLabel = lane => !lane ? "状态加载中" : lane.status === "unavailable" ? "本地报告状态不可用" : lane.status === "empty" ? "暂无本地建议报告" : `本地报告 ${lane.count} 份 · 最近 ${new Date(lane.lastAt).toLocaleString()}`;
  $("productLane").textContent=reportLabel(data.lanes?.product);
  $("qualityLane").textContent=reportLabel(data.lanes?.quality);
  const lessons=data.lanes?.lessons;
  $("lessonsStatus").textContent=lessons?.status === "available" ? `已记录 ${lessons.count} 条教训，${lessons.eligible} 条达到提出申请的条件。每条须有至少 3 个不同日期的证据；维护者核实、批准并通过单独治理 PR，不自动修改规则。` : "复盘规则：同一规则须有至少 3 个不同日期的证据，才可提出人工晋升申请；教训记录状态待核实。";
  renderProjectPhase(data.github);
  const queueItems = data.github?.status === "ok" ? data.github.tasks?.__queue || [] : [];
  const queueKey=JSON.stringify([data.github?.status,queueItems]);
  const queue=$("queueList");
  if (queueKey !== lastQueueKey) {
    lastQueueKey=queueKey; queue.replaceChildren();
    for (const item of queueItems) {
    const row=element("div",undefined,"queue-item");
    const title=element(item.url ? "a" : "span",`#${item.number} ${item.title}`,"pr-link");
    if (item.url && /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/.test(item.url)) {title.href=item.url;title.target="_blank";title.rel="noopener noreferrer";}
    const labels=item.labels || [];
    const state=labels.includes("agent:blocked") ? "等待人工处理" : labels.includes("agent:paused") ? "已暂停" : labels.includes("agent:pr") ? "PR 待处理" : labels.includes("agent:in-progress") ? "执行中" : labels.includes("agent:waiting") ? "等待依赖" : "可执行";
    row.append(title,element("span",state,"queue-state"));queue.append(row);
    }
  }
  renderIntake(data.intake);
  renderTasks(data);
  if (Array.isArray(data.agents)) {
    agents = new Map(data.agents.map(a => [a.taskId + ":" + a.role, a]));
    renderAgents();
  }
  rebuildLogs(data.log);
}
async function refresh() {
  const token = tokenInput.value.trim();
  if (requestInFlight || document.hidden || !token) return;
  requestInFlight = true;
  try {
    const data = await api("/api/status", {}, token);
    if (token !== tokenInput.value.trim()) return;
    const wasConnected = connected;
    render(data);
    save(sessionStorage, TOKEN_STORAGE_KEY, token);
    if (!wasConnected) notice("连接成功；页面将实时更新，刷新后自动恢复。");
    if (!streamController) void openStream(token);
  } catch (error) {
    if (token !== tokenInput.value.trim()) return;
    if (error.status === 401) {
      lostAuthorization(token);
    } else {
      connected = false;
      $("dot").classList.remove("ok");
      $("connection").textContent = "连接中断";
      disableControls();
      notice("连接失败：" + error.message);
    }
  } finally { requestInFlight = false; }
}

function stopStream() {
  if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (streamController) streamController.abort();
  streamController = null;
  streamToken = null;
  retries = 0;
}
function onStreamEvent(type, data) {
  if (type === "hello") {
    if (data.instanceId && instanceId && data.instanceId !== instanceId) void refresh();
  } else if (type === "log") {
    mergeLog(data);
  } else if (type === "agent") {
    if (!data || !Number.isSafeInteger(data.taskId) || !["developer","reviewer"].includes(data.role)) return;
    agents.set(data.taskId + ":" + data.role, data);
    if (agents.size > 32) agents.delete(agents.keys().next().value);
    renderAgents();
  } else if (type === "status") {
    void refresh();
  }
}
function consumeSseFrame(frame) {
  let kind = "message", payload = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) kind = line.slice(6).trim();
    else if (line.startsWith("data:")) payload += line.slice(5).trimStart();
  }
  if (!payload || !["hello","log","agent","status"].includes(kind)) return;
  try { onStreamEvent(kind, JSON.parse(payload)); } catch {}
}
async function openStream(token) {
  if (streamController || typeof AbortController === "undefined") return;
  const controller = new AbortController();
  streamController = controller;
  streamToken = token;
  try {
    const response = await fetch("/api/events", {
      headers: { "X-SOXU-Control-Token": token },
      cache: "no-store", credentials: "omit", signal: controller.signal
    });
    if (!response.ok) {
      const error = new Error("SSE HTTP " + response.status);
      error.status = response.status;
      throw error;
    }
    if (!response.body?.getReader) return; // Keep periodic HTTP calibration in limited environments.
    retries = 0;
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    while (!controller.signal.aborted) {
      const result = await reader.read();
      if (result.done) break;
      buffer = (buffer + decoder.decode(result.value, { stream: true })).replace(/\r\n/g, "\n");
      let offset;
      while ((offset = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, offset);
        buffer = buffer.slice(offset + 2);
        consumeSseFrame(frame);
      }
      if (buffer.length > 65536) throw new Error("事件帧超限");
    }
  } catch (error) {
    if (!controller.signal.aborted && token === tokenInput.value.trim() && error.status === 401) {
      lostAuthorization(token);
      return;
    }
  } finally {
    if (streamController !== controller) return;
    streamController = null;
    streamToken = null;
    if (!controller.signal.aborted && token === tokenInput.value.trim() && connected) {
      retries = Math.min(retries + 1, 5);
      const wait = Math.min(15000, 750 * 2 ** retries) + Math.floor(Math.random() * 300);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (connected && !document.hidden) void openStream(token);
      }, wait);
    }
  }
}
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $("themeToggle").textContent = theme === "dark" ? "浅色" : "深色";
  save(preferenceStorage, THEME_KEY, theme);
}
function renderIntake(intake) {
  currentIntake = intake ?? null;
  const key=JSON.stringify(intake ?? null);
  if (key === lastIntakeKey) return;
  lastIntakeKey=key;
  const node = $("intakeResult"); node.replaceChildren();
  const state = intake?.status;
  $("assessIntake").disabled = ["assessing", "submitting", "unknown"].includes(state);
  $("requirement").readOnly = ["assessing", "review", "submitting", "unknown"].includes(state);
  if (intake?.requirement && ["assessing", "review", "submitting"].includes(state)) $("requirement").value = intake.requirement;
  $("submitIntake").disabled = state !== "review";
  $("clearIntake").hidden = state !== "unknown";
  if (!intake) { $("intakeSummary").textContent = "尚未提交本次需求"; return; }
  $("intakeSummary").textContent = ({assessing:"Agent 正在评估",review:"评估完成，等待确认",submitting:"正在提交需求",submitted:"需求已提交",failed:"评估失败",unknown:"提交结果待核实"})[state] || "状态未知";
  if (intake.assessment) for (const [key,label] of [["title","建议标题"],["feasibility","可行性"],["plan","实施安排"],["dependencies","前置依赖"],["acceptance","验收标准"],["unknowns","未知与待确认"]]) {
    const block=element("div",undefined,"assessment-block"); block.append(element("strong",label),element("p",intake.assessment[key]));node.append(block);
  }
  if (intake.error) node.append(element("p",intake.error,"error-text"));
  if (intake.url && /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/.test(intake.url)) {
    const link=element("a","在 GitHub 查看需求","pr-link");link.href=intake.url;link.target="_blank";link.rel="noopener noreferrer";node.append(link);
  }
}
async function mergePr(issue, pr) {
  if (!connected || !Number.isSafeInteger(issue) || !Number.isSafeInteger(pr.number)) return;
  if (!confirm(`合并 PR #${pr.number}「${pr.title}」并删除远程分支？将重新检查 PR、CI 和分支头。`)) return;
  try {
    const result = await api("/api/merge", {method:"POST", body:{issue,pr:pr.number}});
    notice(result.branchDeleted ? `PR #${pr.number} 已合并，远程分支已删除。` : `PR #${pr.number} 已合并，但远程分支删除失败：${result.branch || "请检查"}`);
    await refresh();
  } catch (error) { notice("合并失败：" + error.message); }
}
async function resumeBlocked(issue) {
  if (!connected) return notice("先连接本地控制台。");
  if (!confirm(`恢复任务 #${issue} 前请确认已检查并修复阻塞原因。将重新执行相关门禁，可能调用模型并产生费用。继续？`)) return;
  try {
    await api("/api/run", { method:"POST", body:{ command:"resume-blocked", issue } });
    notice(`已开始恢复任务 #${issue}；可在此查看日志和 Agent 活动。`);
    await refresh();
  } catch (error) { notice("恢复失败：" + error.message); }
}
async function execute(command) {
  if (!connected) return notice("先连接本地控制台。");
  if (command === "watch" && !confirm("持续监控可重复执行 Agent 任务并产生模型费用。确认启用受策略限制的 watch？")) return;
  if (command === "resume" && !confirm("即将恢复全部中断任务，可能产生模型调用。确认？")) return;
  try {
    const result = await api("/api/run", { method:"POST", body:{ command } });
    notice("已接受：" + result.command + "。停止仅作用于此控制台启动的任务。");
    await refresh();
  } catch (error) { notice("操作失败：" + error.message); }
}

function setProjectPhase(value) {
  const names={unknown:"项目当前阶段待确认",M0:"M0 · 工程治理",M1:"M1 · 产品原型",M2:"M2 · 多 Agent",M3:"M3 · 开发工具",M4:"M4 · 发布"};
  const selected=Object.hasOwn(names,value) ? value : "unknown";
  $("phaseSelect").value=selected;
  $("projectPhaseTitle").textContent=names[selected];
  save(preferenceStorage,PHASE_KEY,selected);
}
$("phaseSelect").addEventListener("change",()=>setProjectPhase($("phaseSelect").value));
$("themeToggle").addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
$("openIntake").addEventListener("click", () => { if (!connected) return notice("先连接本地控制台。"); $("intakeDialog").showModal(); });
$("closeIntake").addEventListener("click", () => $("intakeDialog").close());
$("assessIntake").addEventListener("click", async () => {
  if (!confirm("评估会调用一次模型并可能产生费用，继续？")) return;
  $("queueReady").checked=false;
  try { const result=await api("/api/intake-assess",{method:"POST",body:{requirement:$("requirement").value}});renderIntake(result); }
  catch(error){$("intakeResult").textContent="评估启动失败："+error.message;}
});
$("clearIntake").addEventListener("click", async () => {
  if (!currentIntake || !confirm("请先检查 GitHub 是否已有此需求。确认已核实提交结果，解除锁定？")) return;
  try {await api("/api/intake-clear",{method:"POST",body:{id:currentIntake.id}});renderIntake(null);}
  catch(error){notice("解除锁定失败："+error.message);}
});
$("submitIntake").addEventListener("click", async () => {
  if (!currentIntake || currentIntake.status !== "review") return;
  const ready=Boolean($("queueReady").checked);
  if (!confirm(ready ? "确认提交并加入可执行队列？请确保前置依赖已完成。" : "确认创建 GitHub 需求并标记为阻塞，等待人工核对依赖？")) return;
  $("submitIntake").disabled=true;
  try {const result=await api("/api/intake-submit",{method:"POST",body:{id:currentIntake.id,ready}});renderIntake(result);}
  catch(error){$("intakeResult").textContent=error.message === "potential-secret" ? "检测到疑似密钥，未提交。请删除敏感内容后重新评估。" : "提交结果可能不确定，请先检查 GitHub，避免重复提交。";}
});
(function initializePreferences() {
  setProjectPhase(stored(preferenceStorage,PHASE_KEY) || "unknown");
  const theme = stored(preferenceStorage,THEME_KEY);
  setTheme(theme === "light" || theme === "dark" ? theme : "dark");
  const preferred = Number(stored(preferenceStorage, LOG_LIMIT_KEY));
  logLimit = LOG_LIMITS.has(preferred) ? preferred : 50;
  logFilter = ["all","system","stdout","stderr"].includes(stored(preferenceStorage,LOG_FILTER_KEY))
    ? stored(preferenceStorage,LOG_FILTER_KEY) : "all";
  followLogs = stored(preferenceStorage,FOLLOW_KEY) !== "false";
  $("logLimit").value = String(logLimit);
  $("logFilter").value = logFilter;
  $("followLogs").checked = followLogs;
})();
$("logLimit").addEventListener("change", () => {
  const selected = Number($("logLimit").value);
  if (!LOG_LIMITS.has(selected)) return;
  logLimit = selected;
  save(preferenceStorage, LOG_LIMIT_KEY, logLimit);
  renderLogs(true);
});
$("logFilter").addEventListener("change", () => {
  logFilter = $("logFilter").value;
  save(preferenceStorage, LOG_FILTER_KEY, logFilter);
  renderLogs(true);
});
$("followLogs").addEventListener("change", () => {
  followLogs = Boolean($("followLogs").checked);
  save(preferenceStorage, FOLLOW_KEY, followLogs);
  if (followLogs) $("logs").scrollTop = $("logs").scrollHeight;
});
$("connect").addEventListener("click", () => void refresh());
tokenInput.addEventListener("keydown", event => { if (event.key === "Enter") void refresh(); });
tokenInput.addEventListener("input", () => {
  stopStream();
  connected = false;
  $("dot").classList.remove("ok");
  $("connection").textContent = "尚未连接";
  disableControls();
});
for (const button of document.querySelectorAll("[data-command]"))
  button.addEventListener("click", () => void execute(button.dataset.command));
$("autoMerge").addEventListener("click", async () => {
  const enabled = $("autoMerge").dataset.enabled !== "true";
  if (enabled && !confirm("开启后，本次控制台后续启动的 Agent 会在仓库分支保护允许时请求自动合并。关闭或重启控制台不会撤销已经提交给 GitHub 的自动合并请求。继续？")) return;
  try { await api("/api/auto-merge", {method:"POST", body:{enabled}}); await refresh(); }
  catch (error) { notice("设置失败：" + error.message); }
});
$("stop").addEventListener("click", async () => {
  if (!confirm("请求优雅停止当前调度；工作树和检查点将保留。确定吗？")) return;
  try {
    await api("/api/stop", { method:"POST", body:{} });
    notice("已发送停止信号，等待当前 Runner 退出。");
    await refresh();
  } catch (error) { notice("停止失败：" + error.message); }
});
$("refresh").addEventListener("click", () => void refresh());
setInterval(() => void refresh(), 15000);
setInterval(() => { if (!document.hidden) updateElapsed(); }, 1000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    void refresh();
    if (connected && !streamController && !reconnectTimer) void openStream(tokenInput.value.trim());
  }
});
const savedToken = restoreToken();
if (savedToken) {
  tokenInput.value = savedToken;
  void refresh();
}
