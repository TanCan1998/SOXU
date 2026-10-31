/**
 * 回归测试：产品净化第二刀 + i18n（Issue #145 · TASK-035）。
 *
 * 本文件钉住四件事，全部能在 Node 里确定验证：
 * 1. 设置目录与命令注册表**不含硬编码界面文案**（注释除外），文案只在语言包里；
 * 2. 切到 en-US 后，设置页与命令面板派生的全部文案都不含中日韩字符，
 *    且每个 key 在两个语言包里都存在（缺 key 会退化成 key 本身，这里会立刻发现）；
 * 3. 系统开关真接线：完成通知并入通知事件链、关闭行为推给 Rust、数据目录走后端命令；
 * 4. 发布通道落地前的两个更新入口（自动更新 / 检查更新）确实被移除，而不是禁用。
 *
 * 真实窗口关闭行为与「打开资源管理器」需要桌面端实机，
 * 见 docs/development/evidence/issue-145-product-i18n/README.md 的验收清单。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildCommands } from "../src/commands/registry.ts";
import {
  SETTINGS_ENTRIES,
  SETTINGS_TABS,
  keywordList,
  settingsEntryView,
  settingsEntries,
  settingsTabView,
  settingsTabs,
} from "../src/settings/catalog.ts";
import { useLocale } from "../src/locales/index.ts";
import { isSystemNotificationEnabled } from "../src/notifications/settings.ts";
import {
  OPEN_DATA_DIRECTORY_COMMAND,
  SET_CLOSE_BEHAVIOR_COMMAND,
  openDataDirectoryInFileManager,
  pushCloseBehavior,
  type SystemBridge,
} from "../src/settings/systemBridge.ts";
import { stripComments } from "./support/uiWordingScan.ts";

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));
const TAURI_SRC = fileURLToPath(new URL("../src-tauri/src", import.meta.url));

/** CJK 汉字 + CJK 标点 + 全角字符：出现即说明这条文案还没进语言包。 */
const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/u;

const { t, setLocale } = useLocale();

async function readSource(relative: string): Promise<string> {
  return readFile(join(SRC_ROOT, relative), "utf8");
}

function readLocale(tag: string, module: string): Promise<string> {
  return readFile(join(SRC_ROOT, "locales", tag, module + ".json"), "utf8");
}

/** 断言一段文案不是「缺 key 原样返回」，也不含 CJK。 */
function assertTranslated(label: string, value: string): void {
  assert.ok(value.trim().length > 0, label + " 是空的");
  assert.ok(!value.startsWith("settings.") && !value.startsWith("commands."), label + " 缺 key：" + value);
  assert.doesNotMatch(value, CJK, label + " 在 en-US 下仍是中文：" + value);
}

// ──────────────────────────────────────────────────────────────
// 1. 源码里没有硬编码文案
// ──────────────────────────────────────────────────────────────
test("设置目录与命令注册表不含硬编码界面文案（注释不算）", async () => {
  for (const file of ["settings/catalog.ts", "commands/registry.ts"]) {
    const code = stripComments(await readSource(file));
    assert.doesNotMatch(code, CJK, file + " 里仍有硬编码中文文案，应改成语言包 key");
  }
});

// ──────────────────────────────────────────────────────────────
// 2. en-US 全英文，且两个语言包的 key 一一对应
// ──────────────────────────────────────────────────────────────
test("设置目录：18 项 + 4 页，zh-CN 与 en-US 都能解析成真实文案", async () => {
  assert.equal(SETTINGS_ENTRIES.length, 18, "移除两个更新入口后剩 18 项");
  assert.equal(SETTINGS_TABS.length, 4);

  for (const tag of ["zh-CN", "en-US"]) {
    await setLocale(tag, { persist: false });
    for (const view of settingsTabs(t)) {
      assert.ok(view.label.length > 0, tag + " 缺标签页标题：" + view.id);
      assert.ok(view.description.length > 0, tag + " 缺标签页说明：" + view.id);
      assert.ok(!view.label.startsWith("settings."), tag + " 缺 key：" + view.id);
    }
    for (const view of settingsEntries(t)) {
      assert.ok(view.label.length > 0, tag + " 缺设置项标题：" + view.id);
      assert.ok(view.description.length > 0, tag + " 缺设置项说明：" + view.id);
      assert.ok(!view.label.startsWith("settings."), tag + " 缺 key：" + view.id);
      assert.ok(!view.description.startsWith("settings."), tag + " 缺 key：" + view.id);
      assert.ok(view.keywords.length > 0, tag + " 缺搜索别名：" + view.id);
    }
  }

  // en-US：设置页与命令面板派生的全部文案都不含 CJK。
  await setLocale("en-US", { persist: false });
  for (const tab of settingsTabs(t)) {
    assertTranslated("tab " + tab.id + " label", tab.label);
    assertTranslated("tab " + tab.id + " description", tab.description);
    for (const word of tab.keywords) assertTranslated("tab " + tab.id + " keyword", word);
  }
  for (const entry of settingsEntries(t)) {
    assertTranslated("entry " + entry.id + " label", entry.label);
    assertTranslated("entry " + entry.id + " description", entry.description);
    for (const word of entry.keywords) assertTranslated("entry " + entry.id + " keyword", word);
  }

  await setLocale("zh-CN", { persist: false });
  assert.match(settingsEntryView(SETTINGS_ENTRIES[0]!, t).label, CJK, "基准语言仍是中文");
});

test("命令面板：en-US 下标题 / 说明 / 别名 / 不可用原因全英文", async () => {
  await setLocale("en-US", { persist: false });
  const commands = buildCommands(t);
  assert.equal(
    commands.length,
    SETTINGS_TABS.length + SETTINGS_ENTRIES.length + 12,
    "7 面板 + 4 会话 + 1 系统 + 4 设置页 + 18 设置项",
  );
  for (const command of commands) {
    assertTranslated(command.id + " title", command.title);
    if (command.hint) assertTranslated(command.id + " hint", command.hint);
    for (const word of command.keywords ?? []) assertTranslated(command.id + " keyword", word);
    assert.ok(
      ["panel", "session", "settings", "system"].includes(command.group),
      "分组是稳定 id，不是文案",
    );
  }

  // 不可用原因同样跟随语言，而不是注册表里写死的一句话。
  const worktrees = commands.find((command) => command.id === "panel.worktrees");
  assert.ok(worktrees?.unavailable);
  const reason = worktrees.unavailable({ hasActiveSession: false, hasProject: false });
  assert.ok(reason);
  assertTranslated("unavailable reason", reason);
  assert.equal(worktrees.unavailable({ hasActiveSession: false, hasProject: true }), null);

  await setLocale("zh-CN", { persist: false });
  const zh = buildCommands(t);
  assert.ok(zh.some((command) => command.title === "打开设置"), "切回中文后标题立刻变回来");
});

test("en-US 语言包里没有残留中文（含选项档位与系统页说明）", async () => {
  for (const module of ["commands", "settings"]) {
    const en = JSON.parse(await readLocale("en-US", module)) as Record<string, string>;
    for (const [key, value] of Object.entries(en)) {
      assert.doesNotMatch(value, CJK, "en-US/" + module + ".json 的 " + key + " 仍是中文：" + value);
    }
  }
});

test("语言包 key 对齐：commands / settings 两个模块在两个语言里 key 完全一致", async () => {
  for (const module of ["commands", "settings"]) {
    const zh = JSON.parse(await readLocale("zh-CN", module)) as Record<string, string>;
    const en = JSON.parse(await readLocale("en-US", module)) as Record<string, string>;
    assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), module + " 的 key 必须一致");
    for (const [key, value] of Object.entries(en)) {
      assert.ok(value.trim().length > 0, module + " 的空文案：" + key);
    }
  }
});

test("搜索别名：逗号分隔串拆成数组，空项与空白被丢掉", () => {
  assert.deepEqual(keywordList("theme, dark ,light"), ["theme", "dark", "light"]);
  // 全角逗号不是分隔符（语言包里的分隔符只有 ASCII 逗号），原样保留更不容易出错。
  assert.deepEqual(keywordList("设置，,配置"), ["设置，", "配置"]);
  assert.deepEqual(keywordList(""), []);
  assert.deepEqual(keywordList(undefined), []);
});

// ──────────────────────────────────────────────────────────────
// 3. 系统开关真接线
// ──────────────────────────────────────────────────────────────
test("任务完成通知：总闸关闭后完成/出错不提醒，等待输入仍然提醒", () => {
  assert.equal(isSystemNotificationEnabled("sessionCompleted", { notifyOnComplete: true }), true);
  assert.equal(isSystemNotificationEnabled("sessionCompleted", { notifyOnComplete: false }), false);
  assert.equal(isSystemNotificationEnabled("sessionError", { notifyOnComplete: false }), false);
  assert.equal(
    isSystemNotificationEnabled("awaitingInput", { notifyOnComplete: false }),
    true,
    "等待输入不是「任务完成」，一起静音会让 Agent 卡住却没人知道",
  );
});

test("关闭行为：偏好经 set_close_behavior 推给 Rust，失败不抛错也不回滚偏好", async () => {
  const calls: boolean[] = [];
  const bridge: SystemBridge = {
    async setMinimizeToTray(enabled: boolean) {
      calls.push(enabled);
    },
    async openDataDirectory() {
      return "/tmp";
    },
  };
  assert.equal(await pushCloseBehavior(bridge, false), true);
  assert.deepEqual(calls, [false]);

  const broken: SystemBridge = {
    async setMinimizeToTray() {
      throw new Error("bridge unavailable");
    },
    async openDataDirectory() {
      throw new Error("bridge unavailable");
    },
  };
  // 浏览器预览 / 后端暂时不可用：返回 false，不把设置页的开关弹回去。
  assert.equal(await pushCloseBehavior(broken, true), false);
});

test("打开数据目录：成功带回真实路径，失败带回原因", async () => {
  const ok: SystemBridge = {
    async setMinimizeToTray() {},
    async openDataDirectory() {
      return "C:/Users/test/AppData/Roaming/dev.soxu.desktop";
    },
  };
  assert.deepEqual(await openDataDirectoryInFileManager(ok), {
    ok: true,
    path: "C:/Users/test/AppData/Roaming/dev.soxu.desktop",
  });

  const failed: SystemBridge = {
    async setMinimizeToTray() {},
    async openDataDirectory() {
      throw new Error("E_OPEN_DIR: explorer 不可用");
    },
  };
  const result = await openDataDirectoryInFileManager(failed);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /E_OPEN_DIR/u);
});

test("前后端命令名一致：bridge 里的两个命令都注册在 workspace 领域块内", async () => {
  const lib = await readFile(join(TAURI_SRC, "lib.rs"), "utf8");
  const workspace = await readFile(join(TAURI_SRC, "commands", "workspace.rs"), "utf8");
  for (const name of [SET_CLOSE_BEHAVIOR_COMMAND, OPEN_DATA_DIRECTORY_COMMAND]) {
    assert.ok(
      lib.includes("commands::" + name + ","),
      "lib.rs 的 workspace 块里缺少注册：" + name,
    );
    assert.ok(workspace.includes("fn " + name + "("), "commands/workspace.rs 里缺少实现：" + name);
  }
  // 关闭行为偏好必须是受管状态，否则窗口事件读不到它。
  assert.ok(lib.includes("tray::ClosePreference"), "lib.rs 必须登记 ClosePreference");
  const tray = await readFile(join(TAURI_SRC, "tray.rs"), "utf8");
  assert.ok(tray.includes("try_state::<ClosePreference>()"), "窗口事件必须读偏好");
});

test("App.vue：三处接线都在（通知总闸 / 关闭行为 / 打开数据目录）", async () => {
  const app = await readSource("App.vue");
  assert.match(app, /useNotifications\(\{[\s\S]{0,200}completionEnabled/u, "通知总闸接进订阅");
  assert.match(app, /pushCloseBehavior\(systemBridge, enabled\)/u, "关闭行为推给 Rust");
  assert.match(app, /immediate: true/u, "启动时也要推一次偏好，否则上次的关闭状态不生效");
  assert.match(app, /openDataDirectoryInFileManager\(systemBridge\)/u, "打开数据目录走 bridge");
  assert.ok(app.includes('@open-data-dir="openDataDirectory"'), "设置页按钮接到真实动作");
  assert.match(app, /:commands="commands"/u, "命令清单随语言重建");
});

// ──────────────────────────────────────────────────────────────
// 4. 更新入口移除
// ──────────────────────────────────────────────────────────────
test("发布通道落地前没有「自动更新」「检查更新」入口", async () => {
  const ids = SETTINGS_ENTRIES.map((entry) => entry.id);
  assert.ok(!ids.includes("system.autoUpdate"));
  assert.ok(!ids.includes("system.updateCheck"));
  const panel = await readSource("components/settings/SettingsSystem.vue");
  assert.doesNotMatch(panel, /updateCheck|autoUpdate/u);
  // 持久化字段保留（不丢用户旧偏好），但界面没有入口。
  const storage = await readSource("settings/systemSettings.ts");
  assert.ok(storage.includes("autoUpdate"), "字段保留，便于将来加回入口时不用迁移");
});
