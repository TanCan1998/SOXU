import { createApp, h } from "vue";
import { createPinia } from "pinia";
import { TooltipProvider } from "reka-ui";
import App from "./App.vue";
import "./styles/base.css";
import { TOOLTIP_DELAY_MS, TOOLTIP_SKIP_DELAY_MS } from "./components/tooltipConfig.ts";
import { applyDocumentAppearance, resolveInitialAppearance } from "./theme/appearance.ts";
import { applyDocumentTheme, resolveInitialTheme, syncWindowTheme } from "./theme/theme.ts";
import { currentWindowTarget } from "./theme/windowTheme.ts";

// 挂载前先落地主题：<html data-theme> 决定 :root token 与 color-scheme，
// 原生窗口标题栏也在这一刻同步，避免深色主题启动时先出现一帧浅色顶部。
const initialTheme = resolveInitialTheme();
applyDocumentTheme(initialTheme);
void syncWindowTheme(initialTheme, currentWindowTarget());

// 外观（字号 / 字体族）同样在挂载前落地：<html data-font-size data-font-family>
// 决定 rem 基准与字体栈 token，晚一帧就等于先按基准字号排一遍再重排，能看见文字跳动。
applyDocumentAppearance(resolveInitialAppearance());

/**
 * TooltipProvider 必须包住整棵树：所有 AppTooltip 都要求它是祖先，
 * 否则 Reka UI 会抛「must be used within TooltipProvider」。
 * 延迟与「相邻按钮免等待」只在这里配置一次，不在每个调用点重复。
 */
createApp({
  render: () =>
    h(
      TooltipProvider,
      { delayDuration: TOOLTIP_DELAY_MS, skipDelayDuration: TOOLTIP_SKIP_DELAY_MS },
      { default: () => h(App) },
    ),
})
  .use(createPinia())
  .mount("#app");
