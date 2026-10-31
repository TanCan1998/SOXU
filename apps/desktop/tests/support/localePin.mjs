/**
 * 测试环境的界面语言固定为 zh-CN。
 *
 * 为什么需要：`resetLocaleStateForTests()` 会按「持久化偏好 → 系统语言 → zh-CN」重新解析，
 * 而 Node 的 navigator.language 来自宿主机。开发机是 zh-CN、CI 是 en-US，
 * 于是同一份测试在两边结论不同——2026-10-31 PR #152 的 9 个失败全是这个原因
 * （断言中文字面量，在 CI 上拿到英文）。
 *
 * 通过 `node --import ./tests/support/localePin.mjs --test …` 预加载，
 * 让整个包的测试与宿主语言无关。需要验证其它语言时，测试内部显式 `setLocale("en-US")`。
 */
Object.defineProperty(globalThis, "navigator", {
  value: { languages: ["zh-CN"], language: "zh-CN" },
  configurable: true,
  writable: true,
});
