/**
 * 命令注册表（Issue #123 · TASK-031；Issue #145 起文案全部走语言包）。
 *
 * 一份数据 + 一个动作接口：注册表不认识 Vue、不认识 store，也不做 IO，
 * 执行时由 App.vue 注入 CommandActions。于是「有哪些命令、能不能用、执行什么」
 * 全部可以在 Node 里用假 actions 断言，不需要挂载组件。
 *
 * 三条纪律：
 * 1. **只登记真实存在的动作**。终端面板与文件打开在本切片都还没有实现，
 *    因此注册表里没有「打开终端 / 打开文件」——宁可少一条，也不放一条点了没反应的命令
 *    （见 docs/development/command-palette.md 的「未覆盖」一节）。
 * 2. **设置类命令由 settings/catalog.ts 生成**，不在这里复制标题：
 *    新增一项设置，命令面板自动多一条可搜索项。
 * 3. **本文件不含任何界面文案**：标题 / 说明 / 搜索别名 / 不可用原因都是
 *    locales/<tag>/commands.json 里的 key，由 buildCommands(t) 在渲染时解析。
 *    因此切换语言后命令面板立刻变成对应语言，不需要重新加载注册表。
 */

import {
  SETTINGS_ENTRIES,
  SETTINGS_TABS,
  camelToKey,
  settingsEntryView,
  settingsTab,
  settingsTabView,
  type SettingsTabId,
  type Translate,
} from "../settings/catalog.ts";

/**
 * 结果分组；只用于界面上的小标签，不改变排序（排序见 commands/match.ts）。
 *
 * 存的是稳定 id 而不是文案：面板用 t("commands.group.<id>") 渲染，
 * 于是同一份注册表可以同时服务中文与英文界面。
 */
export type CommandGroup = "panel" | "session" | "settings" | "system";

/**
 * 命令可用性上下文。
 *
 * 只放「判断能不能执行」需要的少量事实，不放整个 workspace 状态：
 * 传大对象进注册表会让纯逻辑悄悄依赖响应式结构，测试也就没法造夹具了。
 */
export interface CommandContext {
  /** 当前是否有打开的会话 Tab。 */
  hasActiveSession: boolean;
  /** 是否至少登记了一个项目。 */
  hasProject: boolean;
}

/**
 * 命令执行时用到的动作。
 *
 * App.vue 提供唯一实现；注册表只调用，不关心它怎么落地。
 * 这里的每个方法都必须有真实副作用——不允许留空实现来「先占位」。
 */
export interface CommandActions {
  /** 打开设置；tab 为 null 时沿用上次看的页面。 */
  openSettings(tab: SettingsTabId | null): void;
  openSearch(): void;
  toggleSidebar(): void;
  toggleInspector(): void;
  toggleGit(): void;
  openNotifications(): void;
  openWorktrees(): void;
  newTemporarySession(): void;
  closeActiveSession(): void;
  reopenActiveSession(): void;
  toggleTheme(): void;
  copyDataDirectory(): void;
}

export interface CommandEntry {
  /** 稳定 id：测试、日志与未来「最近使用」都靠它，不随文案变化。 */
  id: string;
  /** 结果行主文案（当前语言），也是搜索与高亮的对象。 */
  title: string;
  group: CommandGroup;
  /** 结果行右侧的补充说明（分组名 / 目标页）。 */
  hint?: string;
  /** 额外搜索别名：英文名、同义词。 */
  keywords?: readonly string[];
  /** 快捷键提示，仅用于展示；真实绑定在 App.vue 的 keydown 里。 */
  shortcut?: string;
  /** 返回不可执行的原因；null / 省略表示可用。 */
  unavailable?: (context: CommandContext) => string | null;
  run: (actions: CommandActions) => void;
}

/**
 * 命令的可翻译声明：只写 id 与动作。
 *
 * 语言包 key 由 id 推导（commands.entry.<id 转点分>.title / .hint / .keywords），
 * 因此新增命令只有两个动作：写一条 spec、在语言包里补三个 key。
 * 两边拼错任意一半都会在测试里暴露——缺 key 时 t() 会原样返回 key，一眼可见。
 */
interface CommandSpec {
  id: string;
  group: CommandGroup;
  shortcut?: string;
  /** 执行前提；缺了就给出对应原因，而不是点了没反应。 */
  requires?: "session" | "project";
  run: (actions: CommandActions) => void;
}

/** 命令 id → 语言包 key（session.newTemporary → commands.entry.session.new.temporary.*）。 */
export function commandKeys(id: string): {
  titleKey: string;
  hintKey: string;
  keywordsKey: string;
} {
  const path = "commands.entry." + id.split(".").map(camelToKey).join(".");
  return {
    titleKey: path + ".title",
    hintKey: path + ".hint",
    keywordsKey: path + ".keywords",
  };
}

/** 面板类命令：都是右侧面板 / 浮层的开关，与顶栏按钮一一对应。 */
const PANEL_COMMANDS: readonly CommandSpec[] = [
  { id: "panel.settings", group: "panel", shortcut: "Ctrl+,", run: (a) => a.openSettings(null) },
  { id: "panel.search", group: "panel", shortcut: "Ctrl+F", run: (a) => a.openSearch() },
  { id: "panel.git", group: "panel", shortcut: "Ctrl+G", run: (a) => a.toggleGit() },
  { id: "panel.inspector", group: "panel", shortcut: "Ctrl+I", run: (a) => a.toggleInspector() },
  { id: "panel.sidebar", group: "panel", shortcut: "Ctrl+B", run: (a) => a.toggleSidebar() },
  { id: "panel.notifications", group: "panel", run: (a) => a.openNotifications() },
  { id: "panel.worktrees", group: "panel", requires: "project", run: (a) => a.openWorktrees() },
];

/** 会话类命令：作用于当前 Tab。 */
const SESSION_COMMANDS: readonly CommandSpec[] = [
  { id: "session.newTemporary", group: "session", run: (a) => a.newTemporarySession() },
  {
    id: "session.closeActive",
    group: "session",
    requires: "session",
    run: (a) => a.closeActiveSession(),
  },
  {
    id: "session.reopen",
    group: "session",
    requires: "session",
    run: (a) => a.reopenActiveSession(),
  },
  { id: "session.toggleTheme", group: "session", run: (a) => a.toggleTheme() },
];

/**
 * 系统类命令：不动会话内容，只改界面状态或复制路径。
 *
 * 「恢复默认布局」只有一条——设置页那一项（setting.system.resetLayout）：
 * 同一个动作出现两条同名命令会让用户不知道该选哪一条，也会让「同分按注册表顺序」
 * 的排序规则变得没有意义。
 */
const SYSTEM_COMMANDS: readonly CommandSpec[] = [
  { id: "system.copyDataDirectory", group: "system", run: (a) => a.copyDataDirectory() },
];

/** 逗号分隔的别名串 → 数组；解析规则与 settings/catalog.ts 的 keywordList 一致。 */
function keywordsOf(t: Translate, key: string): readonly string[] {
  return t(key)
    .split(",")
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
}

/**
 * 前提 → 不可用原因。
 *
 * 原因在**渲染时**才取文案（闭包捕获当前语言的 t），因此切换语言后
 * 面板里那句「当前没有打开的会话」也会跟着变。
 */
function unavailableFor(
  spec: CommandSpec,
  t: Translate,
): ((context: CommandContext) => string | null) | undefined {
  const requires = spec.requires;
  if (!requires) return undefined;
  const reasonKey =
    requires === "session" ? "commands.reason.needs.session" : "commands.reason.needs.project";
  return (context) => {
    const ready = requires === "session" ? context.hasActiveSession : context.hasProject;
    return ready ? null : t(reasonKey);
  };
}

/** spec + 当前语言的 t → 可以直接渲染的命令条目。 */
function toEntry(spec: CommandSpec, t: Translate): CommandEntry {
  const keys = commandKeys(spec.id);
  const entry: CommandEntry = {
    id: spec.id,
    title: t(keys.titleKey),
    group: spec.group,
    hint: t(keys.hintKey),
    keywords: keywordsOf(t, keys.keywordsKey),
    run: spec.run,
  };
  if (spec.shortcut) entry.shortcut = spec.shortcut;
  const unavailable = unavailableFor(spec, t);
  if (unavailable) entry.unavailable = unavailable;
  return entry;
}

/**
 * 设置类命令：每页一条「打开设置 · 某页」，每一项设置一条。
 *
 * 标题全部来自 settings/catalog.ts（与设置页的行标题同一份数据），
 * 这里不出现任何标题字面量。
 */
function settingsCommands(t: Translate): CommandEntry[] {
  const settingsKeyword = t("commands.keyword.settings");

  const tabs: CommandEntry[] = SETTINGS_TABS.map((meta) => {
    const tab = settingsTabView(meta, t);
    return {
      id: "settings.tab." + tab.id,
      title: t("commands.settings.open.tab", { tab: tab.label }),
      group: "settings",
      hint: tab.description,
      keywords: [settingsKeyword, tab.label, ...tab.keywords],
      run: (actions) => actions.openSettings(tab.id),
    };
  });

  const entries: CommandEntry[] = SETTINGS_ENTRIES.map((meta) => {
    const item = settingsEntryView(meta, t);
    const tabLabel = settingsTabView(settingsTab(item.tab), t).label;
    return {
      id: "setting." + item.id,
      title: item.label,
      group: "settings",
      hint: t("commands.settings.hint.tab", { tab: tabLabel }),
      keywords: [settingsKeyword, tabLabel, ...item.keywords],
      run: (actions) => actions.openSettings(item.tab),
    };
  });

  return [...tabs, ...entries];
}

/**
 * 全部命令，顺序即空查询时的展示顺序。
 *
 * 顺序的理由：面板开关最常用，其次是会话动作，然后是设置（页 → 项），最后是系统动作。
 * 每次调用都重新解析文案（代价是几十次查表），换来的是「切语言立刻生效」，
 * 不需要在 App.vue 里手工监听 locale 变化去重建注册表。
 */
export function buildCommands(t: Translate): readonly CommandEntry[] {
  return [
    ...PANEL_COMMANDS.map((spec) => toEntry(spec, t)),
    ...SESSION_COMMANDS.map((spec) => toEntry(spec, t)),
    ...settingsCommands(t),
    ...SYSTEM_COMMANDS.map((spec) => toEntry(spec, t)),
  ];
}

/** 供组件使用的命令上下文快照。 */
export function commandContext(facts: Partial<CommandContext> = {}): CommandContext {
  return {
    hasActiveSession: facts.hasActiveSession === true,
    hasProject: facts.hasProject === true,
  };
}

/** 面板键盘动作；"none" 表示不拦截，交给浏览器默认行为。 */
export type PaletteKeyAction =
  | "next"
  | "previous"
  | "first"
  | "last"
  | "execute"
  | "close"
  | "none";

/**
 * 按键 → 动作。
 *
 * 只认无修饰键的导航键：Ctrl/⌘ 组合留给应用级快捷键（Ctrl+K 是打开/关闭面板本身），
 * 面板内再抢一次会让「再按一次 Ctrl+K 关掉」失效。
 * Enter 例外——无论带不带修饰键都执行，因为面板里没有多行输入。
 */
export function paletteKeyAction(
  key: string,
  modifiers: { ctrl?: boolean; meta?: boolean; alt?: boolean } = {},
): PaletteKeyAction {
  if (key === "Enter") return "execute";
  if (key === "Escape") return "close";
  if (modifiers.ctrl || modifiers.meta || modifiers.alt) return "none";
  switch (key) {
    case "ArrowDown":
      return "next";
    case "ArrowUp":
      return "previous";
    case "Home":
      return "first";
    case "End":
      return "last";
    default:
      return "none";
  }
}

/**
 * 计算下一个高亮下标。
 *
 * 上下键首尾相接（到底部再按下回到第一条），这是命令面板的通用预期；
 * 列表为空时返回 -1，界面据此不设置 aria-activedescendant。
 */
export function nextActiveIndex(
  current: number,
  total: number,
  action: PaletteKeyAction,
): number {
  if (total <= 0) return -1;
  switch (action) {
    case "next":
      return current < 0 || current >= total - 1 ? 0 : current + 1;
    case "previous":
      return current <= 0 ? total - 1 : current - 1;
    case "first":
      return 0;
    case "last":
      return total - 1;
    default:
      return Math.min(Math.max(current, -1), total - 1);
  }
}

/** 过滤后把旧下标收敛到合法范围：输入变长时不要突然选中「不存在的第 8 条」。 */
export function clampActiveIndex(index: number, total: number): number {
  if (total <= 0) return -1;
  if (index < 0) return 0;
  return Math.min(index, total - 1);
}
