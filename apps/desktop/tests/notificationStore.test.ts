/**
 * 回归测试：通知 store 与事件流接线（V4-S2b，Issue #117）。
 *
 * 上半部分（`notifications.test.ts`）测的是纯逻辑：分类、时长、历史上限、队列、声音、焦点。
 * 这里测的是把它们接起来之后的行为：
 * - 事件开关关闭时三个可见面（弹窗 / 历史 / 声音）同时关闭；
 * - 一次交互请求的多条记录只提醒一次（dedupeKey）；
 * - 设置改动落盘、启动不写默认值；
 * - dispose 之后不再产生通知；
 * - 事件流接线复用 workspace 的 generation gate（迟到事件不触发通知，观察者异常不影响会话状态）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";

import type { NotificationEvent } from "../src/notifications/events.ts";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  NOTIFICATIONS_STORAGE_KEY,
} from "../src/notifications/settings.ts";
import { useNotificationStore } from "../src/stores/notifications.ts";
import type { KeyValueStorage } from "../src/settings/busyDelivery.ts";
import { WorkspaceSession } from "../src/workspace/sessionWorkspace.ts";
import type { RuntimeEvent, RuntimeEventBody } from "../src/workspace/types.ts";
import { FakeBridge } from "./support/fakeBridge.ts";

class FakeStorage implements KeyValueStorage {
  readonly entries = new Map<string, string>();
  failOnSet = false;

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failOnSet) throw new Error("QuotaExceededError");
    this.entries.set(key, value);
  }
}

function event(body: RuntimeEventBody): RuntimeEvent {
  return { sessionId: "ses_a", runtimeId: "ses_a#1", generation: 3, ...body };
}

function notification(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    kind: "sessionCompleted",
    severity: "success",
    title: "会话完成",
    body: "「重构通知」已完成这一轮回答",
    sessionId: "ses_a",
    actionLabel: "查看会话",
    dedupeKey: null,
    ...overrides,
  };
}

// ─────────────────────────── store 集成 ───────────────────────────

function withStorage<T>(run: (storage: FakeStorage) => Promise<T>): Promise<T> {
  const storage = new FakeStorage();
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
  return run(storage).finally(() => {
    Reflect.deleteProperty(globalThis, "localStorage");
  });
}

function freshStore() {
  setActivePinia(createPinia());
  return useNotificationStore();
}

test("store：事件开关关闭时既不弹窗也不记历史", async () => {
  await withStorage(async () => {
    const store = freshStore();
    try {
      // store 里的元素是响应式代理，比较身份要用 id（直接 strictEqual 会拿到两个包装）。
      assert.equal(store.notify(notification())?.id, store.toasts[0]?.id, "默认开启：弹窗");
      assert.equal(store.history.length, 1);

      store.setEventEnabled("sessionCompleted", false);
      assert.equal(store.notify(notification({ body: "第二次" })), null);
      assert.equal(store.toasts.length, 1, "开关关闭后不再新增 toast");
      assert.equal(store.history.length, 1, "开关关闭后不再记历史");
    } finally {
      store.dispose();
    }
  });
});

test("store：运行时事件 → 通知，且按 dedupeKey 合并交互请求", async () => {
  await withStorage(async () => {
    const store = freshStore();
    try {
      // 等待输入默认关闭：后端降级的 warning 不应弹窗。
      const warning = event({ type: "warning", detail: "未处理的记录类型：extension_ui_request" });
      assert.equal(store.handleRuntimeEvent(warning, { title: "发布" }), null);
      assert.equal(store.history.length, 0);

      store.setEventEnabled("awaitingInput", true);
      const first = store.handleRuntimeEvent(warning, { title: "发布" });
      assert.ok(first);
      assert.equal(store.toasts.length, 1);

      // 同一次请求的第二条记录（协议警告）被合并，不重复弹窗。
      const second = store.handleRuntimeEvent(
        event({ type: "warning", detail: "extension ui request is not implemented" }),
        { title: "发布" },
      );
      assert.equal(second?.id, first.id);
      assert.equal(store.toasts.length, 1, "同一交互请求只提醒一次");

      const completed = store.handleRuntimeEvent(event({ type: "settled" }), { title: "发布" });
      assert.equal(completed?.kind, "sessionCompleted");
      assert.equal(store.toasts.length, 2);
      assert.equal(store.history.length, 2);
      assert.equal(store.history[0]?.title, "会话完成", "历史按时间倒序");
      assert.equal(store.unreadCount, 2);
    } finally {
      store.dispose();
    }
  });
});

test("store：手动关闭与清空历史都真的改状态", async () => {
  await withStorage(async () => {
    const store = freshStore();
    try {
      const toast = store.notify(notification());
      assert.ok(toast);
      store.dismiss(toast.id);
      assert.equal(store.toasts.length, 0);

      store.notify(notification({ sessionId: "ses_b" }));
      store.notify(notification({ sessionId: "ses_c" }));
      // 未读数统计「抽屉上次打开之后新增的通知」：手动关掉 toast 不会把已产生的记录抹掉。
      assert.equal(store.unreadCount, 3);
      store.markAllRead();
      assert.equal(store.unreadCount, 0, "打开抽屉即已读");
      assert.equal(store.history.length, 3, "已读不清空历史");

      store.clearHistory();
      assert.deepEqual(store.history, []);
      assert.equal(store.unreadCount, 0);
    } finally {
      store.dispose();
    }
  });
});

test("store：设置改动落盘，启动不写默认值", async () => {
  await withStorage(async (storage) => {
    const store = freshStore();
    try {
      assert.equal(storage.entries.size, 0, "启动时不能把默认值写进存储");

      store.setDuration(30000);
      await nextTick();
      const saved = JSON.parse(storage.entries.get(NOTIFICATIONS_STORAGE_KEY) ?? "{}");
      assert.equal(saved.duration, 30000);

      store.setEventEnabled("awaitingInput", true);
      store.setEventSound("awaitingInput", "bell");
      store.setVolume(0.4);
      await nextTick();
      const next = JSON.parse(storage.entries.get(NOTIFICATIONS_STORAGE_KEY) ?? "{}");
      assert.equal(next.events.awaitingInput.enabled, true);
      assert.equal(next.events.awaitingInput.sound, "bell");
      assert.equal(next.volume, 0.4);

      store.resetSettings();
      await nextTick();
      assert.deepEqual(store.settings, DEFAULT_NOTIFICATION_SETTINGS);
    } finally {
      store.dispose();
    }
  });
});

test("store：dispose 之后不再产生通知，也不再写状态", async () => {
  await withStorage(async () => {
    const store = freshStore();
    store.notify(notification());
    store.dispose();
    assert.deepEqual(store.toasts, [], "dispose 清空未关闭的 toast");
    assert.equal(store.notify(notification({ sessionId: "ses_b" })), null);
    assert.equal(store.history.length, 1);
  });
});

// ─────────────────────── 事件流接线（不新增后端通道） ───────────────────────

test("事件流接线：观察者只收到通过 generation gate 的事件，抛错不影响会话状态", async () => {
  const bridge = new FakeBridge();
  const session = new WorkspaceSession(bridge);
  await session.openSession({ sessionId: "ses_a", projectId: "prj_1", title: "会话 A" });
  await session.startRuntime("ses_a");

  const seen: string[] = [];
  const stop = session.onRuntimeEvent((runtimeEvent, tab) => {
    seen.push(`${runtimeEvent.type}:${tab.title}`);
  });

  // 迟到事件（上一代 generation）必须被 gate 挡在通知层之前。
  bridge.deliver({
    sessionId: "ses_a",
    runtimeId: "ses_a#1",
    generation: 0,
    type: "settled",
  });
  assert.deepEqual(seen, [], "迟到事件不该触发通知");

  bridge.deliver({
    sessionId: "ses_a",
    runtimeId: "ses_a#1",
    generation: 1,
    type: "settled",
  });
  assert.deepEqual(seen, ["settled:会话 A"]);

  // 旁路观察者抛错不能把会话状态带坏。
  const stopBroken = session.onRuntimeEvent(() => {
    throw new Error("通知层炸了");
  });
  bridge.deliver({
    sessionId: "ses_a",
    runtimeId: "ses_a#1",
    generation: 1,
    type: "stream",
    event: "message_update",
    data: { delta: "hi" },
  });
  assert.equal(session.tab("ses_a")?.status, "ready", "观察者异常不影响 Tab 状态");

  stop();
  stopBroken();
  const beforeStop = seen.length;
  bridge.deliver({
    sessionId: "ses_a",
    runtimeId: "ses_a#1",
    generation: 1,
    type: "settled",
  });
  assert.equal(seen.length, beforeStop, "取消订阅后不再收到事件");

  await session.dispose();
});

test("事件流接线：dispose 之后注册的观察者收不到任何事件", async () => {
  const bridge = new FakeBridge();
  const session = new WorkspaceSession(bridge);
  await session.openSession({ sessionId: "ses_a", projectId: "prj_1", title: "会话 A" });
  await session.startRuntime("ses_a");
  const stop = session.onRuntimeEvent(() => {
    throw new Error("不该被调用");
  });
  await session.dispose();
  stop();
  const seen: string[] = [];
  const late = session.onRuntimeEvent(() => seen.push("late"));
  bridge.deliver({
    sessionId: "ses_a",
    runtimeId: "ses_a#1",
    generation: 1,
    type: "settled",
  });
  assert.deepEqual(seen, []);
  late();
});

test("store：试听走当前音量，不受仅失焦限制", async () => {
  await withStorage(async () => {
    const store = freshStore();
    try {
      // Node 里没有 AudioContext：试听必须静默失败而不是抛错。
      assert.equal(store.previewSound("sessionError"), false);
      store.setVolume(0);
      assert.equal(store.previewSound(), false);
    } finally {
      store.dispose();
    }
  });
});
