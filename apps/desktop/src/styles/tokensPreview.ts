/**
 * V4 设计 token 色板（Issue #110 的临时验证入口，仅 `pnpm dev` 使用）。
 *
 * 为什么单独开一个 HTML 入口而不是往 App.vue 里塞色板：
 * 本切片的验收明确要求「现有组件（App.vue 等 10 个）不改」，而验证又必须真的看到
 * 深浅色切换。把色板做成独立页面，两边都不违反：组件保持原样，色板照样跑真实的
 * 主题切换链路（theme.ts + themeTransition.ts，与 App.vue 调的是同一套函数）。
 *
 * 主题初始值同样在挂载前落地：晚一帧就会先按浅色画一遍再跳成深色。
 */

import { createApp } from "vue";

// token 先于 base.css，与 main.ts 的顺序保持一致
import "./tokens.css";
import "./base.css";
import TokensPreview from "./TokensPreview.vue";
import { applyDocumentTheme, resolveInitialTheme } from "../theme/theme.ts";

const initialTheme = resolveInitialTheme();
applyDocumentTheme(initialTheme);

createApp(TokensPreview, { initialTheme }).mount("#tokens");
