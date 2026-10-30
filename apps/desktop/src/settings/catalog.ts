/**
 * 设置项元数据目录（Issue #123 · TASK-031）。
 *
 * **唯一来源**：设置面板的行标题/说明与命令面板的设置类命令都从这里读，
 * 因此新增一项设置只需要改这个文件，不会出现「设置里叫这个名字、命令面板里叫另一个」。
 *
 * 分工：
 * - 选项档位（主题两档、字号四档…）仍在 theme/appearance.ts、settings/*.ts 里，
 *   这里只描述「这一项叫什么、属于哪一页、还能怎么搜到它」；
 * - 命令面板（components/CommandPalette.vue）通过 commands/registry.ts 消费本文件，
 *   不复制任何标题字符串；
 * - SettingsRow 按 id 取标题与说明，面板模板里不再写死中文标题。
 *
 * 边界：本文件不读存储、不发 IPC、不含任何凭据；纯常量 + 三个查表函数。
 */

/** 设置弹窗的四页，顺序即界面顺序（与原型一致）。 */
export type SettingsTabId = "appearance" | "session" | "extensions" | "system";

export interface SettingsTabMeta {
  id: SettingsTabId;
  /** 标签页可见文案。 */
  label: string;
  /** 一句话说明这一页管什么（命令面板的结果行用它做补充说明）。 */
  description: string;
  /** 额外搜索别名：英文、同义词、旧叫法。 */
  keywords: readonly string[];
}

/** 四个标签页；SettingsDialog 直接 v-for 渲染，不再自己维护一份数组。 */
export const SETTINGS_TABS: readonly SettingsTabMeta[] = Object.freeze([
  {
    id: "appearance",
    label: "外观",
    description: "主题、强调色、字号、字体与正文宽度",
    keywords: ["appearance", "theme", "外观", "主题", "颜色", "字体", "字号"],
  },
  {
    id: "session",
    label: "会话",
    description: "发送方式、工具输出、时间戳与思考强度",
    keywords: ["session", "会话", "发送", "thinking", "思考"],
  },
  {
    id: "extensions",
    label: "扩展",
    description: "扩展、技能与 MCP 服务列表",
    keywords: ["extensions", "extension", "扩展", "技能", "skill", "mcp"],
  },
  {
    id: "system",
    label: "系统",
    description: "更新、通知、托盘与数据目录",
    keywords: ["system", "系统", "更新", "通知", "托盘", "目录"],
  },
]);

export interface SettingsEntryMeta {
  /** 全局唯一 id，形如 tab.key（如 appearance.theme）；也是面板里的定位锚点。 */
  id: string;
  tab: SettingsTabId;
  /** 设置行的可见标题；SettingsRow 与命令面板共用。 */
  label: string;
  /** 默认说明文案；含动态值的行（当前版本 / 数据目录）由面板覆盖。 */
  description: string;
  /** 额外搜索别名。 */
  keywords: readonly string[];
}

/**
 * 全部设置项（20 项）。
 *
 * 顺序即「设置 → 该页」里的顺序；命令面板在空查询时按这个顺序展示。
 * 扩展页是静态列表（12 个扩展 + 技能 + MCP），没有独立设置行，因此这里没有它的条目。
 */
export const SETTINGS_ENTRIES: readonly SettingsEntryMeta[] = Object.freeze([
  // ── 外观 ────────────────────────────────────────────────────
  {
    id: "appearance.theme",
    tab: "appearance",
    label: "主题",
    description: "深色 / 浅色，切换时从视口中心圆形扩散",
    keywords: ["theme", "dark", "light", "深色", "浅色", "夜间"],
  },
  {
    id: "appearance.accent",
    tab: "appearance",
    label: "强调色",
    description: "选中、链接与主按钮同时跟随",
    keywords: ["accent", "color", "颜色", "主色", "蓝色", "紫色"],
  },
  {
    id: "appearance.fontSize",
    tab: "appearance",
    label: "界面字号",
    description: "会话正文跟随此设置",
    keywords: ["font", "size", "字号", "字体大小", "缩放"],
  },
  {
    id: "appearance.fontFamily",
    tab: "appearance",
    label: "界面字体",
    description: "Inter / 系统栈 / 衬线",
    keywords: ["font", "family", "字体", "衬线", "等宽", "inter"],
  },
  {
    id: "appearance.codeFont",
    tab: "appearance",
    label: "代码字体",
    description: "代码块与工具输出的等宽字体",
    keywords: ["code", "font", "mono", "代码", "等宽"],
  },
  {
    id: "appearance.contentWidth",
    tab: "appearance",
    label: "正文宽度",
    description: "会话正文与输入区的最大宽度",
    keywords: ["width", "layout", "宽度", "排版", "自适应"],
  },
  // ── 会话 ────────────────────────────────────────────────────
  {
    id: "session.sendAfterScroll",
    tab: "session",
    label: "发送后滚动",
    description: "新消息到达时自动贴底",
    keywords: ["scroll", "滚动", "贴底", "跟随"],
  },
  {
    id: "session.enterToSend",
    tab: "session",
    label: "Enter 发送",
    description: "关闭后用 ⌘/Ctrl+↵ 发送，Enter 换行",
    keywords: ["enter", "send", "发送", "换行", "回车"],
  },
  {
    id: "session.showToolCalls",
    tab: "session",
    label: "显示工具调用",
    description: "打开后工具输出块默认展开（默认折叠）",
    keywords: ["tool", "call", "工具", "输出", "折叠", "展开"],
  },
  {
    id: "session.showTimestamps",
    tab: "session",
    label: "消息时间戳",
    description: "在每条消息下方显示时间",
    keywords: ["timestamp", "time", "时间", "时间戳"],
  },
  {
    id: "session.thinkingLevel",
    tab: "session",
    label: "默认思考强度",
    description: "新会话的初始档位",
    keywords: ["thinking", "思考", "强度", "档位", "reasoning"],
  },
  {
    id: "session.busyDelivery",
    tab: "session",
    label: "忙碌时发送",
    description: "agent 忙碌时点发送的默认投递方式",
    keywords: ["busy", "delivery", "忙碌", "投递", "排队"],
  },
  {
    id: "session.clearSession",
    tab: "session",
    label: "清空当前会话",
    description: "释放界面内存中的消息缓存，重新从会话文件载入",
    keywords: ["clear", "cache", "清空", "缓存", "重载"],
  },
  // ── 系统 ────────────────────────────────────────────────────
  {
    id: "system.autoUpdate",
    tab: "system",
    label: "自动更新",
    description: "有新版时提示下载",
    keywords: ["update", "更新", "升级", "版本"],
  },
  {
    id: "system.notifyOnComplete",
    tab: "system",
    label: "任务完成通知",
    description: "合并、失败时弹系统通知",
    keywords: ["notify", "notification", "通知", "提醒", "完成"],
  },
  {
    id: "system.minimizeToTray",
    tab: "system",
    label: "关闭时最小化到托盘",
    description: "进程保留，托盘可恢复",
    keywords: ["tray", "托盘", "最小化", "关闭", "后台"],
  },
  {
    id: "system.updateCheck",
    tab: "system",
    label: "检查更新",
    description: "当前版本与更新通道状态",
    keywords: ["update", "check", "更新", "检查", "版本"],
  },
  {
    id: "system.resetLayout",
    tab: "system",
    label: "恢复默认布局",
    description: "侧栏 272px · 抽屉 320px",
    keywords: ["layout", "reset", "布局", "重置", "默认"],
  },
  {
    id: "system.dataDirectory",
    tab: "system",
    label: "数据目录",
    description: "应用数据目录路径（可复制）",
    keywords: ["data", "directory", "目录", "路径", "复制"],
  },
  {
    id: "system.about",
    tab: "system",
    label: "关于",
    description: "版本、平台与连接状态",
    keywords: ["about", "version", "关于", "版本", "平台"],
  },
]);

/** id → 元数据；模块加载时建一次，查表 O(1)。 */
const BY_ID = new Map<string, SettingsEntryMeta>(
  SETTINGS_ENTRIES.map((entry) => [entry.id, entry]),
);

/**
 * 按 id 取设置项元数据。
 *
 * 找不到时直接抛错而不是返回占位对象：把 id 拼错（appearance.foo 之类）必须在
 * 第一次渲染就炸掉（Node 测试也能断言），否则界面会安静地显示一个空标题。
 */
export function settingsEntry(id: string): SettingsEntryMeta {
  const entry = BY_ID.get(id);
  if (!entry) {
    throw new Error(
      "E_SETTINGS_ENTRY_MISSING: 没有这个设置项 id：" + id + "（见 settings/catalog.ts）",
    );
  }
  return entry;
}

/** 某一页的全部设置项；命令面板与设置页共用同一份顺序。 */
export function settingsEntriesFor(tab: SettingsTabId): readonly SettingsEntryMeta[] {
  return SETTINGS_ENTRIES.filter((entry) => entry.tab === tab);
}

/** 按 id 取标签页元数据；拼错同样直接抛错。 */
export function settingsTab(tab: SettingsTabId): SettingsTabMeta {
  const found = SETTINGS_TABS.find((candidate) => candidate.id === tab);
  if (!found) throw new Error("E_SETTINGS_TAB_MISSING: 没有这个设置页：" + tab);
  return found;
}
