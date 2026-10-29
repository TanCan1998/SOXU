import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import "./styles/base.css";
import { applyDocumentTheme, resolveInitialTheme, syncWindowTheme } from "./theme/theme.ts";
import { currentWindowTarget } from "./theme/windowTheme.ts";

// 挂载前先落地主题：<html data-theme> 决定 :root token 与 color-scheme，
// 原生窗口标题栏也在这一刻同步，避免深色主题启动时先出现一帧浅色顶部。
const initialTheme = resolveInitialTheme();
applyDocumentTheme(initialTheme);
void syncWindowTheme(initialTheme, currentWindowTarget());

createApp(App).use(createPinia()).mount("#app");
