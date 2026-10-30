/**
 * Issue #123 · TASK-031：命令面板（拼音首字母搜索 + 全键盘执行）的契约。
 *
 * 能在 Node 里确定验证的部分：
 * 1. 拼音首字母 / 全拼 / 中文 / 英文别名四种输入的命中与排序；
 * 2. 命中高亮的区间（含相邻区间合并与越界保护）；
 * 3. 注册表完整性：id 唯一、标题不重复、设置类命令由 settings/catalog.ts 生成；
 * 4. 键盘语义：↑↓ 首尾相接、Home/End、↵ 执行、Esc 关闭、带修饰键不抢键；
 * 5. 组件与外壳接线：Ctrl+K 打开、ARIA 结构、底部快捷键提示、无定时器/全局监听；
 * 6. 设置项元数据单一来源：面板只写 setting id，标题来自 catalog.ts。
 *
 * 真实渲染、按键序列与截图由 tests/harness/command-palette.html +
 * tests/harness/shoot-issue-123-palette.mjs 采集，见
 * docs/development/evidence/issue-123-command-palette/README.md。
 */

import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { pinyin } from "pinyin-pro";

import {
  highlightSegments,
  matchCommand,
  normalizeQuery,
  pinyinReady,
  rankCommands,
  searchIndex,
  setPinyinProvider,
  MAX_RESULTS,
  type PinyinChar,
} from "../src/commands/match.ts";
import {
  COMMANDS,
  clampActiveIndex,
  commandContext,
  nextActiveIndex,
  paletteKeyAction,
} from "../src/commands/registry.ts";
import { FOCUSABLE_SELECTOR, focusTargetIndex } from "../src/commands/focusTrap.ts";
import { SETTINGS_ENTRIES, SETTINGS_TABS, settingsEntry } from "../src/settings/catalog.ts";

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));

async function readSource(relative: string): Promise<string> {
  return readFile(join(SRC_ROOT, relative), "utf8");
}

/**
 * 注入拼音引擎。
 *
 * 生产代码里这一步由 CommandPalette 动态 import pinyin-pro 完成（字典 173 KB gzip，
 * 不进首屏 bundle）；测试里显式注入，等价于「面板已经打开、引擎已就绪」的状态。
 */
function installPinyin(): void {
  setPinyinProvider(
    (text) => pinyin(text, { type: "all", toneType: "none" }) as unknown as PinyinChar[],
  );
}

before(() => {
  installPinyin();
});

function ids(query: string): string[] {
  return rankCommands(COMMANDS, query).results.map((row) => row.command.id);
}

function titleOf(id: string): string {
  const found = COMMANDS.find((command) => command.id === id);
  assert.ok(found, "注册表里应该有这条命令：" + id);
  return found.title;
}

/* ── 1. 拼音匹配 ───────────────────────────────────────────── */

test("拼音首字母 dk 命中所有「打开…」命令，且第一条是「打开设置」", () => {
  const matched = ids("dk");
  const opening = COMMANDS.filter((command) => command.title.startsWith("打开"));
  assert.ok(opening.length >= 4, "至少有四条「打开…」命令（设置 / 搜索 / Git / 会话状态）");
  for (const command of opening) {
    assert.ok(matched.includes(command.id), "dk 应该命中：" + command.title);
  }
  assert.equal(titleOf(matched[0] ?? ""), "打开设置", "同分时按注册表顺序，「打开设置」在最前");
});

test("拼音首字母 sz 命中「打开设置」——首字母是子序列而不是整词", () => {
  // 「打开设置」的首字母串是 dksz：sz 出现在第 3、4 位，属于包含匹配。
  const match = matchCommand("sz", "打开设置");
  assert.ok(match, "sz 必须命中「打开设置」");
  assert.deepEqual(match.ranges, [{ start: 2, end: 4 }], "高亮落在「设置」两个字上");
});

test("全拼与中文输入都能命中同一条命令", () => {
  for (const query of ["dakaishezhi", "打开设置", "设置", "da kai she zhi"]) {
    const matched = ids(query);
    assert.ok(matched.includes("panel.settings"), query + " 应该命中「打开设置」");
  }
  // 全拼不需要声调与空格；大小写也不敏感。
  assert.ok(ids("DENGDAKAI").length >= 0);
  assert.deepEqual(
    ids("DaKaiSheZhi").slice(0, 1),
    ["panel.settings"],
    "大小写不敏感",
  );
});

test("拼音首字母 qhzt 命中「切换主题」", () => {
  assert.ok(ids("qhzt").includes("session.toggleTheme"));
  assert.ok(ids("qh").includes("session.toggleTheme"), "只打声母前缀也能命中");
});

test("英文别名能命中，但别名命中的结果没有高亮区间", () => {
  const match = matchCommand("worktree", "打开工作树面板", ["worktree"]);
  assert.ok(match, "别名应该命中");
  assert.deepEqual(match.ranges, [], "别名不在标题里，标不出位置，因此不高亮");
  assert.ok(ids("worktree").includes("panel.worktrees"));
  assert.ok(ids("inspector").includes("panel.inspector"));
});

test("短输入不会靠松散的子序列命中无关命令", () => {
  // 「关闭时最小化到托盘」的全拼里 g…i…t 能凑出子序列；跨度上限把它挡掉。
  const matched = ids("git");
  assert.deepEqual(matched, ["panel.git"], "git 只应该命中 Git 面板");
  assert.equal(ids("xxt").length, 0, "凑不出来的输入没有结果");
});

test("英文 + 汉字混写走标题子序列；拼音 + 汉字混写不支持，如实返回不匹配", () => {
  // 汉字本来就在标题里，所以「enter发送」能按标题子序列命中（中间的空格被跳过）。
  const mixed = matchCommand("enter发送", "Enter 发送");
  assert.ok(mixed, "英文 + 汉字应该能命中");
  assert.deepEqual(mixed.ranges, [
    { start: 0, end: 5 },
    { start: 6, end: 8 },
  ]);

  // 全拼串里没有汉字、标题串里没有拼音，这类混写两个来源各缺一半——不假装支持。
  assert.equal(matchCommand("dakai设置", "打开设置"), null);

  // 纯英文与纯中文各自正常。
  assert.ok(matchCommand("enter", "Enter 发送"));
  assert.ok(matchCommand("发送", "Enter 发送"));
});

test("空输入返回全部命令（注册表顺序），不排序也不高亮", () => {
  const result = rankCommands(COMMANDS, "   ");
  assert.equal(result.matched, COMMANDS.length);
  assert.deepEqual(
    result.results.map((row) => row.command.id),
    COMMANDS.map((command) => command.id),
    "空查询保持注册表顺序",
  );
  assert.deepEqual(result.results[0]?.ranges, []);
  assert.equal(result.results[0]?.score, 0);
});

test("输入归一化：去空白 + 小写", () => {
  assert.equal(normalizeQuery("  Ctrl + G "), "ctrl+g");
  assert.equal(normalizeQuery("DK"), "dk");
  // 索引里的串不含空白，因此带空格的输入照样能匹配。
  assert.ok(matchCommand("da kai", "打开设置"));
});

test("搜索索引把汉字拆成全拼与首字母，英文按原字符保留", () => {
  const index = searchIndex("打开 Git 面板");
  assert.equal(index.initials.text, "dkgitmb", "汉字取首字母，英文原样，空格跳过");
  assert.equal(index.full.text, "dakaigitmianban");
  // 同一个标题第二次取索引命中缓存（返回同一对象，不重复算拼音）。
  assert.equal(searchIndex("打开 Git 面板"), index);
});

test("拼音引擎未注入时只做标题字面匹配，不伪造首字母命中", () => {
  setPinyinProvider(null);
  try {
    assert.equal(pinyinReady(), false);
    assert.equal(matchCommand("dk", "打开设置"), null, "没有字典时 dk 不该命中");
    assert.equal(matchCommand("dakaishezhi", "打开设置"), null, "没有字典时全拼也不该命中");
    assert.ok(matchCommand("设置", "打开设置"), "标题字面匹配仍然可用，面板不会整体失效");
    assert.ok(matchCommand("worktree", "打开工作树面板", ["worktree"]), "别名同样可用");
  } finally {
    installPinyin();
  }
  assert.equal(pinyinReady(), true);
  assert.ok(matchCommand("dk", "打开设置"), "注入后立刻恢复首字母匹配");
});

/* ── 2. 高亮 ───────────────────────────────────────────────── */

test("高亮区间映射回标题码点，并合并相邻区间", () => {
  const dk = matchCommand("dk", "打开设置");
  assert.deepEqual(dk?.ranges, [{ start: 0, end: 2 }], "dk 映射到「打开」两个字");
  assert.deepEqual(highlightSegments("打开设置", [{ start: 0, end: 2 }]), [
    { text: "打开", hit: true },
    { text: "设置", hit: false },
  ]);

  // 全拼 dakai 的 5 个字符落在 2 个码点上，必须合并成一个区间而不是 5 个碎片。
  const full = matchCommand("dakai", "打开设置");
  assert.deepEqual(full?.ranges, [{ start: 0, end: 2 }]);
});

test("高亮区间越界时只取交集，不抛错也不吃掉整行", () => {
  assert.deepEqual(highlightSegments("设置", [{ start: 0, end: 99 }]), [
    { text: "设置", hit: true },
  ]);
  assert.deepEqual(highlightSegments("设置", [{ start: 5, end: 9 }]), [
    { text: "设置", hit: false },
  ]);
  assert.deepEqual(highlightSegments("", []), []);
});

test("没有高亮时整行是一段普通文本", () => {
  assert.deepEqual(highlightSegments("打开设置", []), [{ text: "打开设置", hit: false }]);
});

/* ── 3. 排序与上限 ─────────────────────────────────────────── */

test("标题包含优先于别名命中", () => {
  const results = rankCommands(COMMANDS, "设置").results;
  const first = results[0];
  assert.equal(first?.command.id, "panel.settings");
  const aliasOnly = results.find((row) => row.command.id === "setting.appearance.theme");
  assert.ok(aliasOnly, "别名里带「设置」的设置项也要出现");
  assert.ok(
    (first?.score ?? 0) > (aliasOnly?.score ?? 0),
    "标题命中的分数必须高于别名命中",
  );
});

test("结果条数有上界，超出时 matched 仍然如实计数", () => {
  const limited = rankCommands(COMMANDS, "", 3);
  assert.equal(limited.results.length, 3);
  assert.equal(limited.matched, COMMANDS.length);
  assert.ok(MAX_RESULTS >= 20, "上限至少能覆盖当前命令总量的一半，避免列表被无谓截断");
  assert.equal(rankCommands(COMMANDS, "").results.length, COMMANDS.length);
});

test("排序是确定的：同样的输入两次得到同样的顺序", () => {
  const first = ids("dk");
  const second = ids("dk");
  assert.deepEqual(first, second);
});

/* ── 4. 注册表 ─────────────────────────────────────────────── */

test("命令 id 与标题都唯一，且每条命令都有可执行实现", () => {
  const seen = new Set<string>();
  const titles = new Set<string>();
  for (const command of COMMANDS) {
    assert.ok(command.id.trim().length > 0, "命令必须有 id");
    assert.ok(!seen.has(command.id), "命令 id 重复：" + command.id);
    seen.add(command.id);
    assert.ok(!titles.has(command.title), "命令标题重复：" + command.title);
    titles.add(command.title);
    assert.equal(typeof command.run, "function", command.id + " 必须有执行实现");
    assert.ok(["面板", "会话", "设置", "系统"].includes(command.group), "分组取值受控");
  }
});

test("设置类命令由 settings/catalog.ts 生成，不复制标题", () => {
  for (const tab of SETTINGS_TABS) {
    const id = "settings.tab." + tab.id;
    assert.ok(COMMANDS.some((command) => command.id === id), "缺少设置页命令：" + id);
    assert.equal(titleOf(id), "打开设置 · " + tab.label);
  }
  for (const entry of SETTINGS_ENTRIES) {
    const id = "setting." + entry.id;
    const command = COMMANDS.find((candidate) => candidate.id === id);
    assert.ok(command, "缺少设置项命令：" + id);
    assert.equal(command.title, entry.label, "命令标题必须等于设置项的可见标题");
  }
});

test("不可用命令给出原因，而不是点了没反应", () => {
  const empty = commandContext({});
  const ready = commandContext({ hasActiveSession: true, hasProject: true });

  const worktrees = COMMANDS.find((command) => command.id === "panel.worktrees");
  assert.ok(worktrees);
  assert.equal(worktrees.unavailable?.(empty), "还没有登记项目");
  assert.equal(worktrees.unavailable?.(ready), null);

  for (const id of ["session.closeActive", "session.reopen"]) {
    const command = COMMANDS.find((candidate) => candidate.id === id);
    assert.ok(command);
    assert.equal(command.unavailable?.(empty), "当前没有打开的会话");
    assert.equal(command.unavailable?.(ready), null);
  }
});

test("注册表只登记真实存在的动作：终端 / 文件面板还没有实现，因此不在清单里", () => {
  // 本切片不伪造「打开终端」「打开文件」这类还没有落地的命令；
  // 等对应切片交付后再往注册表里加，命令面板不需要改结构。
  const titles = COMMANDS.map((command) => command.title);
  assert.deepEqual(titles.filter((title) => title.includes("终端")), []);
  assert.deepEqual(titles.filter((title) => title.includes("打开文件")), []);
});

/* ── 5. 键盘语义 ───────────────────────────────────────────── */

test("按键翻译：↑↓ / Home / End / ↵ / Esc，带修饰键不抢键", () => {
  assert.equal(paletteKeyAction("ArrowDown"), "next");
  assert.equal(paletteKeyAction("ArrowUp"), "previous");
  assert.equal(paletteKeyAction("Home"), "first");
  assert.equal(paletteKeyAction("End"), "last");
  assert.equal(paletteKeyAction("Enter"), "execute");
  assert.equal(paletteKeyAction("Escape"), "close");
  assert.equal(paletteKeyAction("a"), "none");
  // Ctrl+K 必须留给外壳（再按一次关掉面板），面板内不能再抢。
  assert.equal(paletteKeyAction("ArrowDown", { ctrl: true }), "none");
  assert.equal(paletteKeyAction("ArrowDown", { meta: true }), "none");
  assert.equal(paletteKeyAction("ArrowDown", { alt: true }), "none");
  // 面板里没有多行输入，Enter 带修饰键同样执行。
  assert.equal(paletteKeyAction("Enter", { ctrl: true }), "execute");
});

test("高亮下标首尾相接，空列表返回 -1", () => {
  assert.equal(nextActiveIndex(0, 3, "next"), 1);
  assert.equal(nextActiveIndex(2, 3, "next"), 0, "到底部再按下回到第一条");
  assert.equal(nextActiveIndex(0, 3, "previous"), 2, "在第一条按上回到最后一条");
  assert.equal(nextActiveIndex(1, 3, "first"), 0);
  assert.equal(nextActiveIndex(1, 3, "last"), 2);
  assert.equal(nextActiveIndex(-1, 0, "next"), -1);
  assert.equal(nextActiveIndex(5, 3, "none"), 2, "非法下标收敛到范围内");
});

test("过滤后下标收敛：从 8 条筛到 2 条不能继续指着第 7 条", () => {
  assert.equal(clampActiveIndex(7, 2), 1);
  assert.equal(clampActiveIndex(-1, 2), 0);
  assert.equal(clampActiveIndex(3, 0), -1);
});

test("模态焦点圈：Tab / Shift+Tab 首尾相接，焦点出不去", () => {
  // 面板里目前只有一个可聚焦元素（搜索框），规则仍按「n 个」写：将来加按钮不用改这里。
  assert.equal(focusTargetIndex(0, 1, false), 0, "只有一个元素时 Tab 仍停在它身上");
  assert.equal(focusTargetIndex(0, 1, true), 0);
  assert.equal(focusTargetIndex(0, 3, false), 1);
  assert.equal(focusTargetIndex(2, 3, false), 0, "最后一个再 Tab 回到第一个");
  assert.equal(focusTargetIndex(0, 3, true), 2, "第一个 Shift+Tab 回到最后一个");
  assert.equal(focusTargetIndex(-1, 3, false), 0, "焦点不在面板内时从头开始");
  assert.equal(focusTargetIndex(-1, 3, true), 2, "反向时从尾部开始");
  assert.equal(focusTargetIndex(9, 3, false), 0, "越界下标收敛到第一个");
  assert.equal(focusTargetIndex(0, 0, false), -1, "没有可聚焦元素时只拦默认行为，不抛错");
  // tabindex="-1" 必须排除：否则将来被标成 -1 的容器会被 Tab 圈进来。
  assert.ok(FOCUSABLE_SELECTOR.includes("[tabindex]:not([tabindex='-1'])"));
});

/* ── 6. 组件与外壳接线 ─────────────────────────────────────── */

test("命令面板：ARIA 结构、底部快捷键提示、纯渲染无资源", async () => {
  const palette = await readSource("components/CommandPalette.vue");

  for (const marker of [
    'role="dialog"',
    'aria-modal="true"',
    'aria-labelledby="soxu-command-palette-title"',
    'role="combobox"',
    'aria-controls="soxu-command-list"',
    'aria-autocomplete="list"',
    ':aria-activedescendant="activeId',
    'role="listbox"',
    'role="option"',
    ':aria-selected="index === activeIndex"',
  ]) {
    assert.ok(palette.includes(marker), "缺少无障碍标记：" + marker);
  }

  // 底部快捷键提示是验收点的一部分：↑↓ 选择 / ↵ 执行 / Esc 关闭。
  assert.ok(palette.includes("选择"), "底部提示要说明 ↑↓ 选择");
  assert.ok(palette.includes("执行"), "底部提示要说明 ↵ 执行");
  assert.ok(palette.includes("关闭"), "底部提示要说明 Esc 关闭");

  assert.ok(palette.includes('emit("run"'), "执行结果交给上层");
  assert.ok(palette.includes('emit("close"'), "Esc / 点击遮罩关闭");
  assert.ok(palette.includes("onMounted"), "打开即聚焦输入框");

  // 复审阻塞点：aria-modal 只是语义声明，焦点圈与焦点还原都得自己实现。
  assert.ok(palette.includes('ref="dialog"'), "对话框元素要能被查询到，才能圈焦点");
  assert.ok(palette.includes("FOCUSABLE_SELECTOR"), "Tab 圈用共享的可聚焦选择器");
  assert.ok(palette.includes("trapTab"), "Tab 必须被拦在面板内");
  assert.ok(palette.includes("focusBeforeOpen"), "打开前要记下焦点来源");
  assert.ok(palette.includes("onBeforeUnmount"), "卸载时把焦点还回去");
  assert.ok(palette.includes("isConnected"), "只在原元素还在文档里时还原焦点");

  // 组件不持有资源：没有定时器、没有全局监听，卸载即结束。
  assert.doesNotMatch(palette, /setInterval|setTimeout|window\.addEventListener/);
});

test("拼音字典按需加载：不静态 import，面板第一次打开时才拉 chunk", async () => {
  const palette = await readSource("components/CommandPalette.vue");
  assert.doesNotMatch(palette, /^import \{[^}]*\} from "pinyin-pro";$/m, "不得静态引入字典");
  assert.ok(palette.includes('await import("pinyin-pro")'), "改为动态 import");
  assert.ok(palette.includes("setPinyinProvider"), "加载完成后注入引擎");
  assert.ok(palette.includes(":data-pinyin="), "就绪状态可观测（夹具据此等待）");
  assert.ok(palette.includes("pinyinLoaded.value = true"), "注入后触发一次重排");

  // 字典不进首屏：match.ts 里同样不能有静态 import。
  const match = await readSource("commands/match.ts");
  assert.doesNotMatch(match, /^import .* from "pinyin-pro";$/m);
});

test("App.vue：Ctrl+K 打开命令面板，命令由注册表注入，设置可带目标页打开", async () => {
  const app = await readSource("App.vue");
  assert.ok(app.includes('import CommandPalette from "./components/CommandPalette.vue"'));
  assert.ok(app.includes('from "./commands/registry.ts"'), "命令清单来自注册表");
  assert.match(app, /paletteOpen\.value = !paletteOpen\.value/, "Ctrl+K 是开/关切换");
  assert.match(app, /<CommandPalette[\s\S]{0,200}:commands="COMMANDS"/);
  assert.match(app, /<CommandPalette[\s\S]{0,200}:context="paletteContext"/);
  assert.ok(app.includes('@run="runCommand"'));
  assert.ok(app.includes('@close="paletteOpen = false"'));
  // 执行前先收起面板，设置弹窗才不会被面板盖住。
  assert.match(app, /function runCommand\(command: CommandEntry\) \{\s*paletteOpen\.value = false;/);
  // 「新建临时会话」不再是 Ctrl+K，而是面板里的一条命令。
  assert.match(app, /key === "k"[\s\S]{0,200}paletteOpen/);
  assert.ok(app.includes('@open-settings="openSettings(null)"'), "顶栏齿轮沿用上次的页面");
  assert.ok(app.includes(":initial-tab=\"settingsTab\""), "命令面板带目标页打开设置");
  // 复审阻塞点：设置已经开着时再执行设置类命令，光靠 open 的 false→true 变化会丢请求。
  assert.ok(app.includes(':request="settingsRequest"'), "设置弹窗收到打开请求序号");
  assert.match(app, /settingsRequest\.value \+= 1/, "每次 openSettings 都递增请求序号");
});

test("SettingsDialog：initialTab 只是初始页，普通打开仍停留在上次的页面", async () => {
  const dialog = await readSource("components/SettingsDialog.vue");
  assert.ok(dialog.includes("initialTab: SettingsTabId | null"));
  assert.match(dialog, /if \(props\.initialTab\) tab\.value = props\.initialTab/);
  assert.ok(dialog.includes("SETTINGS_TABS"), "标签页来自 catalog.ts");
  // 复审阻塞点：设置已经开着时，新请求也必须切页（判定在 settings/openRequest.ts）。
  assert.ok(dialog.includes("settingsOpenTransition"), "已打开时的换页判定走纯函数");
  assert.ok(dialog.includes("request: number"), "弹窗接收打开请求序号");
});

test("设置项元数据单一来源：面板只写 setting id，标题与说明由 catalog.ts 决定", async () => {
  const row = await readSource("components/settings/SettingsRow.vue");
  assert.ok(row.includes("settingsEntry"), "SettingsRow 从目录取元数据");
  // setting 允许可选：语言包页（Issue #135）的标题必须跟随语言切换，
  // 用 labelKey 走 t()，那条路径不经过 catalog 查表。
  assert.match(row, /setting\??: string/, "按 id 接收设置项");
  assert.doesNotMatch(row, /label: string/, "SettingsRow 不再接受 label 字面量");
  assert.ok(row.includes("labelKey"), "支持 i18n key 形式的标题");

  const panels = ["SettingsAppearance", "SettingsSession", "SettingsSystem"];
  const used = new Set<string>();
  for (const name of panels) {
    const source = await readSource("components/settings/" + name + ".vue");
    for (const match of source.matchAll(/setting="([^"]+)"/g)) {
      const id = match[1] ?? "";
      // 拼错的 id 必须在这里就炸掉，而不是在界面上显示一个空标题。
      assert.doesNotThrow(() => settingsEntry(id), name + " 引用了不存在的设置项：" + id);
      used.add(id);
    }
    assert.doesNotMatch(source, /<SettingsRow[^>]*\slabel=/, name + " 不应再写死标题");
  }
  assert.equal(used.size, SETTINGS_ENTRIES.length, "每个设置项都应该被某一页渲染");
});

test("命令面板读的是同一份设置元数据（不重复维护）", async () => {
  const registry = await readSource("commands/registry.ts");
  assert.ok(registry.includes("SETTINGS_ENTRIES"), "设置项命令由目录生成");
  assert.ok(registry.includes("SETTINGS_TABS"), "设置页命令由目录生成");
  assert.doesNotMatch(registry, /title: "主题"/, "注册表里不得出现设置项标题字面量");
});
