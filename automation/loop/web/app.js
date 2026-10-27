const $ = id => document.getElementById(id);
const tokenInput = $("token");
let connected = false, requestInFlight = false, latestSequence = 0;
const TOKEN_STORAGE_KEY = "soxu.dashboard.sessionToken.v1";
// Keep this per-tab only: the server rotates its secret on each dashboard launch.
function restoreToken() {
  try {
    const value = sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (!value) return "";
    if (/^[0-9a-f]{48}$/i.test(value)) return value;
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch { /* Storage may be blocked by browser privacy settings. */ }
  return "";
}
function rememberToken(token) {
  try { sessionStorage.setItem(TOKEN_STORAGE_KEY, token); } catch {}
}
function forgetToken(token) {
  try {
    if (sessionStorage.getItem(TOKEN_STORAGE_KEY) === token) sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {}
}
const stateLabels = { running: "进行中", paused: "已暂停", blocked: "已阻塞", pending: "等待", done: "完成" };
const phaseLabels = { worktree:"准备工作树", install:"安装依赖", develop:"开发", checks:"执行检查", review:"代码审查", finalChecks:"最终检查", commit:"提交", push:"推送", createPr:"创建 PR", merge:"等待合并", done:"完成" };
function notice(message) { $("notice").textContent = message; }
async function api(path, options = {}, token = tokenInput.value.trim()) {
  if (!/^[0-9a-f]{48}$/i.test(token)) throw new Error("请填写终端生成的 48 位令牌。");
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: { "X-SOXU-Control-Token": token, ...(options.method ? { "Content-Type": "application/json" } : {}) },
    ...(options.method ? { body: JSON.stringify(options.body ?? {}) } : {}),
    cache:"no-store", credentials:"omit", signal:AbortSignal.timeout(9000)
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}
function element(tag, text, cls) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = String(text);
  if (cls) el.className = cls;
  return el;
}
function render(data) {
  connected = true;
  $("connection").textContent = "本机已连接";
  $("dot").classList.add("ok");
  const tasks = data.tasks || [];
  for (const group of ["running","pending","done"]) $(""+group).textContent = tasks.filter(t => t.status === group).length;
  $("total").textContent = tasks.length;
  $("badge").textContent = data.runner ? (data.runner.stopping ? "停止中" : "运行中") : data.externalLocks ? "外部任务执行中" : "空闲";
  $("runner").textContent = data.runner ? `正在执行 ${data.runner.command} · 开始于 ${new Date(data.runner.startedAt).toLocaleTimeString()}`
    : data.externalLocks ? `检测到 ${data.externalLocks} 个正在运行的工作树锁（此处不能停止）`
    : data.lastRun ? `上次执行 ${data.lastRun.command} · 退出码 ${data.lastRun.exitCode ?? "未知"}` : "未启动调度";
  $("updated").textContent = "更新于 " + new Date(data.generatedAt).toLocaleTimeString();
  for (const button of document.querySelectorAll("[data-command]")) button.disabled = data.busy;
  $("stop").disabled = !data.runner || data.runner.stopping;
  const node = $("tasks");
  node.replaceChildren();
  const sorted = [...tasks].sort((a,b) => a.id - b.id);
  for (const task of sorted) {
    const card = element("article",undefined,"task");
    card.append(element("div","#"+task.id,"task-id"),element("div",task.title,"task-name"));
    const status = element("div",stateLabels[task.status]||task.status,"task-state");
    status.dataset.state=task.status;
    card.append(status, element("div",phaseLabels[task.phase]||task.phase||"尚未开始","task-stage"),
      element("div",task.updatedAt?new Date(task.updatedAt).toLocaleTimeString():"—","task-time"));
    node.append(card);
  }
  if (!tasks.length) node.append(element("div","暂无任务","empty"));
  const logNode=$("logs"), nearBottom=logNode.scrollTop+logNode.clientHeight>=logNode.scrollHeight-35;
  if (data.log.length===0) {
    logNode.replaceChildren(element("div","暂无协调器日志","empty"));
  } else if (data.log[data.log.length-1].seq!==latestSequence) {
    logNode.replaceChildren();
    for(const entry of data.log) {
      const line=element("div",undefined,"log");
      line.dataset.stream=entry.stream;
      line.append(element("span",new Date(entry.time).toLocaleTimeString(),"time"),document.createTextNode(entry.message));
      logNode.append(line);
    }
    latestSequence=data.log[data.log.length-1].seq;
    if(nearBottom)logNode.scrollTop=logNode.scrollHeight;
  }
}
async function refresh() {
  const token = tokenInput.value.trim();
  if (requestInFlight || document.hidden || !token) return;
  requestInFlight = true;
  try {
    const data = await api("/api/status", {}, token);
    // Ignore responses for a previous token if the user edited the input mid-request.
    if (token !== tokenInput.value.trim()) return;
    const wasConnected = connected;
    render(data);
    rememberToken(token); // Only persist an authenticated session.
    if (!wasConnected) notice("连接成功；刷新此标签页后将自动恢复连接。");
  } catch (error) {
    if (token !== tokenInput.value.trim()) return;
    connected = false;
    $("dot").classList.remove("ok");
    $("connection").textContent = "未连接";
    for (const button of document.querySelectorAll("[data-command]")) button.disabled = true;
    $("stop").disabled = true;
    if (error.status === 401) {
      forgetToken(token); // A restarted dashboard uses a different token.
      tokenInput.value = "";
      notice("访问令牌已失效或错误，请粘贴本次启动的新令牌。");
    } else {
      notice(`连接失败：${error.message}`);
    }
  } finally {
    requestInFlight = false;
  }
}
async function execute(command){
  if(!connected) return notice("先连接本地控制台。");
  if(command==="watch"&&!confirm("持续监控可重复执行 Agent 任务并产生模型费用。确认启用受策略限制的 watch？"))return;
  if(command==="resume"&&!confirm("即将恢复全部中断任务，可能产生模型调用。确认？"))return;
  try{const result=await api("/api/run",{method:"POST",body:{command}});notice(`已接受：${result.command}。停止仅作用于此控制台启动的任务。`);await refresh();}
  catch(error){notice(`操作失败：${error.message}`);}
}
$("connect").addEventListener("click",()=>void refresh());
tokenInput.addEventListener("keydown",event=>{if(event.key==="Enter")void refresh();});
tokenInput.addEventListener("input", () => {
  connected = false;
  $("dot").classList.remove("ok");
  $("connection").textContent = "尚未连接";
  for (const button of document.querySelectorAll("[data-command]")) button.disabled = true;
  $("stop").disabled = true;
});
for(const button of document.querySelectorAll("[data-command]"))button.addEventListener("click",()=>void execute(button.dataset.command));
$("stop").addEventListener("click",async()=>{if(!confirm("请求优雅停止当前调度；工作树和检查点将保留。确定吗？"))return;try{await api("/api/stop",{method:"POST",body:{}});notice("已发送停止信号，等待当前 Runner 退出。");await refresh();}catch(error){notice(`停止失败：${error.message}`);}});
$("refresh").addEventListener("click",()=>void refresh());
setInterval(()=>void refresh(),2500);
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
const savedToken = restoreToken();
if (savedToken) {
  tokenInput.value = savedToken;
  void refresh();
}
