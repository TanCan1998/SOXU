/**
 * V4 设计 token 清单（Issue #110 临时验证面）。
 *
 * 抽成独立模块的两个原因：
 * 1. 色板组件只负责渲染与主题切换，样本清单是纯数据，放在一起会让 SFC 超过 600 行；
 * 2. tests/designTokens.test.ts 需要同一份清单去核对「tokens.css 里的每个变量都被色板覆盖」，
 *    两边共用一份数据才不会各写一份、各漏一半。
 *
 * 覆盖范围：所有**看得见**的 token 都要有样本（颜色 / 字号 / 圆角 / 阴影 / 缓动）。
 * 纯度量类变量（--sb-w / --insp-w / --icon-* / --content-* / --dur-* / --lh-chat / --font-*）
 * 和两个内部转发值（--shadow-pop-value / --ease-spring-value）不在这里出现：
 * 它们在页面上没有可对比的静态外观，靠 tests/designTokens.test.ts 直接核对字面量。
 * 字体栈由工具类自检块里的 font-mono 覆盖，见 UTILITY_CLASSES。
 */
export type SampleKind = "color" | "text" | "radius" | "shadow" | "motion";

export interface TokenSample {
  /** CSS 变量名，同时是展示用的标签。 */
  token: string;
  kind: SampleKind;
  /** 颜色样本上的文字用浅色还是深色，避免同色看不见。 */
  contrast?: "light" | "dark";
  /** 字号样本的展示文字。 */
  text?: string;
}

export interface TokenGroup {
  title: string;
  hint: string;
  items: TokenSample[];
}

export const TOKEN_GROUPS: TokenGroup[] = [
  {
    title: "表面",
    hint: "色差分层，不堆边框",
    items: [
      { token: "--surface", kind: "color", contrast: "dark" },
      { token: "--bg-sidebar", kind: "color", contrast: "dark" },
      { token: "--bg-panel", kind: "color", contrast: "dark" },
      { token: "--bg-raised", kind: "color", contrast: "dark" },
      { token: "--bg-hover", kind: "color", contrast: "dark" },
      { token: "--bg-active", kind: "color", contrast: "dark" },
    ],
  },
  {
    title: "文本与描边",
    hint: "三级文本 + 两级描边",
    items: [
      { token: "--fg", kind: "color", contrast: "light" },
      { token: "--fg-muted", kind: "color", contrast: "light" },
      { token: "--fg-subtle", kind: "color", contrast: "light" },
      { token: "--border", kind: "color", contrast: "light" },
      { token: "--border-strong", kind: "color", contrast: "light" },
      { token: "--code-bg", kind: "color", contrast: "light" },
      { token: "--glass", kind: "color", contrast: "dark" },
      { token: "--glass-border", kind: "color", contrast: "dark" },
    ],
  },
  {
    title: "强调与语义",
    hint: "深浅色共用同一组值",
    items: [
      { token: "--accent", kind: "color", contrast: "light" },
      { token: "--accent-hover", kind: "color", contrast: "light" },
      { token: "--accent-soft", kind: "color", contrast: "dark" },
      { token: "--ok", kind: "color", contrast: "light" },
      { token: "--warn", kind: "color", contrast: "light" },
      { token: "--danger", kind: "color", contrast: "light" },
    ],
  },
  {
    title: "字号",
    hint: "正文 --fs-chat 为 16px",
    items: [
      { token: "--fs-micro", kind: "text", text: "微号 11.5px" },
      { token: "--fs-caption", kind: "text", text: "说明 12.5px" },
      { token: "--fs-control", kind: "text", text: "控件 13.5px" },
      { token: "--fs-body", kind: "text", text: "界面正文 14.5px" },
      { token: "--fs-chat", kind: "text", text: "会话正文 16px" },
      { token: "--fs-title", kind: "text", text: "面板标题 16px" },
      { token: "--fs-heading", kind: "text", text: "页面标题 20px" },
    ],
  },
  {
    title: "圆角",
    hint: "7 / 9 / 13 / 999",
    items: [
      { token: "--r-sm", kind: "radius" },
      { token: "--r-md", kind: "radius" },
      { token: "--r-lg", kind: "radius" },
      { token: "--r-full", kind: "radius" },
    ],
  },
  {
    title: "阴影",
    hint: "只给浮层",
    items: [
      { token: "--shadow-pop", kind: "shadow" },
      { token: "--shadow-modal", kind: "shadow" },
      { token: "--inset", kind: "shadow" },
    ],
  },
  {
    title: "动效",
    hint: "标准缓动 + 弹簧缓动",
    items: [
      { token: "--ease", kind: "motion" },
      { token: "--ease-spring", kind: "motion" },
    ],
  },
];

/** 走 Tailwind 工具类的那一块：@theme 注册是否真的生效，看这里。 */
export const UTILITY_CLASSES = "bg-bg-raised text-fg border-border rounded-lg shadow-pop text-chat font-mono";
/** 缓动工具类单独探针：transition-timing-function 没有视觉差异，只能读计算值。 */
export const EASE_CLASSES = ["ease-spring", "ease-standard"] as const;
