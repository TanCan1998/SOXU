const $ = id => document.getElementById(id);
const tokenInput = $("token");
const TOKEN_STORAGE_KEY = "soxu.dashboard.sessionToken.v1";
const LOG_LIMIT_KEY = "soxu.dashboard.logLimit.v1";
const LOG_FILTER_KEY = "soxu.dashboard.logFilter.v1";
const PAGE_KEY = "soxu.dashboard.page.v1";
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
let agents = new Map(), lastAgentKey = "", streamController = null, streamToken = null, reconnectTimer = null, retries = 0;
let logLimit = 50, logFilter = "all", followLogs = true, currentIntake = null, lastIntakeKey = "", lastQueueKey = "";
let lastRoadmapKey = "";
let advisoryState = null, loadedReportKeys = {product:"",quality:""};
let modelSettings = null, modelDraft = null, modelCatalog = [], actualModels = new Map();

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
function notice(message) { $("notice").textContent = message; $("authNotice").textContent = message; }
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
  $("authPanel").hidden = false; $("connect").textContent = "连接";
  $("dot").classList.remove("ok");
  $("connection").textContent = "未连接";
  $("globalRun").dataset.status="unknown"; $("globalRun").textContent="未连接";
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
    cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(path === "/api/intake-submit" ? 55000 : path === "/api/model-catalog" ? 35000 : 9000)
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
  actualModels.clear();
  lastAgentKey = "";
  lastTaskKey = "";
  renderedLogKey = "";
  lastIntakeKey = ""; lastQueueKey = ""; lastRoadmapKey = "";
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
    const live=Boolean(data.runner) && (data.taskPhases ?? []).some(p=>p.taskId === (data.github?.tasks?.["TASK-"+String(task.id).padStart(3,"0")]?.issue ?? task.id) && p.status === "running");
    const merged=data.github?.tasks?.["TASK-"+String(task.id).padStart(3,"0")]?.pr?.state === "merged";
    card.dataset.status=live ? "running" : ["paused","blocked"].includes(task.status) ? "paused" : merged ? "completed" : "waiting";
    if (live) {const effect=element("div",undefined,"task-motion");effect.setAttribute("aria-hidden","true");card.append(effect);}
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
  const entries = [...agents.values()].sort((a,b) => a.taskId - b.taskId || a.role.localeCompare(b.role));
  const key = JSON.stringify([entries,[...actualModels.values()]]);
  if (key === lastAgentKey) return;
  lastAgentKey = key;
  const node = $("agentCards");
  node.replaceChildren();
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
    const selected=actualModels.get(activity.taskId+":"+activity.role);
    if (selected) item.append(element("span", "模型："+(selected.provider && selected.model ? selected.provider+" / "+selected.model : "Pi 默认（具体模型未知）"),"agent-model"));
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
function showMilestoneDetail(id, name, stage, limited) {
  $("milestoneTitle").textContent = id + " · " + name;
  const list=$("milestoneDetails"); list.replaceChildren();
  if (limited) list.append(element("p","GitHub 查询达到上限，以下明细可能不完整。","hint"));
  if (!stage || !Array.isArray(stage.items)) list.append(element("p","明细暂不可用，请检查 GitHub 连接。","hint"));
  else if (!stage.items.length) list.append(element("p","该里程碑暂无已归类任务。","hint"));
  else for (const item of stage.items) {
    const row=element("div",undefined,"milestone-detail-row");
    const label=element(item.url ? "a" : "span", "#"+item.number+" "+item.title);
    if(item.url) { label.href=item.url; label.target="_blank"; label.rel="noopener noreferrer"; }
    const status=item.merged ? "已合入" : item.state === "CLOSED" ? "已关闭 · 合并待核实" : item.labels.includes("agent:blocked") ? "已阻塞" : item.labels.includes("agent:paused") ? "已暂停" : item.labels.includes("agent:in-progress") ? "进行中" : "待处理";
    row.append(label,element("span",status,"subtle")); list.append(row);
  }
  $("milestoneDialog").showModal();
}
function renderProjectPhase(github, data) {
  const names={M0:"工程治理",M1:"产品原型",M2:"多 Agent",M3:"开发工具",M4:"交付发布"};
  const roadmap=github?.status === "ok" ? github.tasks?.__roadmap : null;
  const key=JSON.stringify([roadmap,Boolean(data.runner),data.taskPhases]);
  if(key===lastRoadmapKey)return;
  lastRoadmapKey=key;
  const phases=new Set(data.runner ? (data.taskPhases ?? []).filter(p=>p.status === "running").map(p=>p.taskId) : []);
  const node=$("roadmapCards");node.replaceChildren();
  let running=0, paused=0, total=0, merged=0;
  for (const id of Object.keys(names)) {
    const stage=roadmap?.stages?.find(x=>x.id===id);
    const unknown=!roadmap || roadmap.limited || !stage || !stage.total;
    const active=!unknown && stage.issues.some(number=>phases.has(number));
    const state=unknown ? "unknown" : active ? "running" : stage.paused ? "paused" : stage.merged===stage.total && !stage.unknown ? "completed" : "waiting";
    if(active)running++;else if(state==="paused")paused++;
    if(!unknown){total+=stage.total;merged+=stage.merged;}
    const card=element("article",undefined,"milestone-card");card.dataset.status=state;
    card.setAttribute("role","button");card.setAttribute("tabindex","0");card.setAttribute("aria-label",id+" · "+names[id]+"，查看任务明细");
    const show=()=>showMilestoneDetail(id,names[id],stage,Boolean(roadmap?.limited));
    card.addEventListener("click",show);card.addEventListener("keydown",event=>{if(event.key==="Enter" || event.key===" "){event.preventDefault();show();}});
    const labels={unknown:"待核实",running:"进行中",paused:"暂停 / 阻塞",completed:"任务已合入 · 验收待确认",waiting:"等待推进"};
    const head=element("div",undefined,"milestone-heading");head.append(element("strong",id+" · "+names[id]),element("span",labels[state],"milestone-state"));card.append(head);
    const track=element("div",undefined,"milestone-track"), fill=element("span",undefined,"milestone-fill");
    track.setAttribute("role","progressbar");track.setAttribute("aria-label",id+" 已归类任务的合入进度");
    if(!unknown){track.setAttribute("aria-valuemin","0");track.setAttribute("aria-valuemax",String(stage.total));track.setAttribute("aria-valuenow",String(stage.merged));fill.style.width=`${stage.merged/stage.total*100}%`;}
    track.setAttribute("aria-valuetext",unknown ? "未知" : `${stage.merged} / ${stage.total} 项已合入${active ? "，执行进度未知" : ""}`);
    track.append(fill);if(active){const motion=element("span",undefined,"milestone-motion");motion.setAttribute("aria-hidden","true");track.append(motion);}card.append(track);
    card.append(element("small",unknown ? "暂无完整的归类与合并证据" : `${stage.merged} / ${stage.total} 项已合入`+(stage.unknown ? ` · ${stage.unknown} 项完成证据待核实` : ""),"hint"));
    node.append(card);
  }
  $("projectPhaseTitle").textContent=!roadmap ? "项目里程碑状态待核实" : running ? `${running} 个里程碑正在推进` : paused ? `${paused} 个里程碑有暂停或阻塞任务` : "已归类里程碑当前无活跃任务";
  $("projectPhaseCount").textContent=roadmap && !roadmap.limited ? `${merged} / ${total} 项已合入` : "—";
  $("projectPhaseDetail").textContent=!roadmap ? "GitHub 状态不可用，无法判断里程碑进度。" : roadmap.limited ? "GitHub 查询达到上限，进度待核实。" : `按任务元数据或 GitHub 里程碑自动归类；未归类 ${roadmap.unclassified} 项。运行状态基于控制台活动，数据可能有延迟。`;
}

function render(data) {
  if (typeof data.instanceId === "string") resetInstance(data.instanceId);
  connected = true;
  $("authPanel").hidden = true;
  $("dot").classList.add("ok");
  $("connection").textContent = "本机已连接";
  const tasks = data.tasks || [];
  for (const group of ["running", "pending", "done"]) $(group).textContent = tasks.filter(t => t.status === group).length;
  $("total").textContent = tasks.length;
  const blocked=tasks.filter(t=>t.status === "blocked" || t.status === "paused").length;
  $("globalRun").dataset.status=data.runner || data.externalLocks ? "running" : blocked ? "paused" : "idle";
  $("globalRun").textContent=data.runner ? "调度运行中" : data.externalLocks ? "外部任务运行中" : blocked ? `${blocked} 项暂停 / 阻塞` : "调度空闲";
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
  $("autoMerge").setAttribute("aria-checked", data.autoMergeEnabled ? "true" : "false");
  $("autoMerge").textContent = "Agent 自动合并：" + (data.autoMergeEnabled ? "开启" : "关闭");
  $("githubStatus").textContent = data.github?.status === "ok" ? "GitHub PR / CI 状态已更新 · " + new Date(data.github.updatedAt).toLocaleTimeString()
    : data.github?.status === "unavailable" ? "GitHub 状态不可用：请检查 gh 登录和网络；任务与 CI 状态未知" : "GitHub 状态加载中";
  $("developmentLane").textContent = data.runner ? "控制台调度运行中" : data.externalLocks ? "存在外部任务锁" : "控制台当前空闲";
  const reportLabel = lane => !lane ? "状态加载中" : lane.status === "unavailable" ? "本地报告状态不可用" : lane.status === "empty" ? "暂无本地建议报告" : `本地报告 ${lane.count} 份 · 最近 ${new Date(lane.lastAt).toLocaleString()}`;
  advisoryState = data.advisory ?? null;
  for (const lane of ["product","quality"]) {
    const prefix=lane === "product" ? "product" : "quality";
    const current=advisoryState?.active?.lane === lane;
    const last=advisoryState?.last?.lane === lane ? advisoryState.last : null;
    $(prefix+"Lane").textContent=current ? "正在分析" : reportLabel(data.lanes?.[lane]);
    $("run"+prefix[0].toUpperCase()+prefix.slice(1)).disabled=Boolean(advisoryState?.active);
    $(prefix+"RunState").textContent=current ? "正在分析"+(advisoryState.active.model ? " · "+(advisoryState.active.model.provider ? advisoryState.active.model.provider+" / "+advisoryState.active.model.model : "Pi 默认（具体模型未知）") : "")+"；可关闭弹窗，任务会继续。" : last?.status === "failed" ? "上次分析失败（"+last.reason+"）；未自动重试。" : last?.status === "completed" ? "上次分析完成，结果仍需人工核实。" : "手动运行一次只读分析，结果需人工核实。";
    const reportKey=last?.status === "completed" ? last.finishedAt : "";
    if (reportKey && $(prefix+"Dialog").open && loadedReportKeys[lane] !== reportKey) {loadedReportKeys[lane]=reportKey;void loadAdvisory(lane);}
  }
  const lessons=data.lanes?.lessons;
  $("lessonsStatus").textContent=lessons?.status === "available" ? `已记录 ${lessons.count} 条教训，${lessons.eligible} 条达到提出申请的条件。每条须有至少 3 个不同日期的证据；维护者核实、批准并通过单独治理 PR，不自动修改规则。` : "复盘规则：同一规则须有至少 3 个不同日期的证据，才可提出人工晋升申请；教训记录状态待核实。";
  renderProjectPhase(data.github,data);
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
  if (Array.isArray(data.taskModels)) actualModels = new Map(data.taskModels.map(m=>[m.taskId+":"+m.role,m]));
  if (data.modelInfo?.status === "ok") {modelSettings=data.modelInfo.settings;renderModelSummary(data.modelInfo);}
  else $("modelSummary").textContent="模型配置不可用，请检查本地配置。";
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
    if (!streamController && !reconnectTimer) void openStream(token);
  } catch (error) {
    if (token !== tokenInput.value.trim()) return;
    if (error.status === 401) {
      lostAuthorization(token);
    } else {
      connected = false;
      $("authPanel").hidden = false;
      $("dot").classList.remove("ok");
      $("connection").textContent = "连接中断";
      $("globalRun").dataset.status="unknown"; $("globalRun").textContent="状态未知";
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
  let reader = null;
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
    reader = response.body.getReader();
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
    // Close the response even when framing fails or the body is unsupported.
    // Otherwise a reconnect can leave the previous SSE request alive indefinitely.
    const reconnect = !controller.signal.aborted;
    controller.abort();
    if (reader) {
      try { void Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
      try { reader.releaseLock(); } catch {}
    }
    if (streamController !== controller) return;
    streamController = null;
    streamToken = null;
    if (reconnect && token === tokenInput.value.trim() && connected) {
      retries = Math.min(retries + 1, 5);
      const wait = Math.min(15000, 750 * 2 ** retries) + Math.floor(Math.random() * 300);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (connected && !document.hidden) void openStream(token);
      }, wait);
    }
  }
}
async function loadAdvisory(lane) {
  const prefix=lane === "product" ? "product" : "quality", node=$(prefix+"Report");
  node.replaceChildren(element("p","正在读取本地报告…","hint"));
  try {
    const {report}=await api("/api/advisory-report?lane="+lane);
    if (!report) {node.replaceChildren(element("p","暂无报告，请手动开始分析。","hint"));return;}
    node.replaceChildren();
    node.append(element("p", "未经核实的模型建议" + (report.createdAt ? " · " + new Date(report.createdAt).toLocaleString() : ""), "notice"));
    const summary=element("div",undefined,"assessment-block");summary.append(element("strong","摘要"),element("p",report.summary));node.append(summary);
    for (const finding of report.findings) {
      const block=element("div",undefined,"assessment-block");
      block.append(element("strong",finding.title),element("p",finding.recommendation),element("small","置信度："+finding.confidence+" · 证据："+(finding.evidence.join("；") || "未提供"),"hint"));node.append(block);
    }
    if (report.unknowns.length) {const block=element("div",undefined,"assessment-block");block.append(element("strong","待核实"),element("p",report.unknowns.join("\n")));node.append(block);}
  } catch(error) {node.replaceChildren(element("p","报告读取失败："+error.message,"error-text"));}
}
async function openAdvisory(lane) {
  if (!connected) return notice("先连接本地控制台。");
  const prefix=lane === "product" ? "product" : "quality";
  $(prefix+"Dialog").showModal();await loadAdvisory(lane);
}
async function startAdvisory(lane) {
  if (!connected) return notice("先连接本地控制台。");
  if (!confirm("即将启动一次只读模型分析，可能产生费用；失败不会自动重试。继续？")) return;
  try {await api("/api/advisory-run",{method:"POST",body:{lane}});await refresh();}
  catch(error){$(lane+"RunState").textContent="分析启动失败："+error.message; }
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
  $("intakeSummary").textContent = (intake.model?.provider ? "模型 "+intake.model.provider+" / "+intake.model.model+" · " : "") + ({assessing:"Agent 正在评估",review:"评估完成，等待确认",submitting:"正在提交需求",submitted:"需求已提交",failed:"评估失败",unknown:"提交结果待核实"})[state] || "状态未知";
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

const pageNames=["Overview","Execution","Monitor","Requirements","Lanes","Models"];
function showPage(name) {
  if (!pageNames.includes(name)) name="Overview";
  for (const page of pageNames) {
    $("page"+page).hidden=page!==name;
    $("nav"+page).setAttribute("aria-current",page===name ? "page" : "false");
  }
  save(preferenceStorage,PAGE_KEY,name);
}
for (const page of pageNames) $("nav"+page).addEventListener("click",()=>showPage(page));
function renderModelSummary(info) {
  const container=$("modelSummary"); container.replaceChildren();
  const names={developer:"Developer",reviewer:"Reviewer",product:"Product",quality:"Quality",intake:"需求评估"};
  for (const [role,label] of Object.entries(names)) {
    const chosen=info.selected?.[role], pool=info.settings.roles[role] ?? info.settings.global;
    const text=info.envOverrides?.[role] ? "环境变量覆盖 · "+(chosen?.provider ?? "默认")+" / "+(chosen?.model ?? "未知") : pool?.length > 1 ? `轮换 ${pool.length} 个 · 示例 ${chosen?.provider ?? "默认"} / ${chosen?.model ?? "未知"}` : chosen?.provider ? chosen.provider+" / "+chosen.model : "Pi 默认（具体模型未知）";
    container.append(element("div",label+"："+text,"model-summary-row"));
  }
}
function modelKey(item) {return item.provider+"\0"+item.model;}
function getScopePool() {
  const scope=$("modelScope").value;
  return scope === "global" ? modelDraft.global : modelDraft.roles[scope];
}
function renderModelChoices() {
  if (!modelDraft) return;
  const scope=$("modelScope").value, inherit=scope!=="global" && modelDraft.roles[scope]===null;
  $("modelInherit").disabled=scope==="global";$("modelInherit").checked=inherit;
  const selected=getScopePool() || [], query=$("modelSearch").value.trim().toLowerCase();
  const favorites=new Set(modelDraft.favorites.map(modelKey));
  const items=new Map(modelCatalog.map(x=>[modelKey(x),{...x,available:true}]));
  for (const x of [...modelDraft.global,...Object.values(modelDraft.roles).flatMap(x=>x??[]),...modelDraft.favorites]) if (!items.has(modelKey(x))) items.set(modelKey(x),{...x,available:false});
  const groups=new Map();
  for (const item of items.values()) {
    if (query && !(item.provider+" "+item.model).toLowerCase().includes(query)) continue;
    const groupName = favorites.has(modelKey(item)) ? "★ 已收藏" : item.provider;
    if (!groups.has(groupName)) groups.set(groupName,[]);
    groups.get(groupName).push(item);
  }
  const container=$("modelGroups");container.replaceChildren();
  let remaining=300;
  for (const [provider,models] of [...groups].sort(([a,aa],[b,bb])=>Number(bb.some(x=>favorites.has(modelKey(x))))-Number(aa.some(x=>favorites.has(modelKey(x)))) || a.localeCompare(b))) {
    if (!remaining) break;
    const group=element("details",undefined,"model-group");group.open=Boolean(query) || provider==="★ 已收藏";
    group.append(element("summary",provider+" · "+models.length));
    models.sort((a,b)=>Number(favorites.has(modelKey(b)))-Number(favorites.has(modelKey(a))) || a.model.localeCompare(b.model));
    const visible=models.slice(0,remaining); remaining-=visible.length;
    for (const item of visible) {
      const row=element("div",undefined,"model-option"), label=element("label"), input=element("input");
      input.type="checkbox";input.checked=selected.some(x=>modelKey(x)===modelKey(item));input.disabled=inherit || (!item.available && !input.checked);
      input.addEventListener("change",()=>{
        const current=getScopePool() || [];const pair={provider:item.provider,model:item.model};
        const next=input.checked ? [...current,pair] : current.filter(x=>modelKey(x)!==modelKey(item));
        if (next.length>20) {input.checked=false;$("modelMessage").textContent="每个模型池最多选择 20 个模型。";return;}
        if(scope==="global")modelDraft.global=next;else modelDraft.roles[scope]=next;
      });
      label.append(input,document.createTextNode(" "+(provider==="★ 已收藏" ? item.provider+" / " : "")+item.model+(item.available ? "" : "（未在本次列表中）")));
      const star=element("button",favorites.has(modelKey(item)) ? "★" : "☆","model-star");star.setAttribute("aria-label",favorites.has(modelKey(item)) ? "取消置顶 "+item.model : "置顶 "+item.model);
      star.addEventListener("click",()=>{const pair={provider:item.provider,model:item.model};modelDraft.favorites=favorites.has(modelKey(item)) ? modelDraft.favorites.filter(x=>modelKey(x)!==modelKey(item)) : [...modelDraft.favorites,pair];renderModelChoices();});
      row.append(label,star);group.append(row);
    }
    container.append(group);
  }
  if (!groups.size) container.append(element("p","没有匹配模型","hint"));
  else if ([...groups.values()].reduce((total,rows)=>total+rows.length,0)>300) container.append(element("p","仅展示前 300 个模型，请继续搜索以缩小范围。","hint"));
}
async function refreshModelCatalog() {
  $("modelMessage").textContent="正在读取本机 Pi 模型列表…";
  $("reloadModels").disabled=true;
  try {const result=await api("/api/model-catalog");modelCatalog=result.models;$("modelMessage").textContent=`发现 ${modelCatalog.length} 个模型；已配置但未列出的模型需自行核实可用性。`+(result.warning ? " Pi 还报告了警告，请在终端核查。" : "");renderModelChoices();}
  catch(error){modelCatalog=[];$("modelMessage").textContent="读取失败：请检查 Pi 登录与网络；已保存配置不会改变。";renderModelChoices();}
  finally {$("reloadModels").disabled=false;}
}
$("openModels").addEventListener("click",async()=>{
  if (!connected || !modelSettings) return notice("先连接控制台并检查模型配置。");
  modelDraft=JSON.parse(JSON.stringify(modelSettings));$("modelScope").value="global";$("modelSearch").value="";$("modelDialog").showModal();renderModelChoices();await refreshModelCatalog();
});
$("closeModels").addEventListener("click",()=>$("modelDialog").close());
$("reloadModels").addEventListener("click",()=>void refreshModelCatalog());
$("modelScope").addEventListener("change",renderModelChoices);
$("modelSearch").addEventListener("input",renderModelChoices);
$("modelInherit").addEventListener("change",()=>{const scope=$("modelScope").value;if(scope==="global")return;modelDraft.roles[scope]=$("modelInherit").checked ? null : [];renderModelChoices();});
$("saveModels").addEventListener("click",async()=>{
  if (!modelDraft) return;
  if (Object.values(modelDraft.roles).some(x=>Array.isArray(x) && x.length===0)) {$("modelMessage").textContent="角色自定义配置至少选一个模型，或选择继承。";return;}
  if (!confirm("保存后新任务将使用所选模型，可能改变模型费用。已有任务继续使用固定模型。确定？"))return;
  try {const result=await api("/api/model-settings",{method:"POST",body:modelDraft});modelSettings=result.settings;$("modelDialog").close();notice("模型配置已保存，仅影响新任务。");await refresh();}
  catch(error){$("modelMessage").textContent="保存失败："+error.message;}
});

for (const lane of ["product","quality"]) {
  const cap=lane[0].toUpperCase()+lane.slice(1);
  $("open"+cap).addEventListener("click",()=>void openAdvisory(lane));
  $("close"+cap).addEventListener("click",()=>$(lane+"Dialog").close());
  $("run"+cap).addEventListener("click",()=>void startAdvisory(lane));
}
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
  try {const result=await api("/api/intake-submit",{method:"POST",body:{id:currentIntake.id,ready,milestone:$("intakeMilestone").value || null}});renderIntake(result);}
  catch(error){$("intakeResult").textContent=error.message === "potential-secret" ? "检测到疑似密钥，未提交。请删除敏感内容后重新评估。" : "提交结果可能不确定，请先检查 GitHub，避免重复提交。";}
});
(function initializePreferences() {
  showPage(stored(preferenceStorage,PAGE_KEY) || "Overview");
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
  $("authPanel").hidden = false; $("connect").textContent = "连接";
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
window.addEventListener("pagehide", stopStream);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    void refresh();
    if (connected && !streamController && !reconnectTimer) void openStream(tokenInput.value.trim());
  }
});
$("closeMilestone").addEventListener("click",()=>$("milestoneDialog").close());
const savedToken = restoreToken();
if (savedToken) {
  tokenInput.value = savedToken;
  void refresh();
}
