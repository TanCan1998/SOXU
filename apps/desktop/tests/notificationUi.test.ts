/**
 * 回归测试：通知的界面与集成约束（V4-S2b，Issue #117）。
 *
 * 这里断言的是源码结构（构建期事实），运行期行为在 `notifications.test.ts`：
 * - Toast 堆栈：最多 4 条、向上增长、点击穿透、悬停暂停、spring 入场、reduced-motion；
 * - 历史抽屉：铃铛打开、时间倒序、可清空、Escape / 遮罩 / × 三条关闭路径；
 * - 集成：走现有事件流（不新增后端 command）、不接系统通知、不改 SettingsDialog；
 * - 声音：Web Audio 合成，`assets/sounds/` 若存在也必须 < 200KB。
 *
 * 真实浏览器里的观感由 tests/harness/shoot-issue-117-toast.mjs 截图佐证，见
 * docs/development/evidence/issue-117-v4-s2b-toast/README.md。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_VISIBLE_TOASTS } from "../src/notifications/toast.ts";

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));
const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));

async function read(relative: string): Promise<string> {
  return readFile(join(SRC_ROOT, relative), "utf8");
}

async function collect(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return collect(full);
      return [full];
    }),
  );
  return files.flat();
}

async function sources(): Promise<Array<{ path: string; text: string }>> {
  const files = await collect(SRC_ROOT);
  return Promise.all(files.map(async (path) => ({ path, text: await readFile(path, "utf8") })));
}

test("Toast 堆栈：最多 4 条、向上增长、点击穿透", async () => {
  assert.equal(MAX_VISIBLE_TOASTS, 4);

  const toasts = await read("components/NotificationToasts.vue");
  assert.ok(toasts.includes("toast-stack"), "必须有固定的堆栈容器");
  assert.ok(
    toasts.includes("flex-direction: column") && toasts.includes("align-items: flex-end"),
    "向上增长：column + 右下角对齐，新条目从底部出现",
  );
  assert.ok(toasts.includes("right: 18px") && toasts.includes("bottom: 18px"), "固定在右下角");
  assert.ok(toasts.includes("pointer-events: none"), "容器必须允许点击穿透");
  assert.ok(toasts.includes("pointer-events: auto"), "卡片本身要能接收点击");
  assert.ok(toasts.includes("aria-live=\"polite\""), "新增通知要能被读屏播报");
  assert.ok(toasts.includes("aria-relevant=\"additions\""), "只在新增时播报，移除不必朗读");
});

test("Toast 卡片：图标 + 标题 + 正文 + 可选操作 + 关闭按钮", async () => {
  const toasts = await read("components/NotificationToasts.vue");

  for (const marker of ["toast-icon", "toast-title", "toast-text", "toast-action", "toast-close"]) {
    assert.ok(toasts.includes(marker), `卡片缺少 ${marker}`);
  }
  assert.ok(toasts.includes("toast.actionLabel"), "操作按钮只在有目标时渲染");
  assert.ok(toasts.includes(':role="toast.severity === \'error\' ? \'alert\' : \'status\'"'), "错误用 alert");
  // 关闭按钮：可点、有无障碍名称、不是 disabled（disabled 的关闭按钮等于死按钮）。
  assert.match(toasts, /class="toast-close"[\s\S]{0,200}aria-label="关闭通知"/);
  assert.match(toasts, /aria-label="关闭通知"[\s\S]{0,80}@click\.stop="emit\('dismiss', toast\.id\)"/);
  // 点卡片空白处同样关闭（点击穿透关闭），按钮自己 stopPropagation。
  assert.ok(toasts.includes('target.closest("button")'), "卡片点击不能吞掉按钮的点击");
});

test("Toast 动效：--ease-spring 入场、消失前淡出、reduced-motion 退化", async () => {
  const toasts = await read("components/NotificationToasts.vue");

  assert.ok(toasts.includes("var(--ease-spring)"), "入场缓动必须是 --ease-spring");
  assert.match(
    toasts,
    /\.toast-enter-from \{[\s\S]*?translate\(26px, 18px\) scale\(0\.96\)/,
    "入场：从右下滑入 + 轻微缩放",
  );
  assert.ok(toasts.includes('.toast[data-fading="true"]'), "自动消失前先进入淡出状态");
  assert.ok(toasts.includes("prefers-reduced-motion"), "必须照顾减少动效偏好");
  assert.ok(toasts.includes("transform: none"), "reduced-motion 下取消位移");

  // 淡出必须早于移除：store 在到期前 TOAST_FADE_LEAD_MS 就置位。
  const store = await read("stores/notifications.ts");
  assert.ok(store.includes("TOAST_FADE_LEAD_MS"), "淡出提前量必须来自常量，不能在两处各写一个数");
  assert.match(store, /const fadeIn = total - TOAST_FADE_LEAD_MS/, "计时器要按提前量安排淡出");
});

test("Toast 悬停暂停：鼠标与键盘焦点都暂停倒计时", async () => {
  const toasts = await read("components/NotificationToasts.vue");
  assert.ok(toasts.includes('@mouseenter="emit(\'pause\', toast.id)"'));
  assert.ok(toasts.includes('@mouseleave="emit(\'resume\', toast.id)"'));
  assert.ok(toasts.includes('@focusin="emit(\'pause\', toast.id)"'), "键盘用户把焦点移进来也要暂停");
  assert.ok(toasts.includes('@focusout="emit(\'resume\', toast.id)"'));

  const store = await read("stores/notifications.ts");
  assert.match(store, /function pause\(id: string\)/, "暂停逻辑在 store 里");
  assert.match(store, /function resume\(id: string\)/, "恢复逻辑在 store 里");
  assert.ok(store.includes("remainingMs("), "暂停必须折算已消耗时间，不能重置成完整时长");
});

test("常驻模式：durationMs 为 null 时不建定时器，只能手动关", async () => {
  const store = await read("stores/notifications.ts");
  assert.match(store, /if \(durationMs === null\) return;/, "常驻不安排自动关闭");
  assert.match(store, /remaining: number \| null/, "计时状态用 null 表达常驻");
});

test("历史抽屉：倒序列表、可清空、三条关闭路径", async () => {
  const drawer = await read("components/NotificationHistoryDrawer.vue");

  assert.ok(drawer.includes('role="dialog"'), "抽屉是模态对话框语义");
  assert.ok(drawer.includes('aria-modal="true"'));
  assert.ok(drawer.includes('aria-label="通知历史"'));
  assert.ok(drawer.includes("formatNotificationClock"), "时间格式统一走 history.ts");
  assert.ok(drawer.includes("清空"), "必须有清空入口");
  assert.ok(drawer.includes("本次运行还没有通知"), "空状态要说明重启会清空");
  assert.ok(drawer.includes('v-for="record in records"'), "按 store 给的顺序渲染（时间倒序）");
  // 三条关闭路径：× / 遮罩 / Escape。
  assert.match(drawer, /aria-label="关闭通知历史"[\s\S]{0,120}@click="emit\('close'\)"/);
  assert.ok(drawer.includes('@click.self="emit(\'close\')"'), "遮罩点击关闭");
  assert.ok(drawer.includes('@keydown.escape="emit(\'close\')"'), "Escape 关闭");
  // 键盘可达：打开时把焦点移进抽屉，关闭时还回去。
  assert.ok(drawer.includes("panel.value?.focus()"), "打开抽屉要把焦点移进去");
  assert.ok(drawer.includes("restoreTarget?.focus()"), "关闭抽屉要把焦点还给触发元素");
});

test("App.vue：铃铛是活按钮，接上抽屉与 Toast 堆栈", async () => {
  const app = await read("App.vue");

  assert.ok(app.includes("Bell"), "顶栏需要铃铛图标");
  assert.ok(app.includes('aria-label="通知历史"'), "铃铛要有无障碍名称");
  assert.ok(app.includes('@click="toggleNotifications"'), "铃铛不能是死按钮");
  assert.ok(app.includes(':aria-expanded="notificationsOpen"'), "展开状态要暴露给读屏");
  assert.ok(app.includes("function toggleNotifications()"), "开关必须落到状态上");
  assert.ok(app.includes("notifications.markAllRead()"), "打开抽屉即已读");
  assert.ok(app.includes("useNotifications"), "事件接线走 composable");
  assert.ok(app.includes("<NotificationToasts"), "App 必须渲染 toast 堆栈");
  assert.ok(app.includes("<NotificationHistoryDrawer"), "App 必须渲染历史抽屉");
  assert.ok(app.includes('@open="openNotificationTarget"'), "toast 的「查看会话」要能跳转");

  // 跳转只对仍然打开的 Tab 生效：否则 activeSessionId 指向不存在的 Tab，界面掉到欢迎页。
  assert.match(
    app,
    /function openNotificationTarget\(sessionId: SessionId\) \{\s*const tab = store\.state\.tabs\.find/,
  );
});

test("集成：复用现有事件流，不新增后端 command，不接系统通知", async () => {
  const workspace = await read("stores/workspace.ts");
  assert.ok(workspace.includes("onRuntimeEvent"), "通知层通过 workspace store 订阅事件");

  const session = await read("workspace/sessionWorkspace.ts");
  assert.ok(session.includes("onRuntimeEvent"), "事件流由会话核心转出");
  assert.match(
    session,
    /this\.publish\(event, tab, \{ previousStatus \}\)/,
    "只在 generation gate 之后转给观察者，并带上处理前的状态（取消后不算完成）",
  );

  const composable = await read("composables/useNotifications.ts");
  assert.ok(composable.includes("onScopeDispose"), "订阅与 store 必须在同一作用域销毁");
  assert.ok(composable.includes("notifications.dispose()"), "卸载时释放定时器/监听/AudioContext");

  const packageJson = await readFile(join(APP_ROOT, "package.json"), "utf8");
  assert.ok(
    !packageJson.includes("plugin-notification"),
    "不接 tauri-plugin-notification：全部走应用内提示",
  );

  const all = await sources();
  const systemNotification = all.filter((file) =>
    /sendNotification|requestPermission|new Notification\(/.test(file.text),
  );
  assert.deepEqual(
    systemNotification.map((file) => file.path),
    [],
    "不得调用任何系统通知 API",
  );
});

test("声音：Web Audio 合成，assets/sounds 总大小 < 200KB", async () => {
  const sounds = await read("notifications/sounds.ts");
  assert.ok(sounds.includes("createOscillator"), "音效必须由 Web Audio 现场合成");
  assert.ok(sounds.includes("createGain"), "音量与包络走 GainNode");
  assert.ok(sounds.includes("SOUND_TONES"), "六个预设集中在音符表里");

  const dir = join(SRC_ROOT, "assets", "sounds");
  let total = 0;
  try {
    for (const file of await collect(dir)) {
      total += (await stat(file)).size;
    }
  } catch {
    // 目录不存在是允许的：合成方案不需要任何音频文件。
    total = 0;
  }
  assert.ok(total < 200 * 1024, `音频资源必须 < 200KB，实际 ${total} 字节`);
});

test("设置：三类事件独立开关 + 持久化，且不改 SettingsDialog（由设置页 issue 负责）", async () => {
  const settings = await read("notifications/settings.ts");
  assert.ok(settings.includes('"soxu.notifications"'), "存储键独立，不与主题/投递方式共用");
  assert.ok(settings.includes("NOTIFICATION_EVENT_META"), "三类事件的元数据集中一处");
  assert.ok(settings.includes("persistNotificationSettings"), "设置必须能持久化");
  assert.ok(settings.includes("onlyWhenUnfocused"), "仅失焦时提醒是全局开关");

  const store = await read("stores/notifications.ts");
  for (const action of [
    "setDuration",
    "setEventEnabled",
    "setEventSound",
    "setSoundEnabled",
    "setVolume",
    "previewSound",
  ]) {
    assert.ok(store.includes(`function ${action}`), `store 必须暴露 ${action}（设置页依赖它）`);
  }

  // 本切片只提供 store：设置页 UI 由另一个 issue 负责，这里不得顺手改 SettingsDialog。
  const dialog = await read("components/SettingsDialog.vue");
  assert.ok(
    !/notification|notifications/i.test(dialog),
    "SettingsDialog.vue 不属于本切片范围",
  );
});
