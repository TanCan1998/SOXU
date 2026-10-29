import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

/**
 * @tailwindcss/vite 是 V4 token 落地（Issue #110）的必需插件：
 * Tailwind 4 的 `@theme` 是 CSS-first 配置，没有插件就不会被编译，src/styles/tokens.css 里的
 * 工具类与主题变量也就不会生成。Preflight 已在 tokens.css 里显式跳过，既有组件样式不受影响。
 */
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  clearScreen: false,
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
});
