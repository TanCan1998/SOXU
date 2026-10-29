/**
 * Issue #99 的 DOM 夹具：把真正的 `SessionTabs` 挂到浏览器里，
 * 用 1 / 3 / 8 个确定性 Tab 验证「等宽 + 上下限 + 横向滚动 + 拖拽排序」。
 *
 * 只在 `pnpm dev` 的本地开发服务器里使用，不参与生产构建，也不连接 Pi：
 * Tab 全是内存里的假数据，排序写回走的是组件对外暴露的 `move` 事件
 * （生产环境里由 `WorkspaceSession.moveTab` 承担同一职责）。
 */

import { createApp, h, ref } from "vue";
import { TooltipProvider } from "reka-ui";
// 与桌面端一致的基础 token / 动效 / reduced-motion 规则，由 Vite 注入。
import "../../src/styles/base.css";
import SessionTabs from "../../src/components/SessionTabs.vue";
import { TOOLTIP_DELAY_MS, TOOLTIP_SKIP_DELAY_MS } from "../../src/components/tooltipConfig.ts";
import type { SessionTab } from "../../src/workspace/types.ts";

const TITLES = [
  "修复会话恢复时的重复事件",
  "分析长会话内存占用",
  "整理 Issue 99 验收证据",
  "顶栏后退前进的历史边界",
  "工作树隔离与检查点",
  "Pi RPC 超时重试预算",
  "临时会话转正流程",
  "虚拟列表滚动定位",
];

function makeTab(index: number): SessionTab {
  return {
    sessionId: `harness_ses_${index}`,
    projectId: "harness_prj",
    worktreeId: null,
    title: TITLES[index % TITLES.length] ?? `会话 ${index}`,
    // 第 3 个用临时会话，顺带验证「临时」标签在等宽布局里不被挤掉。
    mode: index === 2 ? "temporary" : "persistent",
    status: index === 1 ? "running" : "ready",
    error: null,
    messages: [],
    history: { loaded: 0, total: 0, next: null, loading: false, evicted: 0, evictedLive: 0 },
    runtime: { runtimeId: null, generation: 0, state: "idle", exitReason: null, retry: null },
    draft: "",
    diagnostics: [],
    promoting: false,
  };
}

const params = new URLSearchParams(location.search);
const requested = Number.parseInt(params.get("count") ?? "3", 10);
const count = Math.min(Math.max(Number.isFinite(requested) ? requested : 3, 1), TITLES.length);

const tabs = ref<SessionTab[]>(Array.from({ length: count }, (_, index) => makeTab(index)));
const activeSessionId = ref<string | null>(tabs.value[0]?.sessionId ?? null);

function move(fromIndex: number, toIndex: number) {
  const next = tabs.value.slice();
  const [moved] = next.splice(fromIndex, 1);
  if (!moved) return;
  next.splice(toIndex, 0, moved);
  tabs.value = next;
}

/** 与 main.ts 一致：AppTooltip 必须处在 TooltipProvider 之内，否则 Reka UI 直接抛错。 */
const Harness = {
  render: () =>
    h(
      TooltipProvider,
      { delayDuration: TOOLTIP_DELAY_MS, skipDelayDuration: TOOLTIP_SKIP_DELAY_MS },
      {
        default: () =>
          h(SessionTabs, {
            tabs: tabs.value,
            activeSessionId: activeSessionId.value,
            onSelect: (sessionId: string) => {
              activeSessionId.value = sessionId;
            },
            onClose: (sessionId: string) => {
              tabs.value = tabs.value.filter((tab) => tab.sessionId !== sessionId);
              if (activeSessionId.value === sessionId) {
                activeSessionId.value = tabs.value[0]?.sessionId ?? null;
              }
            },
            onNewTemporary: () => {
              const tab = makeTab(tabs.value.length);
              tab.sessionId = `harness_ses_tmp_${Date.now()}`;
              tab.mode = "temporary";
              tabs.value = [...tabs.value, tab];
              activeSessionId.value = tab.sessionId;
            },
            onMove: (fromIndex: number, toIndex: number) => move(fromIndex, toIndex),
          }),
      },
    ),
};

createApp(Harness).mount("#app");

/** 供 CDP 脚本读取的观察点：顺序、选中项、被关闭的会话。 */
declare global {
  interface Window {
    __soxuTabs: {
      order: () => string[];
      active: () => string | null;
      count: () => number;
    };
  }
}

window.__soxuTabs = {
  order: () => tabs.value.map((tab) => tab.sessionId),
  active: () => activeSessionId.value,
  count: () => tabs.value.length,
};
