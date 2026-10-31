/**
 * Issue #147 的 DOM 夹具：把真正的 SettingsExtensions 挂进浏览器。
 *
 * 数据来源由走查脚本通过 CDP 注入（window.__SOXU_EXTENSION_FIXTURE__），
 * 内容是**真实 Rust 扫描结果**（examples/scan-agent-dir.rs 的输出）：
 * 因此截图里看到的就是本机 ~/.pi/agent 的实际内容，而不是手写的假数据。
 *
 * 走查脚本注入的 Tauri 桥接替身只替换传输层：
 * 组件、composable、services/extensions.ts 全走生产代码路径。
 *
 * 没有注入（普通浏览器预览）时保持默认行为：桥接显式失败，页面显示读取失败与原因。
 */

import { createApp, h } from "vue";
import { TooltipProvider } from "reka-ui";

import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import SettingsExtensions from "../../src/components/settings/SettingsExtensions.vue";
import { useLocale } from "../../src/locales/index.ts";

const params = new URLSearchParams(window.location.search);
const mode = params.get("mode") ?? "ready";
const localeTag = params.get("locale") ?? "zh-CN";

const fixture = window.__SOXU_EXTENSION_FIXTURE__ ?? null;

/** 桌面端才有 Tauri 桥：这里按真实桌面运行时模拟它，好让组件走生产分支。 */
function installBridge() {
  const internals = {
    invoke: async (command, args) => {
      if (command === "list_extensions") {
        if (mode === "error") {
          throw new Error(
            fixture?.error ??
              "读不到 Pi 的配置目录 C:\\Users\\tanca\\.pi\\agent（系统找不到指定的路径）",
          );
        }
        if (mode === "loading") return new Promise(() => {});
        if (mode === "empty") {
          return { agentDir: "C:\\Users\\tanca\\.pi\\agent", extensions: [], skills: [], mcpServers: [] };
        }
        return fixture.catalog;
      }
      if (command === "read_extension_detail") {
        const detail = fixture?.details?.[args?.id];
        if (!detail) throw new Error("找不到 id 为「" + String(args?.id) + "」的扩展或技能");
        return detail;
      }
      // 语言包区与扩展页同屏：给它一份空目录，免得整块显示成失败态。
      if (command === "list_locale_packs") {
        return { directory: "C:\\Users\\tanca\\AppData\\Roaming\\dev.soxu.desktop\\locales", tags: [] };
      }
      throw new Error("夹具没有模拟这条命令：" + command);
    },
  };
  window.__TAURI_INTERNALS__ = internals;
}

installBridge();

const app = createApp({
  render: () => h(TooltipProvider, null, { default: () => h(SettingsExtensions) }),
});

await useLocale().setLocale(localeTag, { persist: false });
app.mount("#app");
