import { createApp, h } from "vue";
import { createPinia } from "pinia";
import { TooltipProvider } from "reka-ui";
import App from "./App.vue";
// V4 设计 token 必须先于 base.css：tokens.css 只做声明（变量 + @theme），不写任何选择器样式，
// 先加载它就等于「先备好变量，再由 base.css 消费」，顺序反过来会让首帧拿不到 --soxu-* 之外的变量。
import "./styles/tokens.css";
import "./styles/base.css";
import { TOOLTIP_DELAY_MS, TOOLTIP_SKIP_DELAY_MS } from "./components/tooltipConfig.ts";
import { applyDocumentAppearance, resolveInitialAppearance } from "./theme/appearance.ts";
import { applyDocumentTheme, resolveInitialTheme, syncWindowTheme } from "./theme/theme.ts";
import { currentWindowTarget } from "./theme/windowTheme.ts";
import { startLocale } from "./locales/bootstrap.ts";

// 挂载前先落地主题：<html data-theme> 决定 :root token 与 color-scheme，
// 原生窗口标题栏也在这一刻同步，避免深色主题启动时先出现一帧浅色顶部。
const initialTheme = resolveInitialTheme();
applyDocumentTheme(initialTheme);
void syncWindowTheme(initialTheme, currentWindowTarget());

// 外观（字号 / 界面字体 / 代码字体 / 正文宽度 / 强调色）同样在挂载前落地：
// <html data-font-size data-font-family data-code-font data-content-width data-accent>
// 决定 rem 基准、字体栈与强调色 token，晚一帧就等于先按基准值排一遍再重排，能看见跳动。
applyDocumentAppearance(resolveInitialAppearance());

/**
 * 界面语言（Issue #135）：内置语言在 locales/index.ts 加载时就已生效，
 * 这里只异步补读「上次选的社区语言包」。放在挂载前调用但不 await：
 * 首帧用内置语言渲染，社区包读回来后再替换文案，不阻塞启动。
 */
void startLocale();

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
