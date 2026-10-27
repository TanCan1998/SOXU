// PiDeck host plugin: fixed-port GET only; no remote calls, file access or Pi control.
const tokenInput = document.getElementById("token");
const status = document.getElementById("status");
const tasksNode = document.getElementById("tasks");
const refreshButton = document.getElementById("refresh");
let inFlight = false;

function showStatus(message, error = false) {
  status.textContent = message;
  status.className = error ? "warning" : "";
}
function render(snapshot) {
  tasksNode.replaceChildren();
  const tasks = Array.isArray(snapshot.tasks) ? [...snapshot.tasks].sort((a,b) => a.id - b.id) : [];
  for (const task of tasks) {
    const card = document.createElement("article");
    card.className = "task";
    const title = document.createElement("div");
    title.className = "task-title";
    title.textContent = `#${task.id} ${task.title}`;
    const meta = document.createElement("div");
    meta.className = "task-meta";
    meta.textContent = `检查点: ${task.status} · 阶段: ${task.phase ?? "未开始"} · 更新: ${task.updatedAt ?? "无"}`;
    card.append(title, meta);
    tasksNode.append(card);
  }
  if (!tasks.length) showStatus("没有发现本地任务；确认 observer 在 SOXU 根目录启动。");
  else showStatus(`已读取 ${tasks.length} 个本地任务。注意：running 只表示检查点状态，不代表进程仍在运行。`);
}
async function refresh() {
  if (inFlight || document.hidden) return;
  const token = tokenInput.value.trim();
  if (!/^[0-9a-f]{48}$/i.test(token)) {
    showStatus("请填写本次启动打印的 48 位十六进制令牌。", true);
    return;
  }
  inFlight = true;
  refreshButton.disabled = true;
  try {
    if (!window.pideck?.network?.request) throw new Error("PiDeck 当前版本不支持宿主插件本地网络接口。");
    const response = await window.pideck.network.request({
      url: "http://127.0.0.1:47321/v1/tasks", method: "GET",
      headers: { "X-SOXU-Observer-Token": token }, timeoutMs: 3000,
    });
    if (!response.ok) throw new Error(response.status === 401 ? "令牌错误或观测服务已重启。" : `HTTP ${response.status}`);
    const snapshot = JSON.parse(response.body);
    if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.tasks)) throw new Error("不兼容的观测接口版本。");
    render(snapshot);
  } catch (error) {
    showStatus(`读取失败：${error?.message ?? "服务未连接"}`, true);
  } finally {
    inFlight = false;
    refreshButton.disabled = false;
  }
}
refreshButton.addEventListener("click", () => void refresh());
const timer = setInterval(() => { if (tokenInput.value && !document.hidden) void refresh(); }, 5000);
window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
