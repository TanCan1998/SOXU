/**
 * V4-S2b 通知夹具（Issue #117）。
 *
 * 挂载的是**真实组件与真实 store**（NotificationToasts / NotificationHistoryDrawer /
 * useNotificationStore），只是事件来源换成了 `window.__soxuToast` 的调试入口：
 * 这样截图与指标验证的是生产代码路径，而不是另写一份"演示版"。
 *
 * 不连接 Pi，也不连 Tauri：通知不需要后端就能验证（这正是本切片的设计）。
 */

import { createPinia } from "pinia";
import { createApp, defineComponent, h, ref } from "vue";

import NotificationHistoryDrawer from "../../src/components/NotificationHistoryDrawer.vue";
import NotificationToasts from "../../src/components/NotificationToasts.vue";
import type { NotificationEvent } from "../../src/notifications/events.ts";
import type { NotificationEventKind, ToastDuration } from "../../src/notifications/settings.ts";
import { useNotificationStore } from "../../src/stores/notifications.ts";
import "../../src/styles/tokens.css";
import "../../src/styles/base.css";

/** 三类事件各一份固定文案，截图可复现。 */
const SAMPLES: Record<NotificationEventKind, NotificationEvent> = {
  sessionCompleted: {
    kind: "sessionCompleted",
    severity: "success",
    title: "会话完成",
    body: "「重构通知层」已完成这一轮回答",
    sessionId: "ses_demo_completed",
    actionLabel: "查看会话",
    dedupeKey: null,
  },
  sessionError: {
    kind: "sessionError",
    severity: "error",
    title: "会话出错",
    body: "「修复 CI」运行时异常退出（child_exited）",
    sessionId: "ses_demo_error",
    actionLabel: "查看会话",
    dedupeKey: null,
  },
  awaitingInput: {
    kind: "awaitingInput",
    severity: "info",
    title: "等待你的输入",
    body: "「发布 0.2.0」正在等待你选择或确认",
    sessionId: "ses_demo_input",
    actionLabel: "查看会话",
    dedupeKey: "awaitingInput:ses_demo_input",
  },
};

const Harness = defineComponent({
  name: "NotificationHarness",
  setup() {
    const store = useNotificationStore();
    const drawerOpen = ref(false);

    function push(kind: NotificationEventKind, sessionSuffix = "") {
      const sample = SAMPLES[kind];
      return store.notify({
        ...sample,
        sessionId: `${sample.sessionId}${sessionSuffix}`,
        dedupeKey: sample.dedupeKey ? `${sample.dedupeKey}${sessionSuffix}` : null,
      });
    }

    // 调试入口：证据脚本通过它推通知、切设置、量状态。
    const api = {
      push,
      pushAll() {
        // 「等待输入」默认关闭（Issue #117 的事件表），演示前显式打开——
        // 与设置页开关的效果完全一致，走的是同一个 store 动作。
        store.setEventEnabled("awaitingInput", true);
        push("sessionCompleted");
        push("sessionError");
        push("awaitingInput");
      },
      pushMany(count: number) {
        for (let index = 0; index < count; index += 1) {
          push("sessionCompleted", `_${index}`);
        }
      },
      visible: () => store.visibleToasts.length,
      queued: () => store.queuedToasts,
      total: () => store.toasts.length,
      history: () => store.history.length,
      unread: () => store.unreadCount,
      ids: () => store.toasts.map((toast) => toast.id),
      fading: () => store.toasts.filter((toast) => toast.fading).length,
      titles: () => store.history.map((record) => record.title),
      settings: () => JSON.parse(JSON.stringify(store.settings)) as Record<string, unknown>,
      setDuration(value: ToastDuration) {
        store.setDuration(value);
      },
      enableEvent(kind: NotificationEventKind, enabled: boolean) {
        store.setEventEnabled(kind, enabled);
      },
      preview: () => store.previewSound("sessionCompleted"),
      audioState() {
        const scope = globalThis as {
          AudioContext?: new () => { state: string };
          webkitAudioContext?: new () => { state: string };
        };
        const Ctor = scope.AudioContext ?? scope.webkitAudioContext;
        if (!Ctor) return "unsupported";
        try {
          return new Ctor().state;
        } catch {
          return "blocked";
        }
      },
      openDrawer() {
        drawerOpen.value = true;
        store.markAllRead();
      },
      closeDrawer() {
        drawerOpen.value = false;
      },
      setTheme(theme: "light" | "dark") {
        document.documentElement.dataset.theme = theme;
      },
      stackMetrics() {
        const stack = document.querySelector(".toast-stack");
        const card = document.querySelector(".toast");
        if (!stack || !card) return null;
        const stackStyle = getComputedStyle(stack);
        const cardStyle = getComputedStyle(card);
        const rect = stack.getBoundingClientRect();
        return {
          stackPosition: stackStyle.position,
          stackPointerEvents: stackStyle.pointerEvents,
          cardPointerEvents: cardStyle.pointerEvents,
          rightGap: Math.round(window.innerWidth - rect.right),
          bottomGap: Math.round(window.innerHeight - rect.bottom),
          direction: stackStyle.flexDirection,
          cards: document.querySelectorAll(".toast").length,
          cardRadius: cardStyle.borderRadius,
          cardBackground: cardStyle.backgroundColor,
        };
      },
      drawerMetrics() {
        const panel = document.querySelector(".drawer-panel");
        if (!panel) return null;
        return {
          role: panel.getAttribute("role"),
          ariaModal: panel.getAttribute("aria-modal"),
          ariaLabel: panel.getAttribute("aria-label"),
          rows: panel.querySelectorAll(".drawer-record").length,
          firstTitle: panel.querySelector(".record-title")?.textContent ?? null,
          times: Array.from(panel.querySelectorAll(".record-time")).map((node) => node.textContent),
          empty: Boolean(panel.querySelector(".drawer-empty")),
          focusInside: panel.contains(document.activeElement),
        };
      },
    };

    (globalThis as { __soxuToast?: typeof api }).__soxuToast = api;

    return () =>
      h("div", { class: "app-shell" }, [
        // 一块浅色画布：真实应用里 toast 浮在会话正文之上，
        // 纯白背景会让白色卡片看不出边界，截图也就看不出层次。
        h("div", {
          class: "harness-canvas",
          style: "flex:1;background:var(--bg-sidebar);display:grid;place-items:center;color:var(--fg-subtle);font-size:var(--fs-caption)",
        }, "SOXU · 通知夹具（Issue #117）"),
        h(NotificationToasts, {
          toasts: store.visibleToasts,
          onDismiss: store.dismiss,
          onPause: store.pause,
          onResume: store.resume,
          onOpen: () => undefined,
        }),
        h(NotificationHistoryDrawer, {
          open: drawerOpen.value,
          records: store.history,
          onClose: () => {
            drawerOpen.value = false;
          },
          onClear: store.clearHistory,
          "onOpen-session": () => undefined,
        }),
      ]);
  },
});

const app = createApp(Harness);
app.use(createPinia());
app.mount("#app");
