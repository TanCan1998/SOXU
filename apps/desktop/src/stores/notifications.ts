/**
 * Pinia 域 store：通知（V4-S2b，Issue #117）。
 *
 * 这是本切片唯一的「通知中枢」：设置、Toast 队列、声音、历史都在这里，
 * 组件只读状态、派发动作；判定规则在 `notifications/` 下的纯函数里。
 *
 * 三条所有权规则（对应根 AGENTS.md 的「单一 owner」）：
 * 1. 每个 toast 的淡出/过期定时器都由这里创建，也只由这里清理；
 * 2. 焦点监听器与 AudioContext 在 `dispose()` 里一起释放；
 * 3. 设置只在用户改动时写 localStorage，启动不把默认值当成用户偏好写进去。
 *
 * 事件来源是现有会话事件流：`useNotifications` 把 workspace store 的
 * `onRuntimeEvent` 接到 `handleRuntimeEvent`，不新增后端 command。
 */

import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";

import {
  classifyRuntimeEvent,
  type ClassifyOptions,
  type NotificationEvent,
} from "../notifications/events.ts";
import { browserFocusTarget, isWindowFocused, watchWindowFocus } from "../notifications/focus.ts";
import { appendNotification, type NotificationRecord } from "../notifications/history.ts";
import {
  NOTIFICATION_EVENT_META,
  clampVolume,
  isSystemNotificationEnabled,
  normalizeNotificationSettings,
  persistNotificationSettings,
  readNotificationSettings,
  resolveToastDuration,
  shouldPlaySound,
  type NotificationEventKind,
  type NotificationSettings,
  type SoundId,
  type ToastDuration,
} from "../notifications/settings.ts";
import { createSoundPlayer } from "../notifications/sounds.ts";
import {
  MAX_VISIBLE_TOASTS,
  TOAST_FADE_LEAD_MS,
  createToast,
  findActiveByDedupeKey,
  queuedCount as countQueued,
  remainingMs,
  visibleToasts as pickVisible,
  type ToastItem,
} from "../notifications/toast.ts";
import type { RuntimeEvent, SessionTab } from "../workspace/types.ts";

type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * 单条 toast 的计时状态。
 *
 * `remaining === null` 表示常驻：不建任何定时器，只能手动关。
 * 暂停时把已消耗的时间折算掉写回 `remaining`，恢复时按剩余时长重新计时——
 * 这样「悬停暂停」不会因为反复进出而让倒计时变长或变短。
 */
interface ToastTiming {
  remaining: number | null;
  startedAt: number;
  fade?: TimerHandle;
  expire?: TimerHandle;
}

/** Node 的 Timeout 有 unref；不解除引用会让测试进程等满整个展示时长才退出。 */
function unrefTimer(timer: TimerHandle): void {
  const candidate = timer as unknown as { unref?: () => void };
  if (typeof candidate.unref === "function") candidate.unref();
}

export interface NotifyOptions {
  /** 调用方建议的展示时长；只有错误类会采纳（见 `resolveToastDuration`）。 */
  requestedDurationMs?: number | null;
  /** 时间戳注入点：测试用固定值断言历史时间。 */
  atMs?: number;
}

export const useNotificationStore = defineStore("notifications", () => {
  const settings = ref<NotificationSettings>(readNotificationSettings());
  const toasts = ref<ToastItem[]>([]);
  const history = ref<NotificationRecord[]>([]);
  /** 未读计数：抽屉打开时清零，铃铛上的红点用它。 */
  const unreadCount = ref(0);

  const focusTarget = browserFocusTarget();
  const windowFocused = ref(isWindowFocused(focusTarget));
  const focusWatcher = watchWindowFocus((value) => {
    windowFocused.value = value;
  }, focusTarget);

  const player = createSoundPlayer();
  const timings = new Map<string, ToastTiming>();
  let sequence = 0;
  let disposed = false;

  // deep：设置页/其他切片可能直接改嵌套字段（例如只改某个事件的音效），
  // 浅监听会漏掉这类改动，导致「改了但没持久化」。启动时没有改动，因此不会写存储。
  watch(settings, (value) => {
    persistNotificationSettings(value);
  }, { deep: true });

  const visibleToasts = computed(() => pickVisible(toasts.value, MAX_VISIBLE_TOASTS));
  const queuedToasts = computed(() => countQueued(toasts.value, MAX_VISIBLE_TOASTS));

  function clearTimers(timing: ToastTiming): void {
    if (timing.fade !== undefined) clearTimeout(timing.fade);
    if (timing.expire !== undefined) clearTimeout(timing.expire);
    timing.fade = undefined;
    timing.expire = undefined;
  }

  function setFading(id: string, value: boolean): void {
    const toast = toasts.value.find((item) => item.id === id);
    if (!toast || toast.fading === value) return;
    toast.fading = value;
  }

  function arm(id: string): void {
    const timing = timings.get(id);
    if (!timing || timing.remaining === null) return;
    const total = timing.remaining;
    timing.startedAt = Date.now();
    const fadeIn = total - TOAST_FADE_LEAD_MS;
    if (fadeIn > 0) {
      const fade = setTimeout(() => {
        setFading(id, true);
      }, fadeIn);
      unrefTimer(fade);
      timing.fade = fade;
    }
    const expire = setTimeout(() => {
      dismiss(id);
    }, total);
    unrefTimer(expire);
    timing.expire = expire;
  }

  function schedule(id: string, durationMs: number | null): void {
    const timing: ToastTiming = { remaining: durationMs, startedAt: Date.now() };
    timings.set(id, timing);
    if (durationMs === null) return;
    if (durationMs <= 0) {
      dismiss(id);
      return;
    }
    arm(id);
  }

  /** 关闭一条通知（手动关闭与到期自动关闭走同一条路径）。 */
  function dismiss(id: string): void {
    const timing = timings.get(id);
    if (timing) clearTimers(timing);
    timings.delete(id);
    toasts.value = toasts.value.filter((item) => item.id !== id);
  }

  /** 悬停/聚焦时暂停倒计时：toast 仍在，只是不再走向消失。 */
  function pause(id: string): void {
    const timing = timings.get(id);
    if (!timing || timing.remaining === null) return;
    if (timing.expire === undefined && timing.fade === undefined) return;
    timing.remaining = remainingMs(timing.remaining, Date.now() - timing.startedAt);
    clearTimers(timing);
    setFading(id, false);
  }

  /** 指针离开后按剩余时长继续；剩余已归零则立刻关闭。 */
  function resume(id: string): void {
    const timing = timings.get(id);
    if (!timing || timing.remaining === null) return;
    if (timing.expire !== undefined || timing.fade !== undefined) return;
    if (timing.remaining <= 0) {
      dismiss(id);
      return;
    }
    arm(id);
  }

  /**
   * 推出一条通知。
   *
   * 事件开关关闭时**什么都不做**：不弹窗、不记历史、不发声。
   * 这样「三类事件分别可开关」对三个可见面都成立，不会出现
   * 「弹窗关了但历史里还一直长」的半开状态。
   */
  function notify(event: NotificationEvent, options: NotifyOptions = {}): ToastItem | null {
    if (disposed) return null;
    const config = settings.value;
    if (!config.events[event.kind].enabled) return null;
    if (event.dedupeKey) {
      const existing = findActiveByDedupeKey(toasts.value, event.dedupeKey);
      // 同一次交互请求会产生多条记录：已有一条未消失的，就不再重复提醒。
      if (existing) return existing;
    }
    const durationMs = resolveToastDuration(event.kind, config, options.requestedDurationMs ?? null);
    const toast = createToast(event, durationMs, `ntf_${(++sequence).toString(36)}`);
    toasts.value = [...toasts.value, toast];
    history.value = appendNotification(history.value, {
      id: toast.id,
      kind: toast.kind,
      severity: toast.severity,
      title: toast.title,
      body: toast.body,
      sessionId: toast.sessionId,
      atMs: options.atMs ?? Date.now(),
      actionLabel: toast.actionLabel,
    });
    unreadCount.value += 1;
    schedule(toast.id, durationMs);
    if (shouldPlaySound(event.kind, config, windowFocused.value)) {
      player.play(config.events[event.kind].sound, config.volume);
    }
    return toast;
  }

  /**
   * 处理一条运行时事件。
   *
   * 调用方必须已经按 `runtimeId + generation` 过滤过（`WorkspaceSession.handleEvent`
   * 在 gate 之后才通知观察者），因此这里不再重复判断迟到。
   *
   * `systemSettings` 是设置 → 系统 → 任务完成通知（Issue #145）：它是通知层之外
   * 的另一道总闸，关闭后完成/出错不提醒（等待输入照旧）。默认打开，
   * 因此不传这个参数的调用方行为不变。
   */
  function handleRuntimeEvent(
    event: RuntimeEvent,
    tab?: Pick<SessionTab, "title"> | null,
    context: Pick<ClassifyOptions, "previousStatus"> = {},
    systemSettings: { notifyOnComplete: boolean } = { notifyOnComplete: true },
  ): ToastItem | null {
    const notification = classifyRuntimeEvent(event, {
      title: tab?.title ?? null,
      previousStatus: context.previousStatus,
    });
    if (!notification) return null;
    if (!isSystemNotificationEnabled(notification.kind, systemSettings)) return null;
    return notify(notification);
  }

  function clearHistory(): void {
    history.value = [];
    unreadCount.value = 0;
  }

  function markAllRead(): void {
    unreadCount.value = 0;
  }

  function setDuration(value: ToastDuration): void {
    settings.value = { ...settings.value, duration: value };
  }

  function setOnlyWhenUnfocused(value: boolean): void {
    settings.value = { ...settings.value, onlyWhenUnfocused: value };
  }

  function setSoundEnabled(value: boolean): void {
    settings.value = { ...settings.value, soundEnabled: value };
  }

  function setVolume(value: number): void {
    settings.value = { ...settings.value, volume: clampVolume(value) };
  }

  function setEventEnabled(kind: NotificationEventKind, enabled: boolean): void {
    const current = settings.value;
    settings.value = {
      ...current,
      events: { ...current.events, [kind]: { ...current.events[kind], enabled } },
    };
  }

  function setEventSound(kind: NotificationEventKind, sound: SoundId): void {
    const current = settings.value;
    settings.value = {
      ...current,
      events: { ...current.events, [kind]: { ...current.events[kind], sound } },
    };
  }

  /**
   * 试听当前音效。
   *
   * 这是用户的显式动作，所以不受「仅失焦提醒」与事件开关影响，
   * 但仍然使用当前音量——试听的意义就是听到真实音量。
   */
  function previewSound(kind: NotificationEventKind = "sessionCompleted"): boolean {
    if (disposed) return false;
    const config = settings.value;
    return player.play(config.events[kind].sound, config.volume);
  }

  /** 恢复默认设置（设置页的「恢复默认」按钮用；不影响已显示的通知与历史）。 */
  function resetSettings(): void {
    settings.value = normalizeNotificationSettings(null);
  }

  /** 组件卸载：先清定时器，再释放焦点监听与 AudioContext；之后不再产生任何通知。 */
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const timing of timings.values()) clearTimers(timing);
    timings.clear();
    focusWatcher.stop();
    player.dispose();
    toasts.value = [];
  }

  return {
    // 状态
    settings,
    toasts,
    visibleToasts,
    queuedToasts,
    history,
    unreadCount,
    windowFocused,
    maxVisibleToasts: MAX_VISIBLE_TOASTS,
    eventMeta: NOTIFICATION_EVENT_META,
    // 动作
    notify,
    handleRuntimeEvent,
    dismiss,
    pause,
    resume,
    clearHistory,
    markAllRead,
    setDuration,
    setOnlyWhenUnfocused,
    setSoundEnabled,
    setVolume,
    setEventEnabled,
    setEventSound,
    previewSound,
    resetSettings,
    dispose,
  };
});
