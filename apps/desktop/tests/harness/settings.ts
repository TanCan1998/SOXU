/**
 * Issue #116（V4-S2）的 DOM 夹具：把真正的 `SettingsDialog` 与三套设置 composable
 * 挂进浏览器，验证「四页切换 / 主题与强调色实时生效 / 重启后保持 / 键盘可达」。
 *
 * 只在 `pnpm dev` 的本地开发服务器里使用，不参与生产构建，也不连接 Pi：
 * - 偏好的落地与持久化走与 App.vue 完全相同的 composable（useAppearance /
 *   useSessionSettings / useSystemSettings），因此这里测到的行为就是应用里的行为；
 * - 「重启」由 CDP 脚本刷新页面模拟：localStorage 保留，初始值从存储读回；
 * - 主题过渡复用 runThemeTransition，与 App.vue 的 setTheme 同一路径。
 */

import { createApp, h, ref, watch } from "vue";
import { TooltipProvider } from "reka-ui";

import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import SettingsDialog from "../../src/components/SettingsDialog.vue";
import { TOOLTIP_DELAY_MS, TOOLTIP_SKIP_DELAY_MS } from "../../src/components/tooltipConfig.ts";
import { useAppearance } from "../../src/composables/useAppearance.ts";
import { useBusyDelivery } from "../../src/composables/useBusyDelivery.ts";
import { useSessionSettings } from "../../src/composables/useSessionSettings.ts";
import { useSystemSettings } from "../../src/composables/useSystemSettings.ts";
import { useLocale } from "../../src/locales/index.ts";
import { copyText } from "../../src/services/clipboard.ts";
import { dataDirectoryHint } from "../../src/settings/dataDirectory.ts";
import { applyDocumentTheme, persistTheme, type ThemeName } from "../../src/theme/theme.ts";
import { runThemeTransition } from "../../src/theme/themeTransition.ts";

const { appearance, patchAppearance } = useAppearance();
const { session, patchSession } = useSessionSettings();
const { system, patchSystem } = useSystemSettings();
/**
 * 语言切换口（Issue #145）：设置页文案来自语言包，脚本据此验证「切 en-US 后全英文」。
 * persist=false：夹具不应该把语言偏好写进 localStorage，否则「重启后保持」会串味。
 */
const locale = useLocale();
const { busyDelivery, setBusyDelivery } = useBusyDelivery();

/**
 * 起点固定为浅色：headless Edge 的 prefers-color-scheme 是 dark，如果这里走
 * resolveInitialTheme，初始就已是深色，「点深色」会变成空操作，测不出主题切换。
 * 刷新页面后仍然走 resolveInitialTheme，因此「重启后保持」验证的是真实存储路径。
 */
const theme = ref<ThemeName>(window.localStorage.getItem("soxu.theme") === "dark" ? "dark" : "light");
const open = ref(false);
const copyState = ref<"idle" | "copied" | "failed">("idle");
/**
 * 「打开数据目录」的结果回显（Issue #145）。
 *
 * 夹具里不真的调后端命令：脚本要验的是「按钮接到了真实动作、文案跟着结果变」，
 * 真的打开资源管理器属于桌面端实机验收（见 docs/development/evidence/issue-145-product-i18n）。
 */
const openState = ref<"idle" | "opened" | "failed">("idle");
const openDataDirCount = ref(0);
const clearCount = ref(0);
const resetCount = ref(0);
const dataDirectory = dataDirectoryHint("windows");

// 与 App.vue 一致：主题在提交的同一帧写进 <html>，否则过渡快照会拍到旧配色。
watch(
  theme,
  (value) => {
    applyDocumentTheme(value);
  },
  { flush: "sync", immediate: true },
);

// 与 App.vue 一致：只在用户改动时持久化，没选过的用户继续跟随系统偏好。
watch(theme, (value) => {
  persistTheme(value);
});

/** 与 App.vue 的 setTheme 同一路径：没有点击坐标时从视口中心扩散。 */
async function setTheme(next: ThemeName): Promise<void> {
  if (next === theme.value) return;
  await runThemeTransition({
    origin: null,
    commit: () => {
      theme.value = next;
    },
  });
}

async function copyDataDirectory(): Promise<void> {
  copyState.value = (await copyText(dataDirectory)) ? "copied" : "failed";
}

const Harness = {
  render: () =>
    h(
      TooltipProvider,
      { delayDuration: TOOLTIP_DELAY_MS, skipDelayDuration: TOOLTIP_SKIP_DELAY_MS },
      {
        default: () =>
          h("div", { class: "app-shell" }, [
            h("div", { class: "main-column" }, [
              h(
                "button",
                {
                  type: "button",
                  id: "harness-open",
                  class: "link-button",
                  onClick: () => {
                    open.value = true;
                  },
                },
                "打开设置",
              ),
            ]),
            h(SettingsDialog, {
              open: open.value,
              theme: theme.value,
              appearance: appearance.value,
              busyDelivery: busyDelivery.value,
              session: session.value,
              system: system.value,
              info: { appName: "SOXU", appVersion: "0.1.0", platform: "windows" },
              bridgeAvailable: true,
              tauriVersion: "2.12.5",
              dataDirectory,
              copyState: copyState.value,
              openState: openState.value,
              clearBlockedReason: null,
              onClose: () => {
                open.value = false;
              },
              // update:* 事件的 handler 键名是 "onUpdate:<名字>"（Vue 的 toHandlerKey 保留冒号）
              "onUpdate:theme": (value: ThemeName) => void setTheme(value),
              "onUpdate:appearance": (value: typeof appearance.value) => patchAppearance(value),
              "onUpdate:busyDelivery": setBusyDelivery,
              "onUpdate:session": patchSession,
              "onUpdate:system": patchSystem,
              onClearSession: () => {
                clearCount.value += 1;
              },
              onResetLayout: () => {
                resetCount.value += 1;
                patchAppearance({ ...appearance.value, contentWidth: "fixed" });
              },
              onCopyDataDir: () => void copyDataDirectory(),
              onOpenDataDir: () => {
                openDataDirCount.value += 1;
                openState.value = "opened";
              },
            }),
          ]),
      },
    ),
};

createApp(Harness).mount("#app");

/**
 * CDP 脚本的读表口：
 * - open() 打开弹窗；
 * - read() 一次性取回「界面状态 + <html> 属性 + 计算后的强调色 + localStorage」，
 *   用来同时验证「实时生效」与「持久化」两件事。
 */
declare global {
  interface Window {
    __soxu116?: {
      open: () => void;
      setLocale: (tag: string) => void;
      read: () => unknown;
      clearCount: () => number;
      resetCount: () => number;
    };
  }
}

window.__soxu116 = {
  open: () => {
    open.value = true;
  },
  setLocale: (tag: string) => {
    void locale.setLocale(tag, { persist: false });
  },
  clearCount: () => clearCount.value,
  resetCount: () => resetCount.value,
  read: () => ({
    open: open.value,
    theme: theme.value,
    appearance: { ...appearance.value },
    session: { ...session.value },
    system: { ...system.value },
    busyDelivery: busyDelivery.value,
    copyState: copyState.value,
    openState: openState.value,
    openDataDirCount: openDataDirCount.value,
    dataset: { ...document.documentElement.dataset },
    accent: getComputedStyle(document.documentElement).getPropertyValue("--soxu-accent").trim(),
    /*
     * 复审教训（Issue #116）：只读 <html> 上的 --soxu-accent 会漏掉「深色下 app-shell
     * 子树仍是蓝色」的两套色问题——深色 token 同时挂在 :root 与 .app-shell 两个选择器上，
     * 只量 documentElement 看不出后者覆盖了色板。这里补上 app-shell 子树内的实测值。
     */
    accentInShell: (() => {
      const shell = document.querySelector(".app-shell");
      return shell ? getComputedStyle(shell).getPropertyValue("--soxu-accent").trim() : null;
    })(),
    accentSoftInShell: (() => {
      const shell = document.querySelector(".app-shell");
      return shell ? getComputedStyle(shell).getPropertyValue("--soxu-accent-soft").trim() : null;
    })(),
    onAccentInShell: (() => {
      const shell = document.querySelector(".app-shell");
      return shell ? getComputedStyle(shell).getPropertyValue("--soxu-on-accent").trim() : null;
    })(),
    accentSoft: getComputedStyle(document.documentElement)
      .getPropertyValue("--soxu-accent-soft")
      .trim(),
    /*
     * 组件级证据：选中 tab 的下划线真的取到了色板色（不是只有变量变了）。
     * 这条能抓住「变量对了但组件引用的是另一套 token」的漏改。
     */
    activeTabBorder: (() => {
      const tab = document.querySelector('[role="tab"][data-state="active"]');
      return tab ? getComputedStyle(tab).borderBottomColor : null;
    })(),
    contentMax: getComputedStyle(document.documentElement)
      .getPropertyValue("--soxu-content-max")
      .trim(),
    fontMono: getComputedStyle(document.documentElement)
      .getPropertyValue("--soxu-font-family-mono")
      .trim(),
    dialogBg: (() => {
      const dialog = document.querySelector('[role="dialog"]');
      return dialog ? getComputedStyle(dialog).backgroundColor : null;
    })(),
    storage: {
      appearance: localStorage.getItem("soxu.appearance"),
      session: localStorage.getItem("soxu.session"),
      system: localStorage.getItem("soxu.system"),
      theme: localStorage.getItem("soxu.theme"),
    },
  }),
};
