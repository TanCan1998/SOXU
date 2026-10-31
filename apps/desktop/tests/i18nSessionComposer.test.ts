/**
 * 回归测试：会话区与输入区的 i18n 存量迁移（Issue #144 / TASK-034）。
 *
 * 能在 Node 里确定验证的部分：
 * - 会话区 / 输入区的模板与脚本里不再有硬编码中文（只扫用户可见字符串，注释不算）；
 * - session.json / composer.json 与 en-US 完全对齐，且英文包里没有中文；
 * - 切到 en-US 后每个 key 都解析成英文，不会静默回退成中文；
 * - 缺失 key 回退 zh-CN（社区包只翻译一部分时的行为）；
 * - 数据源文案（sendMode.ts、sessionStats.ts）随语言切换，不是常量快照；
 * - 消息时间戳改走 Intl 的 formatDateTime（12/24 小时制由语言决定）。
 *
 * 真实像素与桌面端切换语言后的截图需要 `pnpm tauri:dev` 手工走一遍，
 * 见 docs/development/i18n.md 的验收清单（本文件不冒充像素证据）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { stripComments, visibleFragments } from "./support/uiWordingScan.ts";
import {
  BASE_MESSAGES,
  registerCommunityLocale,
  resetLocaleStateForTests,
  useLocale,
} from "../src/locales/index.ts";
import { formatMessageTime } from "../src/components/messageTime.ts";
import { sendModeDescription, sendModeLabel } from "../src/components/sendMode.ts";
import {
  PLACEHOLDER,
  composeStatsView,
  processDegradedNotes,
  ringLabel,
  statsPopoverSections,
  statsRowItems,
} from "../src/components/sessionStats.ts";
import { checkLocales } from "../../../scripts/check-locales.mjs";

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));
const LOCALES_ROOT = join(SRC_ROOT, "locales");
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** 本切片负责的文件：会话区 10 个 + 输入区 2 个（含它们的数据源模块）。 */
const SESSION_FILES = [
  "components/ChatPanel.vue",
  "components/MessageList.vue",
  "components/MessageActions.vue",
  "components/SessionTabs.vue",
  "components/SessionStatsRow.vue",
  "components/SessionStatsRing.vue",
  "components/sessionStats.ts",
  "components/sendMode.ts",
];

const COMPOSER_FILES = ["components/ChatComposer.vue", "components/ComposerSendMenu.vue"];

/** CJK 统一表意文字 + 中日韩标点 + 全角形式：界面文案里出现任何一个都算硬编码中文。 */
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u;

async function readSource(relative: string): Promise<string> {
  return readFile(join(SRC_ROOT, relative), "utf8");
}

async function readPack(locale: string, module: string): Promise<Record<string, string>> {
  const raw = await readFile(join(LOCALES_ROOT, locale, module + ".json"), "utf8");
  return JSON.parse(raw) as Record<string, string>;
}

/** 把一段源码里的注释抹掉（HTML 注释 + JS/TS/CSS 注释），保留字符串与模板文本。 */
function withoutComments(source: string): string {
  return stripComments(source.replace(/<!--[\s\S]*?-->/gu, ""));
}

function reset(): void {
  resetLocaleStateForTests();
}

// ──────────────────────────────────────────────────────────────
// 1. 硬编码中文：模板与脚本里一条都不许留
// ──────────────────────────────────────────────────────────────
test("会话区与输入区：用户可见文案里没有硬编码中文", async () => {
  const offenders: string[] = [];

  for (const relative of [...SESSION_FILES, ...COMPOSER_FILES]) {
    const source = await readSource(relative);

    // 模板：文本节点与属性值（含 :bound="'字面量'"）都要过一遍。
    if (relative.endsWith(".vue")) {
      for (const fragment of visibleFragments(relative, source)) {
        if (CJK.test(fragment.text)) offenders.push(relative + " 模板 → " + fragment.text.trim());
      }
    }

    // 脚本：注释抹掉后仍然出现中文，说明是字符串字面量（= 用户可见文案或日志）。
    const stripped = withoutComments(source);
    for (const line of stripped.split(/\r?\n/u)) {
      if (CJK.test(line)) offenders.push(relative + " 脚本 → " + line.trim());
    }
  }

  assert.deepEqual(offenders, [], "这些位置仍在硬编码中文，应改为 t()：\n" + offenders.join("\n"));
});

test("会话区与输入区：t() 的 key 都能在基准包里找到", async () => {
  let keyCount = 0;
  for (const relative of [...SESSION_FILES, ...COMPOSER_FILES]) {
    const source = await readSource(relative);
    // 前面不能是标识符字符：emit('promote') 里的 "t('promote')" 不是 t() 调用。
    for (const match of source.matchAll(/(?<![\w$.])t\((['"])([a-zA-Z0-9.]+)\1/gu)) {
      const key = match[2] ?? "";
      keyCount += 1;
      assert.ok(BASE_MESSAGES[key] !== undefined, relative + " 引用了基准包里没有的 key：" + key);
    }
  }
  // 反假绿：提取不到 key 说明扫描失效，上面的断言会永远通过。
  assert.ok(keyCount >= 40, "只提取到 " + keyCount + " 个 key，扫描逻辑可能已经失效");
});

// ──────────────────────────────────────────────────────────────
// 2. 语言包：两个模块、两种语言完全对齐，英文包里没有中文
// ──────────────────────────────────────────────────────────────
test("session / composer 模块在两个语言里 key 完全一致，英文包不含中文", async () => {
  for (const module of ["session", "composer"]) {
    const zh = await readPack("zh-CN", module);
    const en = await readPack("en-US", module);
    assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), module + " 的 key 必须一致");
    assert.ok(Object.keys(zh).length > 0, module + " 不能是空包");

    const chineseInEnglish = Object.entries(en)
      .filter(([, value]) => CJK.test(value))
      .map(([key]) => key);
    assert.deepEqual(chineseInEnglish, [], "en-US/" + module + ".json 里还有中文：" + chineseInEnglish.join(", "));

    // 基准包必须是中文：英文值不能是「照抄的中文」。
    // 少数条目本来就该逐字相同（"Agent"、"CPU"、"generation 1 · ready" 这类
    // 技术标识与占位模板），因此只拦下含中文的相同值。
    const copiedChinese = Object.entries(en)
      .filter(([key, value]) => zh[key] === value && CJK.test(value))
      .map(([key]) => key);
    assert.deepEqual(
      copiedChinese,
      [],
      "en-US/" + module + ".json 里这些 key 直接抄了中文：" + copiedChinese.join(", "),
    );
  }
});

test("仓库语言包门禁：模块已登记，check-locales 无问题", () => {
  const result = checkLocales(REPO_ROOT);
  assert.deepEqual(result.violations, [], "check-locales 必须通过");
  assert.ok(result.modules >= 4, "session / composer 必须与 common / settings 一起被登记");
});

// ──────────────────────────────────────────────────────────────
// 3. 切到 en-US：每个 key 都解析成英文（不静默回退）
// ──────────────────────────────────────────────────────────────
test("切换 en-US 后会话区与输入区的 key 全部解析成英文", async () => {
  reset();
  const { t, setLocale } = useLocale();
  await setLocale("en-US");

  for (const module of ["session", "composer"]) {
    const en = await readPack("en-US", module);
    for (const [key, value] of Object.entries(en)) {
      const qualified = module + "." + key;
      assert.equal(t(qualified), value, qualified + " 没有解析成英文");
      assert.ok(!CJK.test(t(qualified)), qualified + " 解析结果里仍有中文");
    }
  }

  // 抽查各组件的代表性文案：这条断言就是「界面完整英文」的最小证据。
  assert.equal(t("session.panel.status.ready"), "Ready");
  assert.equal(t("session.list.role.user"), "You");
  assert.equal(t("session.tabs.new"), "New temporary session");
  assert.equal(t("session.stats.popover.title"), "Context and statistics");
  assert.equal(t("composer.input.placeholder"), "Send a message to Pi Agent…");
  assert.equal(t("composer.send.label"), "Send message");

  await setLocale("zh-CN");
  assert.equal(t("session.panel.status.ready"), "就绪");
});

// ──────────────────────────────────────────────────────────────
// 4. 缺失 key 回退 zh-CN
// ──────────────────────────────────────────────────────────────
test("社区包只翻译了一部分：缺的会话/输入文案回退 zh-CN，而不是空白或 key", async () => {
  reset();
  const { t, setLocale } = useLocale();
  registerCommunityLocale("ja-JP", {
    "session.panel.status.ready": "準備完了",
    "composer.send.label": "送信",
  });
  await setLocale("ja-JP");

  assert.equal(t("session.panel.status.ready"), "準備完了", "翻译过的 key 用社区包");
  assert.equal(t("composer.send.label"), "送信");
  // 社区包没翻译的 key 必须回退中文，界面不会出现空白或裸 key。
  assert.equal(t("session.list.role.user"), BASE_MESSAGES["session.list.role.user"]);
  assert.equal(t("composer.input.placeholder"), BASE_MESSAGES["composer.input.placeholder"]);
  assert.equal(t("session.list.role.user"), "你");

  await setLocale("zh-CN");
});

// ──────────────────────────────────────────────────────────────
// 5. 数据源文案随语言切换
// ──────────────────────────────────────────────────────────────
test("sendMode.ts：投递方式名称与说明来自语言包", async () => {
  reset();
  const { setLocale } = useLocale();
  assert.equal(sendModeLabel("steer"), "加入当前");
  assert.equal(sendModeDescription("parallel"), "独立会话后台处理，不打断当前输出");

  await setLocale("en-US");
  assert.equal(sendModeLabel("steer"), "Add to current");
  assert.match(sendModeDescription("parallel"), /background session/u);

  await setLocale("zh-CN");
});

test("sessionStats.ts：统计行、浮窗、读屏标签与降级说明都走语言包", async () => {
  reset();
  const { setLocale } = useLocale();
  const view = composeStatsView(null, null);

  assert.deepEqual(
    statsRowItems(view).map((item) => item.label),
    ["轮次", "首 token", "回复耗时", "流式", "均速", "缓存命中", "输入/输出"],
  );
  assert.equal(statsPopoverSections(view)[0]?.title, "上下文");
  assert.equal(ringLabel(view), "上下文占用未知");
  assert.deepEqual(processDegradedNotes(["cpu_unsupported"]), ["当前平台不提供 CPU 占用"]);
  // 未知标识是后端给的排障线索，任何语言下都原样保留。
  assert.deepEqual(processDegradedNotes(["whatever"]), ["whatever"]);

  await setLocale("en-US");
  assert.deepEqual(
    statsRowItems(view).map((item) => item.label),
    ["Turns", "First token", "Duration", "Streaming", "Avg speed", "Cache hit", "Input/output"],
  );
  assert.equal(statsPopoverSections(view)[0]?.title, "Context");
  assert.equal(ringLabel(view), "Context usage unknown");
  assert.deepEqual(processDegradedNotes(["cpu_unsupported"]), [
    "CPU usage is not available on this platform",
  ]);
  // 数值部分不跟着翻译：占位符仍然是破折号，不是英文文案。
  assert.equal(statsRowItems(view)[0]?.value, PLACEHOLDER);

  await setLocale("zh-CN");
});

// ──────────────────────────────────────────────────────────────
// 6. 消息时间戳走 Intl
// ──────────────────────────────────────────────────────────────
test("消息时间戳：formatDateTime 决定 12/24 小时制，非法值不渲染", async () => {
  reset();
  const { formatDateTime, setLocale } = useLocale();
  const morning = new Date(2026, 0, 2, 9, 5, 0);

  assert.equal(formatMessageTime(morning.toISOString(), formatDateTime), "09:05", "中文 24 小时制");
  await setLocale("en-US");
  assert.match(
    formatMessageTime(morning.toISOString(), formatDateTime) ?? "",
    /^09:05\s?AM$/u,
    "英文 12 小时制",
  );

  for (const value of [null, undefined, "", "not-a-date"]) {
    assert.equal(formatMessageTime(value, formatDateTime), null, String(value) + " 不应产生时间文本");
  }

  await setLocale("zh-CN");
});

test("消息列表的时间戳来自 formatDateTime，不再手拼 HH:mm", async () => {
  const list = await readSource("components/MessageList.vue");
  assert.ok(list.includes("useLocale"), "会话区文案与时间格式化都走语言运行时");
  assert.ok(list.includes("formatMessageTime(message?.createdAt, formatDateTime)"));
  assert.doesNotMatch(list, /getHours\(\)/u, "不再手工拼时分");
});
