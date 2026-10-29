/**
 * 回归测试：设置页四页（Issue #116 · V4-S2）。
 *
 * 能在 Node 里确定验证的部分：
 * - 会话页 / 系统页偏好的读写、默认值与逐字段容错；
 * - 强调色、代码字体、正文宽度、衬线字体在 base.css 里的档位与组件消费方式同源；
 * - 扩展页只是静态占位（12 个扩展、不写存储、带 TODO(V4-S7)）；
 * - 弹窗结构：四个 tab、reka-ui 的 Tabs/Switch/Select、Esc 关闭与打开即聚焦；
 * - App.vue 的接线：思考强度随发送透传、清空会话只重开不删除、恢复布局、复制路径。
 *
 * 真实像素、键盘走查与「切换后重启仍生效」由
 * apps/desktop/tests/harness/shoot-issue-116-settings.mjs 采集，见
 * docs/development/evidence/issue-116-v4-s2/README.md。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { formatMessageTime } from "../src/components/messageTime.ts";
import {
  SESSION_SETTINGS_STORAGE_KEY,
  DEFAULT_SESSION_SETTINGS,
  THINKING_LEVEL_OPTIONS,
  isThinkingLevel,
  normalizeSessionSettings,
  persistSessionSettings,
  readSessionSettings,
} from "../src/settings/sessionSettings.ts";
import {
  SYSTEM_SETTINGS_STORAGE_KEY,
  DEFAULT_SYSTEM_SETTINGS,
  normalizeSystemSettings,
  persistSystemSettings,
  readSystemSettings,
} from "../src/settings/systemSettings.ts";
import {
  EXTENSION_ENTRIES,
  MCP_SERVICE_ENTRIES,
  SKILL_ENTRIES,
} from "../src/settings/extensions.ts";
import { APP_IDENTIFIER, dataDirectoryHint } from "../src/settings/dataDirectory.ts";
import { ACCENT_OPTIONS } from "../src/theme/appearance.ts";
import type { KeyValueStorage } from "../src/settings/storage.ts";

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));
const TAURI_ROOT = fileURLToPath(new URL("../src-tauri", import.meta.url));

class FakeStorage implements KeyValueStorage {
  readonly entries = new Map<string, string>();
  failOnGet = false;
  failOnSet = false;

  getItem(key: string): string | null {
    if (this.failOnGet) throw new Error("SecurityError: localStorage 被禁用");
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failOnSet) throw new Error("QuotaExceededError: 配额已满");
    this.entries.set(key, value);
  }
}

async function readSource(relative: string): Promise<string> {
  return readFile(join(SRC_ROOT, relative), "utf8");
}

function stripCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 取出某条选择器的声明块；找不到直接失败，避免正则静默失效后测试假绿。 */
function cssRule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
  const match = new RegExp("(?:^|\\n)\\s*" + escaped + "\\s*\\{([^}]*)\\}").exec(source);
  assert.ok(match, "没有找到 " + selector + " 的样式块");
  return match[1] ?? "";
}

function declaration(block: string, property: string): string {
  const match = new RegExp(property + ":\\s*([^;]+);").exec(block);
  assert.ok(match, "没有找到 " + property + " 的声明");
  return (match[1] ?? "").trim();
}

async function collectVueFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return collectVueFiles(full);
      return entry.name.endsWith(".vue") ? [full] : [];
    }),
  );
  return files.flat();
}

// ──────────────────────────────────────────────────────────────
// 1. 会话页设置
// ──────────────────────────────────────────────────────────────
test("会话页默认值 = 改动前的现状，思考强度只认三档", () => {
  assert.equal(SESSION_SETTINGS_STORAGE_KEY, "soxu.session");
  assert.deepEqual(DEFAULT_SESSION_SETTINGS, {
    sendAfterScroll: true,
    enterToSend: true,
    // 复审修正：改动前工具输出块默认折叠，所以默认值是 false（上一版写成 true 却标注为「现状」）。
    showToolCalls: false,
    showTimestamps: false,
    thinkingLevel: "medium",
  });
  assert.deepEqual(
    THINKING_LEVEL_OPTIONS.map((option) => option.value),
    ["low", "medium", "high"],
  );
  for (const value of ["low", "medium", "high"]) assert.equal(isThinkingLevel(value), true);
  for (const value of ["Low", "max", "", null, undefined, 2]) {
    assert.equal(isThinkingLevel(value), false, String(value) + " 不应被当成思考强度");
  }
});

test("会话页设置往返：同一个键读写，脏字段逐项回退", () => {
  const storage = new FakeStorage();
  const chosen = {
    sendAfterScroll: false,
    enterToSend: false,
    showToolCalls: false,
    showTimestamps: true,
    thinkingLevel: "high" as const,
  };
  assert.equal(persistSessionSettings(chosen, storage), true);
  assert.deepEqual(readSessionSettings(storage), chosen);

  // 空存储 / 没有 localStorage → 默认值
  assert.deepEqual(readSessionSettings(new FakeStorage()), { ...DEFAULT_SESSION_SETTINGS });
  assert.deepEqual(readSessionSettings(null), { ...DEFAULT_SESSION_SETTINGS });

  // 非 JSON、非对象：整体回退
  for (const raw of ["not json", "null", "[]", "42"]) {
    const broken = new FakeStorage();
    broken.entries.set(SESSION_SETTINGS_STORAGE_KEY, raw);
    assert.deepEqual(readSessionSettings(broken), { ...DEFAULT_SESSION_SETTINGS }, raw);
  }

  // 开关必须是真正的 boolean：字符串 "true" 这类脏值退回默认，而不是被当成开
  assert.deepEqual(
    normalizeSessionSettings({
      sendAfterScroll: "true",
      enterToSend: 0,
      showToolCalls: null,
      showTimestamps: "yes",
      thinkingLevel: "max",
    }),
    { ...DEFAULT_SESSION_SETTINGS },
  );

  // 只坏一项：其他项保留用户的选择
  assert.deepEqual(normalizeSessionSettings({ ...chosen, thinkingLevel: "max" }), {
    ...chosen,
    thinkingLevel: DEFAULT_SESSION_SETTINGS.thinkingLevel,
  });
});

test("会话页设置：存储不可用不抛错，写入失败只是回到默认值", () => {
  const broken = new FakeStorage();
  broken.failOnGet = true;
  assert.deepEqual(readSessionSettings(broken), { ...DEFAULT_SESSION_SETTINGS });

  const full = new FakeStorage();
  full.failOnSet = true;
  assert.equal(persistSessionSettings({ ...DEFAULT_SESSION_SETTINGS }, full), false);
  assert.equal(persistSessionSettings({ ...DEFAULT_SESSION_SETTINGS }, null), false);
});

// ──────────────────────────────────────────────────────────────
// 2. 系统页设置
// ──────────────────────────────────────────────────────────────
test("系统页默认值三项都开，读写往返且脏值回退", () => {
  assert.equal(SYSTEM_SETTINGS_STORAGE_KEY, "soxu.system");
  assert.deepEqual(DEFAULT_SYSTEM_SETTINGS, {
    autoUpdate: true,
    notifyOnComplete: true,
    minimizeToTray: true,
  });

  const storage = new FakeStorage();
  const chosen = { autoUpdate: false, notifyOnComplete: false, minimizeToTray: false };
  assert.equal(persistSystemSettings(chosen, storage), true);
  assert.deepEqual(readSystemSettings(storage), chosen);
  assert.deepEqual(readSystemSettings(new FakeStorage()), { ...DEFAULT_SYSTEM_SETTINGS });

  assert.deepEqual(
    normalizeSystemSettings({ autoUpdate: "no", notifyOnComplete: 1, minimizeToTray: null }),
    { ...DEFAULT_SYSTEM_SETTINGS },
  );
  assert.deepEqual(normalizeSystemSettings({ ...chosen, autoUpdate: "no" }), {
    ...chosen,
    autoUpdate: DEFAULT_SYSTEM_SETTINGS.autoUpdate,
  });
});

// ──────────────────────────────────────────────────────────────
// 3. 扩展页：静态占位
// ──────────────────────────────────────────────────────────────
test("扩展页占位数据：12 个扩展、名字唯一、技能与 MCP 非空", () => {
  assert.equal(EXTENSION_ENTRIES.length, 12, "Issue #116 要求 12 个扩展开关");
  assert.equal(
    new Set(EXTENSION_ENTRIES.map((entry) => entry.name)).size,
    EXTENSION_ENTRIES.length,
    "扩展名必须唯一（开关状态按名字索引）",
  );
  for (const entry of EXTENSION_ENTRIES) {
    assert.ok(entry.name.length > 0);
    assert.ok(entry.description.length > 0, entry.name + " 需要一句用途说明");
    assert.equal(typeof entry.enabled, "boolean");
  }
  assert.ok(SKILL_ENTRIES.length >= 3, "技能列表至少要有几项");
  assert.ok(MCP_SERVICE_ENTRIES.length >= 2, "MCP 服务列表至少要有几项");
  assert.ok(MCP_SERVICE_ENTRIES.every((entry) => entry.toolCount > 0));
});

test("扩展页标注 TODO(V4-S7)，并且真的不写存储", async () => {
  const module = await readSource("settings/extensions.ts");
  assert.match(module, /TODO\(V4-S7\)/, "占位数据必须标出后续切片的接管点");
  assert.doesNotMatch(module, /localStorage|invoke\(/, "占位数据不读存储、不发 IPC");

  const panel = await readSource("components/settings/SettingsExtensions.vue");
  assert.match(panel, /TODO\(V4-S7\)/, "组件同样标注后续切片");
  assert.doesNotMatch(
    panel,
    /localStorage|persist[A-Z]|invoke\(/,
    "静态占位不许写存储：否则会留下一个「看起来已保存」的假开关",
  );
  // 页面上要如实说明这是占位，用户不会以为改了真实配置
  assert.match(panel, /占位/);
});

// ──────────────────────────────────────────────────────────────
// 4. base.css：强调色 / 代码字体 / 正文宽度 / 衬线
// ──────────────────────────────────────────────────────────────
test("强调色：默认色沿用 :root，其余五色各自覆盖强调色 token", async () => {
  const css = stripCssComments(await readSource("styles/base.css"));
  const root = cssRule(css, ":root");

  // 默认色 blue 必须等于 :root 的原值，且不写覆盖规则（默认观感零变化）
  assert.equal(ACCENT_OPTIONS[0]?.value, "blue");
  assert.equal(declaration(root, "--soxu-accent"), ACCENT_OPTIONS[0]?.hex);
  assert.equal(declaration(root, "--soxu-on-accent"), ACCENT_OPTIONS[0]?.onAccent);
  assert.ok(!/:root\[data-accent="blue"\]/.test(css), "blue 是默认值，不应该再有覆盖规则");

  // 派生色走「主色 + 主题比例」两级源值：浅色与深色各一套，组件只认别名
  assert.equal(declaration(root, "--soxu-accent-soft"), "var(--soxu-accent-soft-light)");
  assert.equal(declaration(root, "--soxu-selected"), "var(--soxu-selected-light)");
  assert.equal(declaration(root, "--soxu-focus"), "var(--soxu-focus-light)");

  for (const option of ACCENT_OPTIONS.filter((item) => item.value !== "blue")) {
    const block = cssRule(css, ':root[data-accent="' + option.value + '"]');
    // V3 token（现有组件在用）与 V4 token（S0 那套）必须同时切换，否则界面会出现两套色
    assert.equal(declaration(block, "--soxu-accent"), option.hex, option.value + " 的 V3 强调色");
    assert.equal(declaration(block, "--accent"), option.hex, option.value + " 的 V4 强调色");
    // soft / selected：浅色低比例、深色高比例，都从主色推导（不维护第二份十六进制）
    assert.match(declaration(block, "--soxu-accent-soft-light"), /^color-mix\(in srgb, var\(--soxu-accent\) 14%/);
    assert.match(declaration(block, "--soxu-selected-light"), /^color-mix\(in srgb, var\(--soxu-accent\) 16%/);
    assert.match(declaration(block, "--soxu-accent-soft-dark"), /^color-mix\(in srgb, var\(--soxu-accent\) 26%/);
    assert.match(declaration(block, "--soxu-selected-dark"), /^color-mix\(in srgb, var\(--soxu-accent\) 32%/);
    // 焦点环跟随色板（深色下由 --soxu-focus-dark 这一层决定）
    assert.equal(declaration(block, "--soxu-focus-light"), "var(--soxu-accent)");
    assert.equal(declaration(block, "--soxu-focus-dark"), "var(--soxu-accent)");
    // 主色底上的前景必须与选项表同源，否则发送钮图标与色板勾选会糊在底色里
    assert.equal(declaration(block, "--soxu-on-accent"), option.onAccent, option.value + " 的前景色");
  }
});

test("深色主题不得重复声明强调色（复审阻塞点：两套色）", async () => {
  // 教训：深色 token 同时挂在 :root[data-theme="dark"] 与 .app-shell[data-theme="dark"] 上。
  // 后者落在 app-shell 元素上，优先级高于 <html> 上的色板，所以在深色块里再写一次
  // --soxu-accent 会让「切了强调色，但 app-shell 子树仍是蓝色」——浏览器实测已复现。
  const css = stripCssComments(await readSource("styles/base.css"));
  const dark = cssRule(css, ':root[data-theme="dark"],\n.app-shell[data-theme="dark"]');

  assert.doesNotMatch(
    dark,
    /--soxu-accent\s*:/,
    "深色块不能再声明 --soxu-accent：色相只能来自 :root[data-accent] 的色板",
  );
  assert.equal(declaration(dark, "--soxu-accent-soft"), "var(--soxu-accent-soft-dark)");
  assert.equal(declaration(dark, "--soxu-selected"), "var(--soxu-selected-dark)");
  assert.equal(declaration(dark, "--soxu-focus"), "var(--soxu-focus-dark)");
  // V4 token 的选中底色在深色下同样用高比例，否则「已选中」在深底上看不出来
  assert.match(
    declaration(dark, "--accent-soft"),
    /^color-mix\(in srgb, var\(--accent\) 26%/,
    "深色下的 --accent-soft 必须比浅色的 14% 更实",
  );
  // 默认色 blue 的深色派生值仍是改动前的手调值（默认观感零变化）
  assert.equal(declaration(cssRule(css, ":root"), "--soxu-accent-soft-dark"), "#23324b");
  assert.equal(declaration(cssRule(css, ":root"), "--soxu-selected-dark"), "#2c3445");
  assert.equal(declaration(cssRule(css, ":root"), "--soxu-focus-dark"), "#7aa9f9");
});

test("代码字体：默认档沿用系统等宽栈，另两档只改等宽 token", async () => {
  const css = stripCssComments(await readSource("styles/base.css"));
  const root = cssRule(css, ":root");
  assert.match(declaration(root, "--soxu-font-family-mono"), /monospace$/);

  assert.ok(
    !/:root\[data-code-font="system"\]/.test(css),
    "system 是默认档，不应该再有覆盖规则",
  );

  const jetbrains = cssRule(css, ':root[data-code-font="jetbrains"]');
  assert.match(declaration(jetbrains, "--soxu-font-family-mono"), /^"JetBrains Mono"/);
  const fira = cssRule(css, ':root[data-code-font="fira"]');
  assert.match(declaration(fira, "--soxu-font-family-mono"), /^"Fira Code"/);

  // 两档都只能动等宽 token：界面字体与正文不能被代码字体选择影响
  for (const block of [jetbrains, fira]) {
    const changed = [...block.matchAll(/(--soxu-font-family-[a-z]+)\s*:/g)].map(
      (match) => match[1],
    );
    assert.deepEqual(changed, ["--soxu-font-family-mono"]);
  }
});

test("衬线档只改界面字体 token，正文与代码块不受影响", async () => {
  const css = stripCssComments(await readSource("styles/base.css"));
  const serif = cssRule(css, ':root[data-font-family="serif"]');
  const changed = [...serif.matchAll(/(--soxu-font-family-[a-z]+)\s*:/g)].map((match) => match[1]);
  assert.deepEqual(changed, ["--soxu-font-family-ui"]);
  assert.match(declaration(serif, "--soxu-font-family-ui"), /serif$/);
});

test("正文宽度：默认引用 V4 的 --content-max，自适应放开到 100%", async () => {
  const css = stripCssComments(await readSource("styles/base.css"));
  const root = cssRule(css, ":root");
  assert.equal(declaration(root, "--soxu-content-max"), "var(--content-max)");
  assert.equal(
    declaration(cssRule(css, ':root[data-content-width="fluid"]'), "--soxu-content-max"),
    "100%",
  );
  assert.ok(
    !/:root\[data-content-width="fixed"\]/.test(css),
    "fixed 是默认值，不应该再有覆盖规则",
  );

  // 组件只消费 token，不判断档位
  const messages = stripCssComments(await readSource("components/MessageList.vue"));
  assert.match(
    declaration(cssRule(messages, ".virtual-canvas"), "width"),
    /var\(--soxu-content-max\)/,
  );
  const composer = stripCssComments(await readSource("components/ChatComposer.vue"));
  assert.match(
    declaration(cssRule(composer, ".composer-area"), "width"),
    /var\(--soxu-content-max\)/,
  );
});

// ──────────────────────────────────────────────────────────────
// 5. 弹窗结构
// ──────────────────────────────────────────────────────────────
test("设置弹窗：四个 tab，顺序与文案照原型，内容各自独立成组件", async () => {
  const dialog = await readSource("components/SettingsDialog.vue");

  const labels = [...dialog.matchAll(/\{ value: "(\w+)", label: "([^"]+)" \}/g)].map(
    (match) => match[2],
  );
  assert.deepEqual(labels, ["外观", "会话", "扩展", "系统"], "四页顺序与原型一致");

  // reka-ui Tabs：自带 role=tablist/tab/tabpanel 与方向键
  for (const part of ["TabsRoot", "TabsList", "TabsTrigger", "TabsContent"]) {
    assert.ok(dialog.includes(part), "必须用 reka-ui 的 " + part);
  }
  for (const value of ["appearance", "session", "extensions", "system"]) {
    assert.ok(dialog.includes('<TabsContent value="' + value + '"'), value + " 页要有内容容器");
  }
  for (const component of [
    "SettingsAppearance",
    "SettingsSession",
    "SettingsExtensions",
    "SettingsSystem",
  ]) {
    assert.ok(dialog.includes(component), "四页各自成组件：" + component);
  }

  // Esc 关闭 + 打开即聚焦（键盘用户不需要先 Tab 一圈才进得来）
  assert.ok(dialog.includes('event.key === "Escape"'));
  assert.ok(dialog.includes('emit("close")'));
  assert.ok(dialog.includes("dialog.value?.focus()"));
  assert.ok(dialog.includes('aria-modal="true"'));
  assert.ok(dialog.includes('aria-labelledby="soxu-settings-title"'));
});

test("外观页：主题/强调色/字号/字体/代码字体/宽度六项齐全，事件都向上冒泡", async () => {
  const panel = await readSource("components/settings/SettingsAppearance.vue");
  for (const label of ["主题", "强调色", "界面字号", "界面字体", "代码字体", "正文宽度"]) {
    assert.ok(panel.includes('label="' + label + '"'), "外观页缺少「" + label + "」");
  }
  for (const table of [
    "ACCENT_OPTIONS",
    "FONT_SIZE_OPTIONS",
    "FONT_FAMILY_OPTIONS",
    "CODE_FONT_OPTIONS",
    "CONTENT_WIDTH_OPTIONS",
  ]) {
    assert.ok(panel.includes(table), "选项表来自 theme/appearance.ts：" + table);
  }
  // 每个事件都先用守卫收窄再冒泡：界面选不到 CSS 里不存在的档位
  for (const guard of [
    "isThemeName",
    "isAccentName",
    "isFontSizeName",
    "isFontFamilyName",
    "isCodeFontName",
    "isContentWidthName",
  ]) {
    assert.ok(panel.includes(guard), "缺少守卫：" + guard);
  }
  assert.ok(panel.includes('emit("update:appearance"'));
  assert.ok(panel.includes('emit("update:theme"'));
});

test("会话页：四个开关 + 思考强度 Select + 忙碌时发送 + 清空，全部只改偏好", async () => {
  const panel = await readSource("components/settings/SettingsSession.vue");
  for (const label of [
    "发送后滚动",
    "Enter 发送",
    "显示工具调用",
    "消息时间戳",
    "默认思考强度",
    "忙碌时发送",
    "清空当前会话",
  ]) {
    assert.ok(panel.includes('label="' + label + '"'), "会话页缺少「" + label + "」");
  }
  // 思考强度用 reka-ui 的 Select（本切片指定的三种控件之一）
  assert.ok(panel.includes("SelectRoot"), "默认思考强度用 reka Select");
  assert.ok(panel.includes("SelectPortal"), "下拉内容走 portal，不被弹窗裁切");
  assert.ok(panel.includes("THINKING_LEVEL_OPTIONS"), "三档来自 sessionSettings.ts");
  assert.ok(panel.includes("isThinkingLevel"), "值先收窄再冒泡");
  // 清空会话：禁用原因由外层给，组件不自己猜
  assert.ok(panel.includes("clearBlockedReason"));
  assert.ok(panel.includes("emit('clear-session')"), "清空按钮要向上冒泡");
  // 不写存储：偏好的落地与持久化在 App.vue 的 composable 里
  assert.doesNotMatch(panel, /localStorage|persist[A-Z]/);
});

test("系统页：7 项齐全，未接入的能力如实说明而不是假装生效", async () => {
  const panel = await readSource("components/settings/SettingsSystem.vue");
  for (const label of [
    "自动更新",
    "任务完成通知",
    "关闭时最小化到托盘",
    "检查更新",
    "恢复默认布局",
    "数据目录",
    "关于",
  ]) {
    assert.ok(panel.includes('label="' + label + '"'), "系统页缺少「" + label + "」");
  }
  // 三个开关都绑定到 setFlag，不是摆设
  for (const key of ["autoUpdate", "notifyOnComplete", "minimizeToTray"]) {
    assert.ok(panel.includes("'" + key + "'"), "开关要真的写回：" + key);
  }
  assert.ok(panel.includes("emit('reset-layout')"), "重置按钮要向上冒泡");
  assert.ok(panel.includes("emit('copy-data-dir')"), "复制按钮要向上冒泡");
  // 「检查更新」在后端能力缺失时必须是禁用状态，不能点了没反应
  assert.match(panel, /<SettingsButton label="检查更新" disabled \/>/);
  // 关于：版本 + Tauri 版本 + 平台
  assert.ok(panel.includes("tauriVersion"));
  assert.ok(panel.includes("appVersion"));
});

test("开关与单选组都是 reka-ui，且都有可访问名称", async () => {
  const sw = await readSource("components/settings/SettingsSwitch.vue");
  assert.ok(sw.includes("SwitchRoot"));
  assert.ok(sw.includes("SwitchThumb"));
  assert.ok(sw.includes(':aria-labelledby="labelledby"'), "开关的名字来自行标题");
  assert.ok(sw.includes("value === true"), "只接受布尔值，脏值按关处理");

  const choice = await readSource("components/settings/SettingsChoice.vue");
  assert.ok(choice.includes("RadioGroupRoot"));
  assert.ok(choice.includes("RadioGroupItem"));
  assert.ok(choice.includes('orientation="horizontal"'), "方向键在组内左右移动");

  const row = await readSource("components/settings/SettingsRow.vue");
  assert.ok(row.includes("useId"), "行标题 id 由 reka 生成，避免四页 id 撞车");
  assert.ok(row.includes("label-id"), "把 labelId 交给控件做 aria-labelledby");
});

// ──────────────────────────────────────────────────────────────
// 6. 接线：会话开关真的影响列表与输入区
// ──────────────────────────────────────────────────────────────
test("App.vue：三套设置都接线，思考强度随每次发送透传", async () => {
  const app = await readSource("App.vue");
  assert.ok(app.includes("useSessionSettings"));
  assert.ok(app.includes("useSystemSettings"));
  assert.ok(app.includes("useAppearance"));
  assert.ok(app.includes(':settings="session"'), "会话设置透传给会话面板");
  assert.ok(app.includes('@update:session="patchSession"'));
  assert.ok(app.includes('@update:system="patchSystem"'));
  assert.ok(app.includes('@update:appearance="(value: Appearance) => patchAppearance(value)"'));
  assert.ok(app.includes('@clear-session="clearSessionCache"'));
  assert.ok(app.includes('@reset-layout="resetLayout"'));
  assert.ok(app.includes('@copy-data-dir="copyDataDirectory"'));
  // 默认思考强度：每次发送都带当前档位（不是只在设置页里存着）
  assert.ok(app.includes("thinking: session.value.thinkingLevel"));
});

test("清空当前会话不删除任何东西：只关掉再重开，且临时会话被排除", async () => {
  const app = await readSource("App.vue");
  assert.match(app, /await store\.closeTab\(meta\.sessionId\);\s*await store\.openSession\(meta\);/);
  assert.doesNotMatch(
    app,
    /discardTemporarySession|removeSession|deleteSession/,
    "清空界面缓存绝不能调用删除类命令",
  );
  assert.match(app, /tab\.mode === "temporary"/, "临时会话关闭即结束，必须排除");
  assert.match(app, /clearBlockedReason/, "禁用原因要能显示给用户");
});

test("清空当前会话保留草稿：先取出、重开后再写回", async () => {
  // 复审教训（Issue #116）：closeTab 会把 Tab 对象整个丢掉，草稿随之一并消失，
  // 用户点「清空」时正在写的半句话就没了。草稿不是消息缓存，必须原样保留。
  const app = await readSource("App.vue");
  const body = app.slice(
    app.indexOf("async function clearSessionCache()"),
    app.indexOf("/** 复制数据目录路径"),
  );
  assert.ok(body.length > 0, "没有找到 clearSessionCache");

  const capture = body.indexOf("const draft = tab.draft;");
  const close = body.indexOf("await store.closeTab(");
  const reopen = body.indexOf("await store.openSession(");
  const restore = body.indexOf("store.setDraft(");

  assert.ok(capture > 0, "必须先把草稿取下来");
  assert.ok(capture < close, "取草稿必须发生在 closeTab 之前（之后 Tab 已经没了）");
  assert.ok(restore > reopen, "写回草稿必须发生在重开之后（openSession 会新建空的 Tab）");
  assert.match(body, /if \(draft\) store\.setDraft\(meta\.sessionId, draft\)/, "空草稿不必写回");
  // 草稿写回与顺序还原都放在 finally 里：openSession 拉历史失败时也不能丢草稿
  assert.match(body, /\} finally \{/, "写回草稿必须在 finally 里，历史加载失败时也要执行");
  // 重开会话会把 Tab 追加到末尾，必须搬回原位置（否则清一次缓存 tab 栏就重排）
  assert.match(body, /store\.moveTab\(reopened, index\)/, "清缓存后要还原 tab 顺序");

  // 存储层不参与：草稿只在内存里，清缓存不应该往 localStorage 写任何东西
  assert.doesNotMatch(body, /localStorage|persist[A-Z]/);
});

test("会话面板：四项开关都真的改变显示行为", async () => {
  const list = await readSource("components/MessageList.vue");
  assert.ok(list.includes("settings: SessionSettings"));
  assert.ok(list.includes("sendAfterScroll"), "发送后滚动");
  assert.ok(list.includes("showToolCalls"), "工具输出默认展开");
  assert.ok(list.includes("showTimestamps"), "消息时间戳");
  assert.ok(list.includes(":open="), "工具输出块的默认展开状态绑到设置");
  assert.ok(list.includes("formatMessageTime"), "时间戳格式化走纯函数");

  const composer = await readSource("components/ChatComposer.vue");
  assert.ok(composer.includes("enterToSend"));
  assert.ok(composer.includes("props.enterToSend"), "快捷键判定必须读设置");
  assert.ok(composer.includes("sendShortcut"), "提示文案与实际判定同源");

  const panel = await readSource("components/ChatPanel.vue");
  assert.ok(panel.includes("settings: SessionSettings"), "会话面板把设置透传给子组件");
  assert.ok(panel.includes(':settings="settings"'));
  assert.ok(panel.includes(':enter-to-send="settings.enterToSend"'));
});

test("消息时间戳格式化：本地时区 HH:mm，缺失或非法返回 null", () => {
  // 用本地时间构造输入，测试不依赖运行环境的时区
  const local = new Date(2026, 0, 2, 9, 5, 0);
  assert.equal(formatMessageTime(local.toISOString()), "09:05");
  const afternoon = new Date(2026, 0, 2, 18, 42, 0);
  assert.equal(formatMessageTime(afternoon.toISOString()), "18:42");

  for (const value of [null, undefined, "", "not-a-date", "2026-13-45"]) {
    assert.equal(formatMessageTime(value), null, String(value) + " 不应产生时间文本");
  }
});

// ──────────────────────────────────────────────────────────────
// 7. 数据目录
// ──────────────────────────────────────────────────────────────
test("数据目录路径按平台推导，且应用标识符与 tauri.conf.json 一致", async () => {
  assert.equal(dataDirectoryHint("windows"), "%APPDATA%\\" + APP_IDENTIFIER);
  assert.equal(dataDirectoryHint("macos"), "~/Library/Application Support/" + APP_IDENTIFIER);
  assert.equal(dataDirectoryHint("linux"), "~/.local/share/" + APP_IDENTIFIER);
  assert.match(dataDirectoryHint(null), new RegExp(APP_IDENTIFIER), "未知平台也要给出标识符");

  const config = JSON.parse(await readFile(join(TAURI_ROOT, "tauri.conf.json"), "utf8")) as {
    identifier: string;
  };
  assert.equal(
    APP_IDENTIFIER,
    config.identifier,
    "设置页显示的目录名必须与 Tauri 的 app_data_dir 一致",
  );
});

// ──────────────────────────────────────────────────────────────
// 8. 静态检查：新组件同样遵守字号/字体/无原生 title 的约定
// ──────────────────────────────────────────────────────────────
test("设置相关组件不写死字体栈，也不用原生 title 做提示", async () => {
  const files = await collectVueFiles(join(SRC_ROOT, "components", "settings"));
  files.push(join(SRC_ROOT, "components", "SettingsDialog.vue"));
  assert.ok(files.length >= 8, "设置相关组件应当已经拆成多个文件");

  for (const file of files) {
    const css = stripCssComments(await readFile(file, "utf8"));
    for (const match of css.matchAll(/font-family:\s*([^;]+);/g)) {
      const value = (match[1] ?? "").trim();
      assert.ok(value.startsWith("var(--soxu-font-family-"), file + " 写死了字体栈：" + value);
    }
    assert.doesNotMatch(css, /\stitle="/, file + " 的提示应该走 AppTooltip，不用原生 title");
  }
});
