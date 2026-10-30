/**
 * 命令注册表（Issue #123 · TASK-031）。
 *
 * 一份数据 + 一个动作接口：注册表不认识 Vue、不认识 store，也不做 IO，
 * 执行时由 App.vue 注入 CommandActions。于是「有哪些命令、能不能用、执行什么」
 * 全部可以在 Node 里用假 actions 断言，不需要挂载组件。
 *
 * 两条纪律：
 * 1. **只登记真实存在的动作**。终端面板与文件打开在本切片都还没有实现，
 *    因此注册表里没有「打开终端 / 打开文件」——宁可少一条，也不放一条点了没反应的命令
 *    （见 docs/development/command-palette.md 的「未覆盖」一节）。
 * 2. **设置类命令由 settings/catalog.ts 生成**，不在这里复制标题：
 *    新增一项设置，命令面板自动多一条可搜索项。
 */

import {
  SETTINGS_ENTRIES,
  SETTINGS_TABS,
  settingsTab,
  type SettingsTabId,
} from "../settings/catalog.ts";

/** 结果分组；只用于界面上的小标签，不改变排序（排序见 commands/match.ts）。 */
export type CommandGroup = "面板" | "会话" | "设置" | "系统";

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
  /** 结果行主文案，也是搜索与高亮的对象。 */
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

const NEEDS_SESSION = "当前没有打开的会话";
const NEEDS_PROJECT = "还没有登记项目";

/** 面板类命令：都是右侧面板 / 浮层的开关，与顶栏按钮一一对应。 */
const PANEL_COMMANDS: readonly CommandEntry[] = [
  {
    id: "panel.settings",
    title: "打开设置",
    group: "面板",
    hint: "设置",
    keywords: ["settings", "preferences", "设置", "配置", "偏好"],
    shortcut: "Ctrl+,",
    run: (actions) => actions.openSettings(null),
  },
  {
    id: "panel.search",
    title: "打开会话搜索",
    group: "面板",
    hint: "搜索",
    keywords: ["search", "find", "搜索", "查找", "会话内搜索"],
    shortcut: "Ctrl+F",
    run: (actions) => actions.openSearch(),
  },
  {
    id: "panel.git",
    title: "打开 Git 面板",
    group: "面板",
    hint: "更改",
    keywords: ["git", "diff", "更改", "提交", "源代码", "版本"],
    shortcut: "Ctrl+G",
    run: (actions) => actions.toggleGit(),
  },
  {
    id: "panel.inspector",
    title: "打开会话状态",
    group: "面板",
    hint: "运行时",
    keywords: ["inspector", "status", "状态", "运行时", "检查器", "内存"],
    shortcut: "Ctrl+I",
    run: (actions) => actions.toggleInspector(),
  },
  {
    id: "panel.sidebar",
    title: "切换侧栏",
    group: "面板",
    hint: "项目与会话列表",
    keywords: ["sidebar", "侧栏", "项目", "会话列表", "折叠"],
    shortcut: "Ctrl+B",
    run: (actions) => actions.toggleSidebar(),
  },
  {
    id: "panel.notifications",
    title: "打开通知历史",
    group: "面板",
    hint: "通知",
    keywords: ["notification", "通知", "历史", "提醒", "未读"],
    run: (actions) => actions.openNotifications(),
  },
  {
    id: "panel.worktrees",
    title: "打开工作树面板",
    group: "面板",
    hint: "Git 工作树",
    keywords: ["worktree", "工作树", "分支", "隔离"],
    unavailable: (context) => (context.hasProject ? null : NEEDS_PROJECT),
    run: (actions) => actions.openWorktrees(),
  },
];

/** 会话类命令：作用于当前 Tab。 */
const SESSION_COMMANDS: readonly CommandEntry[] = [
  {
    id: "session.newTemporary",
    title: "新建临时会话",
    group: "会话",
    hint: "不进历史",
    keywords: ["new", "temp", "temporary", "新建", "临时", "新会话"],
    run: (actions) => actions.newTemporarySession(),
  },
  {
    id: "session.closeActive",
    title: "关闭当前会话",
    group: "会话",
    hint: "关闭标签",
    keywords: ["close", "关闭", "标签", "结束"],
    unavailable: (context) => (context.hasActiveSession ? null : NEEDS_SESSION),
    run: (actions) => actions.closeActiveSession(),
  },
  {
    id: "session.reopen",
    title: "重新打开当前会话",
    group: "会话",
    hint: "重新载入消息",
    keywords: ["retry", "reopen", "重试", "重新打开", "刷新", "重载"],
    unavailable: (context) => (context.hasActiveSession ? null : NEEDS_SESSION),
    run: (actions) => actions.reopenActiveSession(),
  },
  {
    id: "session.toggleTheme",
    title: "切换主题",
    group: "会话",
    hint: "深色 / 浅色",
    keywords: ["theme", "dark", "light", "主题", "深色", "浅色", "夜间"],
    run: (actions) => actions.toggleTheme(),
  },
];

/**
 * 系统类命令：不动会话内容，只改界面状态或复制路径。
 *
 * 「恢复默认布局」只有一条——设置页那一项（setting.system.resetLayout）：
 * 同一个动作出现两条同名命令会让用户不知道该选哪一条，也会让「同分按注册表顺序」
 * 的排序规则变得没有意义。
 */
const SYSTEM_COMMANDS: readonly CommandEntry[] = [
  {
    id: "system.copyDataDirectory",
    title: "复制数据目录路径",
    group: "系统",
    hint: "剪贴板",
    keywords: ["copy", "data", "directory", "复制", "目录", "路径"],
    run: (actions) => actions.copyDataDirectory(),
  },
];

/**
 * 设置类命令：每页一条「打开设置 · 某页」，每一项设置一条。
 *
 * 标题全部来自 settings/catalog.ts（与设置页的行标题同一份数据），
 * 这里不出现任何中文标题字面量。
 */
function settingsCommands(): CommandEntry[] {
  const tabs: CommandEntry[] = SETTINGS_TABS.map((tab) => ({
    id: "settings.tab." + tab.id,
    title: "打开设置 · " + tab.label,
    group: "设置",
    hint: tab.description,
    keywords: ["settings", "设置", tab.label, ...tab.keywords],
    run: (actions) => actions.openSettings(tab.id),
  }));

  const entries: CommandEntry[] = SETTINGS_ENTRIES.map((entry) => {
    const tabLabel = settingsTab(entry.tab).label;
    return {
      id: "setting." + entry.id,
      title: entry.label,
      group: "设置",
      hint: "设置 · " + tabLabel,
      keywords: ["settings", "设置", tabLabel, ...entry.keywords],
      run: (actions) => actions.openSettings(entry.tab),
    };
  });

  return [...tabs, ...entries];
}

/**
 * 全部命令，顺序即空查询时的展示顺序。
 *
 * 顺序的理由：面板开关最常用，其次是会话动作，然后是设置（页 → 项），最后是系统动作。
 */
export const COMMANDS: readonly CommandEntry[] = Object.freeze([
  ...PANEL_COMMANDS,
  ...SESSION_COMMANDS,
  ...settingsCommands(),
  ...SYSTEM_COMMANDS,
]);

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
