/**
 * Issue #123 的 DOM 夹具：把真正的 CommandPalette 与真正的命令注册表挂到浏览器里，
 * 用来验证「输入 dk → ↑↓ 选择 → ↵ 执行」这条纯键盘路径在真实 DOM 里成立。
 *
 * 只在 pnpm dev 的本地开发服务器里使用，不参与生产构建，也不连接 Pi：
 * - 命令清单就是生产代码里的 COMMANDS（含由 settings/catalog.ts 生成的设置类命令）；
 * - 动作实现只往 actionLog 里记一行，不打开真实面板、不写存储；
 * - 面板的开关、执行后关闭都与 App.vue 的 runCommand 同语义。
 */

import { createApp, h, nextTick, ref } from "vue";
import { TooltipProvider } from "reka-ui";

import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import CommandPalette from "../../src/components/CommandPalette.vue";
import SettingsDialog from "../../src/components/SettingsDialog.vue";
import { TOOLTIP_DELAY_MS, TOOLTIP_SKIP_DELAY_MS } from "../../src/components/tooltipConfig.ts";
import { COMMANDS, commandContext, type CommandActions, type CommandEntry } from "../../src/commands/registry.ts";
import { DEFAULT_BUSY_DELIVERY } from "../../src/settings/busyDelivery.ts";
import type { SettingsTabId } from "../../src/settings/catalog.ts";
import { DEFAULT_SESSION_SETTINGS } from "../../src/settings/sessionSettings.ts";
import { DEFAULT_SYSTEM_SETTINGS } from "../../src/settings/systemSettings.ts";
import { DEFAULT_APPEARANCE } from "../../src/theme/appearance.ts";

const paletteOpen = ref(true);
const executed: string[] = [];
const actionLog: string[] = [];

/**
 * 设置弹窗的真实挂载状态（Issue #123 复审阻塞点 A 的证据来源）。
 *
 * 这里刻意复刻 App.vue 的接线，而不是另写一套：
 * - `settingsTab` 是这次请求的目标页（null = 沿用上次看的那页）；
 * - `settingsRequest` 每次打开都 +1，因此「设置已经开着时再请求一次」也能被弹窗识别；
 * - 弹窗**始终挂载**（只是 open=false 时不渲染内容），与 App.vue 的模板一致——
 *   改成 v-if 会让首次打开的 watch 收不到 false→true 变化，量到的就不是生产行为了。
 */
const settingsOpen = ref(false);
const settingsTab = ref<SettingsTabId | null>(null);
const settingsRequest = ref(0);
/** 每次「打开设置」请求的落地记录：目标页 + 当时的请求序号。 */
const settingsLog: { tab: SettingsTabId | null; request: number }[] = [];

/** 记录型动作：每条都对应注册表里的真实方法名，断言「按 ↵ 真的执行了」。 */
const actions: CommandActions = {
  openSettings: (tab) => {
    actionLog.push("openSettings:" + (tab ?? "last"));
    // 与 App.vue 的 openSettings 同语义：先收起面板，再记目标页、开弹窗、递增请求序号。
    paletteOpen.value = false;
    settingsTab.value = tab;
    settingsOpen.value = true;
    settingsRequest.value += 1;
    settingsLog.push({ tab, request: settingsRequest.value });
  },
  openSearch: () => actionLog.push("openSearch"),
  toggleSidebar: () => actionLog.push("toggleSidebar"),
  toggleInspector: () => actionLog.push("toggleInspector"),
  toggleGit: () => actionLog.push("toggleGit"),
  openNotifications: () => actionLog.push("openNotifications"),
  openWorktrees: () => actionLog.push("openWorktrees"),
  newTemporarySession: () => actionLog.push("newTemporarySession"),
  closeActiveSession: () => actionLog.push("closeActiveSession"),
  reopenActiveSession: () => actionLog.push("reopenActiveSession"),
  toggleTheme: () => actionLog.push("toggleTheme"),
  copyDataDirectory: () => actionLog.push("copyDataDirectory"),
};

const context = commandContext({ hasActiveSession: true, hasProject: true });

/** 与 App.vue 的 runCommand 同语义：先收起面板，再执行。 */
function onRun(command: CommandEntry): void {
  executed.push(command.id);
  paletteOpen.value = false;
  command.run(actions);
}

/**
 * 夹具根节点。
 *
 * TooltipProvider 与 main.ts 一致地包住整棵树：设置弹窗里的 AppTooltip 要求它是祖先，
 * 少了这一层 Reka UI 会直接抛错——那也是「面板关不掉」的真实原因，不是面板本身的问题。
 */
const Harness = {
  render: () =>
    h(
      TooltipProvider,
      { delayDuration: TOOLTIP_DELAY_MS, skipDelayDuration: TOOLTIP_SKIP_DELAY_MS },
      {
        default: () =>
          h("div", { class: "app-shell" }, [
            // 触发按钮：验证「关闭后焦点还给触发元素」。它必须一直在文档里，
            // 否则卸载面板时还原焦点只能落到 <body>，那条断言就成了假绿。
            h("button", { id: "harness-trigger", type: "button" }, "打开命令面板"),
            paletteOpen.value
              ? h(CommandPalette, {
                  commands: COMMANDS,
                  context,
                  onClose: () => {
                    paletteOpen.value = false;
                  },
                  onRun,
                })
              : h("p", { class: "harness-closed" }, "面板已关闭"),
            // 设置弹窗：与 App.vue 同样的 props 形状（open / initialTab / request 三件套）。
            h(SettingsDialog, {
              open: settingsOpen.value,
              theme: "light",
              appearance: DEFAULT_APPEARANCE,
              busyDelivery: DEFAULT_BUSY_DELIVERY,
              session: DEFAULT_SESSION_SETTINGS,
              system: DEFAULT_SYSTEM_SETTINGS,
              info: null,
              bridgeAvailable: false,
              tauriVersion: null,
              dataDirectory: "C:\\Users\\fixture\\AppData\\Roaming\\soxu.desktop",
              copyState: "idle",
              clearBlockedReason: null,
              initialTab: settingsTab.value,
              request: settingsRequest.value,
              onClose: () => {
                settingsOpen.value = false;
              },
            }),
          ]),
      },
    ),
};

createApp(Harness).mount("#app");

/** 面板状态一律从 DOM 读：脚本验证的是渲染结果，不是内部变量。 */
function readState() {
  const input = document.querySelector<HTMLInputElement>(".cp-input");
  const items = Array.from(document.querySelectorAll<HTMLElement>(".cp-item"));
  return {
    open: document.querySelector(".palette") !== null,
    query: input?.value ?? "",
    count: document.querySelector(".cp-meta")?.textContent?.trim() ?? "",
    rows: items.map((item) => ({
      title: item.querySelector(".cp-title")?.textContent?.trim() ?? "",
      hint: item.querySelector(".cp-hint")?.textContent?.trim() ?? null,
      group: item.querySelector(".cp-group")?.textContent?.trim() ?? null,
      active: item.dataset.active === "true",
      disabled: item.getAttribute("aria-disabled") === "true",
      marks: Array.from(item.querySelectorAll(".cp-mark")).map((mark) => mark.textContent ?? ""),
    })),
    footer: (document.querySelector(".cp-footer")?.textContent ?? "").replace(/\s+/g, " ").trim(),
    activeDescendant: input?.getAttribute("aria-activedescendant") ?? null,
    notice: document.querySelector(".cp-notice")?.textContent?.trim() ?? null,
    focused: document.activeElement?.className ?? null,
    // 拼音字典是动态加载的：脚本要等它到位再输入 dk，否则量到的是「还没加载完」的空结果。
    pinyin: document.querySelector(".palette")?.getAttribute("data-pinyin") ?? null,
  };
}

declare global {
  interface Window {
    __soxuPalette: {
      state: () => ReturnType<typeof readState>;
      /** 生产注册表里的全部标题，脚本据此算出「应该有哪几条被 dk 命中」。 */
      commands: () => string[];
      executed: () => { ids: string[]; actions: string[] };
      reopen: () => void;
      /** 从触发按钮打开：用来断言关闭后焦点回到触发元素。 */
      openFromTrigger: () => void;
      /** 当前焦点在哪，以及是否还在面板内（Tab 圈定的判据）。 */
      focusInfo: () => { id: string; className: string; insidePalette: boolean };
      /**
       * 设置弹窗的真实状态（复审阻塞点 A）：从 DOM 读当前激活的标签页，
       * 而不是读组件内部变量——这样「界面真的换了页」才算数。
       */
      settings: () => {
        open: boolean;
        activeTab: string | null;
        request: number;
        log: { tab: string | null; request: number }[];
        tabs: string[];
      };
      /** 收起设置弹窗：让后续截图只包含命令面板。 */
      closeSettings: () => void;
      setTheme: (theme: "light" | "dark") => void;
      overlayBackground: () => string;
      panelBackground: () => string;
    };
  }
}

window.__soxuPalette = {
  state: readState,
  commands: () => COMMANDS.map((command) => command.title),
  executed: () => ({ ids: [...executed], actions: [...actionLog] }),
  /**
   * 关掉再挂一次：面板是 v-if 挂上去的，query 存在组件内部，
   * 只把 paletteOpen 置回 true 对「已经开着」的情况是空操作，输入框里会留着上一次的查询。
   */
  reopen: () => {
    paletteOpen.value = false;
    void nextTick(() => {
      paletteOpen.value = true;
    });
  },
  openFromTrigger: () => {
    // 顺序要紧：先把焦点放到触发按钮，再挂面板——面板在 onMounted 里记录焦点来源。
    paletteOpen.value = false;
    void nextTick(() => {
      document.querySelector<HTMLElement>("#harness-trigger")?.focus();
      paletteOpen.value = true;
    });
  },
  focusInfo: () => {
    const active = document.activeElement as HTMLElement | null;
    const panel = document.querySelector(".palette");
    return {
      id: active?.id ?? "",
      className: active?.className ?? "",
      insidePalette: panel !== null && active !== null && panel.contains(active),
    };
  },
  settings: () => {
    const tabs = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]'));
    const active = tabs.find(
      (element) =>
        element.dataset.state === "active" || element.getAttribute("aria-selected") === "true",
    );
    return {
      open: document.querySelector('[aria-labelledby="soxu-settings-title"]') !== null,
      activeTab: active?.textContent?.trim() ?? null,
      request: settingsRequest.value,
      log: settingsLog.map((entry) => ({ tab: entry.tab, request: entry.request })),
      tabs: tabs.map((element) => element.textContent?.trim() ?? ""),
    };
  },
  closeSettings: () => {
    settingsOpen.value = false;
  },
  setTheme: (theme: "light" | "dark") => {
    document.documentElement.dataset.theme = theme;
    const shell = document.querySelector<HTMLElement>(".app-shell");
    if (shell) shell.dataset.theme = theme;
  },
  overlayBackground: () => {
    const overlay = document.querySelector(".overlay");
    return overlay ? getComputedStyle(overlay).backgroundColor : "";
  },
  panelBackground: () => {
    const panel = document.querySelector(".palette");
    return panel ? getComputedStyle(panel).backgroundColor : "";
  },
};
