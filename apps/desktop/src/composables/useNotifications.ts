/**
 * 通知接线（V4-S2b，Issue #117）。
 *
 * 把 workspace 的运行时事件流接到通知 store 上。**不新增订阅通道**：
 * `WorkspaceSession` 已经按 `runtimeId + generation` 过滤过一次事件，
 * 通知层复用同一个 gate（迟到事件同样不会弹出通知）。
 *
 * 所有权：订阅函数与 store 的定时器/AudioContext 都在同一个作用域里创建，
 * 也在同一个作用域销毁（`onScopeDispose`），组件卸载后不会再有通知写进已销毁的状态。
 */

import { computed, onScopeDispose, type ComputedRef } from "vue";

import type { ToastItem } from "../notifications/toast.ts";
import { useNotificationStore } from "../stores/notifications.ts";
import { useWorkspaceStore } from "../stores/workspace.ts";

export interface NotificationsControls {
  /** 通知 store 本身（设置页/铃铛/抽屉都从它读）。 */
  notifications: ReturnType<typeof useNotificationStore>;
  /** 右下角当前可见的 toast（最多 4 条）。 */
  visibleToasts: ComputedRef<ToastItem[]>;
  unreadCount: ComputedRef<number>;
}

export function useNotifications(): NotificationsControls {
  const notifications = useNotificationStore();
  const workspace = useWorkspaceStore();

  const stop = workspace.onRuntimeEvent((event, tab, context) => {
    notifications.handleRuntimeEvent(event, tab, context);
  });

  onScopeDispose(() => {
    stop();
    notifications.dispose();
  });

  return {
    notifications,
    visibleToasts: computed(() => notifications.visibleToasts),
    unreadCount: computed(() => notifications.unreadCount),
  };
}
