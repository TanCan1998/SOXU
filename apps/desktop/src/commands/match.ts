/**
 * 命令面板的搜索匹配（Issue #123 · TASK-031）。
 *
 * 纯逻辑，不碰 DOM、不碰 Vue：给定「命令标题 + 别名」和「用户输入」，
 * 返回分数与**命中字符在标题里的位置**，组件只负责渲染高亮。
 *
 * 三种匹配源（优先级从高到低）：
 * 1. 标题原文——中文直接按字匹配（打开设置 / 设置）；
 * 2. 全拼——da kai she zhi 连成 dakaishezhi，输入 dakai 或 shezhi 都能命中；
 * 3. 首字母——d k s z 连成 dksz，输入 dk 就能命中「打开设置」。
 *
 * 拼音引擎（pinyin-pro）由调用方注入，不在本模块静态 import：字典 141 KB gzip，
 * 放进首屏与「低内存、快启动」冲突，见 setPinyinProvider 的说明。
 *
 * 为什么首字母用 pinyin-pro 的 first 而不是 initial：initial 是声母（设 → sh、置 → zh），
 * 两个字就会占 2–3 个字符，"dk" 与 "sz" 虽然仍能按子序列命中，但位置映射会变得含糊；
 * first 恒为单个字母，与「一个汉字一个首字母」的心智模型一致。
 *
 * 已知边界：拼音与汉字混写（如 "dakai设置"）不会命中——全拼串里没有汉字，
 * 标题串里没有 "dakai"，两个来源各缺一半。纯英文 + 汉字（如 "enter发送"）则走标题
 * 子序列命中，因为汉字本来就在标题里。这条边界写在测试里，不假装支持。
 */

/** 标题里的高亮区间（按码点下标，end 不含）。 */
export interface HighlightRange {
  start: number;
  end: number;
}

/** 结果列表的 DOM 上界：命令总数远小于它，但仍然给一个明确上限。 */
export const MAX_RESULTS = 50;

/** pinyin-pro type:"all" 的逐字结果里我们用到的字段（只声明用到的，避免绑死内部类型）。 */
export interface PinyinChar {
  origin: string;
  pinyin: string;
  first: string;
  isZh: boolean;
}

/** 把「一段文本 → 逐字拼音」注入进来。 */
export type PinyinProvider = (text: string) => readonly PinyinChar[];

/**
 * 拼音引擎是可注入的，默认没有。
 *
 * 原因：pinyin-pro 的字典实测 576 KB 原始 / 173 KB gzip（见 docs/development/command-palette.md），
 * 放进首屏 bundle 与「低内存、快启动」的产品目标冲突。因此本模块不静态 import 它，
 * 由 CommandPalette 在**第一次打开面板时**动态 import 并注入；注入前只做标题字面匹配，
 * 注入后清空索引缓存并让结果重算一次。
 *
 * 副作用边界：注入是全局单例，但只有 CommandPalette 会写它，且写的是同一个函数，
 * 因此不需要「谁负责还原」的释放协议。
 */
let provider: PinyinProvider | null = null;

/** 注入（或清除）拼音引擎；清除同时清空索引缓存，避免旧索引把无拼音结果缓存下来。 */
export function setPinyinProvider(next: PinyinProvider | null): void {
  provider = next;
  INDEX_CACHE.clear();
}

/** 拼音引擎是否已就绪；未就绪时只按标题字面匹配。 */
export function pinyinReady(): boolean {
  return provider !== null;
}

/** 一条可搜索的串：text 用于比较，map[i] 是它第 i 个字符对应的标题码点下标。 */
interface Haystack {
  text: string;
  map: number[];
}

/** 一个标题的预计算结果；同一条命令只算一次。 */
export interface SearchIndex {
  /** 标题小写原文（与输入直接比较）。 */
  title: string;
  full: Haystack;
  initials: Haystack;
}

/**
 * 预计算缓存。
 *
 * 命令注册表是常量，标题不会变，所以理论上不会增长；仍然设上限，
 * 是因为将来若有人把「最近打开的会话标题」也做成命令，标题就是用户数据了。
 */
const INDEX_CACHE = new Map<string, SearchIndex>();
const INDEX_CACHE_LIMIT = 256;

const ALNUM = /[0-9a-z]/;

/** 取（或计算）一个标题的搜索索引。 */
export function searchIndex(title: string): SearchIndex {
  const cached = INDEX_CACHE.get(title);
  if (cached) return cached;

  const chars = [...title];
  const fullChars: string[] = [];
  const fullMap: number[] = [];
  const initialChars: string[] = [];
  const initialMap: number[] = [];

  const parts: readonly PinyinChar[] = provider ? provider(title) : [];

  // 按码点推进标题下标：pinyin-pro 逐「字」返回，一个 origin 可能含多个码点。
  let charIndex = 0;
  for (const part of parts) {
    const origin = part.origin ?? "";
    const originChars = [...origin];
    if (part.isZh) {
      const syllable = (part.pinyin ?? "").toLowerCase();
      for (const letter of syllable) {
        if (!ALNUM.test(letter)) continue;
        fullChars.push(letter);
        fullMap.push(charIndex);
      }
      const initial = (part.first ?? "").toLowerCase().slice(0, 1);
      if (initial && ALNUM.test(initial)) {
        initialChars.push(initial);
        initialMap.push(charIndex);
      }
    } else {
      // 英文 / 数字按原字符进入两个串；空格、标点（⌘、+、·）直接跳过，
      // 否则 "Ctrl+G" 的 "+" 会变成永远匹配不到的空隙。
      for (let offset = 0; offset < originChars.length; offset += 1) {
        const lower = (originChars[offset] ?? "").toLowerCase();
        if (!ALNUM.test(lower)) continue;
        fullChars.push(lower);
        fullMap.push(charIndex + offset);
        initialChars.push(lower);
        initialMap.push(charIndex + offset);
      }
    }
    charIndex += originChars.length;
  }

  const index: SearchIndex = {
    title: chars.join("").toLowerCase(),
    full: { text: fullChars.join(""), map: fullMap },
    initials: { text: initialChars.join(""), map: initialMap },
  };

  if (INDEX_CACHE.size >= INDEX_CACHE_LIMIT) INDEX_CACHE.clear();
  INDEX_CACHE.set(title, index);
  return index;
}

/**
 * 输入的归一化：小写 + 去掉所有空白。
 *
 * 去掉空白是为了让 "enter 发送" 里的空格不影响与 "entersend" 的比较；
 * 两个串本身都不含空白（见 searchIndex），所以去空白对它们是恒等变换。
 */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, "");
}

/** 子序列匹配：按顺序逐字符找，返回每个字符在 haystack 里的下标。 */
function subsequence(haystack: string, needle: string): number[] | null {
  const positions: number[] = [];
  let from = 0;
  for (const char of needle) {
    const at = haystack.indexOf(char, from);
    if (at < 0) return null;
    positions.push(at);
    from = at + 1;
  }
  return positions;
}

/**
 * 分数表。
 *
 * 只用于排序，不对外承诺具体数值；但顺序必须稳定：
 * 「标题精确 > 标题前缀 > 标题包含 > 全拼前缀 > 首字母前缀 > 别名 > 子序列」。
 * 输入 "dk" 时，四条「打开…」命令的分数相同，最终顺序由注册表顺序兜底，
 * 于是结果顺序在任何一次输入里都是确定的。
 */
const WEIGHTS = {
  titleExact: 1000,
  titlePrefix: 900,
  titleIncludes: 800,
  fullPrefix: 700,
  fullIncludes: 620,
  initialsPrefix: 560,
  initialsIncludes: 500,
  keywordExact: 460,
  keywordIncludes: 400,
  titleSubsequence: 320,
  fullSubsequence: 260,
  initialsSubsequence: 210,
} as const;

interface Candidate {
  score: number;
  /** 命中的源；title 的下标可以直接高亮，另两个要经过 map 映射。 */
  source: "title" | "full" | "initials";
  positions: number[];
}

/**
 * 子序列匹配的跨度上限。
 *
 * 不设上限时，短输入会命中一堆无关命令：输入 "git" 时「关闭时最小化到托盘」的
 * 全拼 g...i...t 也能凑出子序列。跨度（最后一个命中位置 - 第一个 + 1）超过
 * 「查询长度 × 4 且至少 8」就丢弃——宁可少一条噪声结果，也不让列表看起来像随机。
 */
const SPAN_FACTOR = 4;
const SPAN_FLOOR = 8;

function spanOf(positions: readonly number[]): number {
  if (positions.length === 0) return 0;
  const first = positions[0] ?? 0;
  const last = positions[positions.length - 1] ?? 0;
  return last - first + 1;
}

/** 跨度越大，说明命中的字符越散；每多一个字符扣 4 分，只影响同源内部排序。 */
function spanPenalty(positions: readonly number[], needleLength: number): number {
  return Math.max(0, spanOf(positions) - needleLength) * 4;
}

/** 子序列是否「够紧凑」；前缀/包含匹配天然紧凑，不需要这一步。 */
function withinSpan(positions: readonly number[], needleLength: number): boolean {
  return spanOf(positions) <= Math.max(SPAN_FLOOR, needleLength * SPAN_FACTOR);
}

function candidateFor(
  haystack: Haystack,
  query: string,
  source: "full" | "initials",
  weights: { prefix: number; includes: number; subsequence: number },
): Candidate | null {
  if (haystack.text.startsWith(query)) {
    const positions: number[] = [];
    for (let index = 0; index < query.length; index += 1) positions.push(index);
    return { score: weights.prefix, source, positions };
  }
  const includesAt = haystack.text.indexOf(query);
  if (includesAt >= 0) {
    const positions: number[] = [];
    for (let index = 0; index < query.length; index += 1) positions.push(includesAt + index);
    return { score: weights.includes, source, positions };
  }
  const positions = subsequence(haystack.text, query);
  if (!positions || !withinSpan(positions, query.length)) return null;
  return { score: weights.subsequence, source, positions };
}

/**
 * 把候选的命中位置映射回标题码点下标，并合并相邻区间。
 *
 * 合并是必要的：全拼 "dakai" 的 5 个位置映射到「打」「开」两个码点，
 * 不合并会渲染出 5 个 <mark>，视觉上变成碎裂的色块。
 */
function toRanges(candidate: Candidate, index: SearchIndex): HighlightRange[] {
  if (candidate.source === "title") {
    return mergeRanges(
      candidate.positions.map((position) => ({ start: position, end: position + 1 })),
    );
  }
  const haystack = candidate.source === "full" ? index.full : index.initials;
  return mergeRanges(
    candidate.positions.map((position) => {
      const charIndex = haystack.map[position] ?? 0;
      return { start: charIndex, end: charIndex + 1 };
    }),
  );
}

function mergeRanges(ranges: HighlightRange[]): HighlightRange[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const merged: HighlightRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

/** 一条命令的匹配结果；null 表示不匹配。 */
export interface CommandMatch {
  score: number;
  ranges: HighlightRange[];
}

/**
 * 计算一条命令与输入的匹配。
 *
 * keywords 只参与「能不能搜到」，不参与高亮——别名不在标题里，标不出来。
 * 因此别名命中的结果 ranges 为空数组，界面表现为「整行不标红」而不是标错位置。
 */
export function matchCommand(
  query: string,
  title: string,
  keywords: readonly string[] = [],
): CommandMatch | null {
  const needle = normalizeQuery(query);
  if (!needle) return { score: 0, ranges: [] };

  const index = searchIndex(title);
  let best: Candidate | null = null;

  // 标题原文：精确 / 前缀 / 包含 / 子序列。
  if (index.title === needle) {
    best = {
      score: WEIGHTS.titleExact,
      source: "title",
      positions: Array.from({ length: [...title].length }, (_, at) => at),
    };
  } else if (index.title.startsWith(needle)) {
    best = {
      score: WEIGHTS.titlePrefix,
      source: "title",
      positions: Array.from({ length: needle.length }, (_, at) => at),
    };
  } else {
    const includesAt = index.title.indexOf(needle);
    if (includesAt >= 0) {
      best = {
        score: WEIGHTS.titleIncludes,
        source: "title",
        positions: Array.from({ length: needle.length }, (_, at) => includesAt + at),
      };
    } else {
      const positions = subsequence(index.title, needle);
      if (positions && withinSpan(positions, needle.length)) {
        best = { score: WEIGHTS.titleSubsequence, source: "title", positions };
      }
    }
  }

  const full = candidateFor(index.full, needle, "full", {
    prefix: WEIGHTS.fullPrefix,
    includes: WEIGHTS.fullIncludes,
    subsequence: WEIGHTS.fullSubsequence,
  });
  if (full && (!best || full.score > best.score)) best = full;

  const initials = candidateFor(index.initials, needle, "initials", {
    prefix: WEIGHTS.initialsPrefix,
    includes: WEIGHTS.initialsIncludes,
    subsequence: WEIGHTS.initialsSubsequence,
  });
  if (initials && (!best || initials.score > best.score)) best = initials;

  if (best) {
    const penalty = spanPenalty(best.positions, needle.length);
    return { score: best.score - penalty, ranges: toRanges(best, index) };
  }

  // 别名：只判断「相等 / 包含」，不做子序列——别名本身很短，子序列几乎必然命中，
  // 会让 "sz" 这类输入意外匹配到一堆无关命令。
  for (const keyword of keywords) {
    const normalized = normalizeQuery(keyword);
    if (!normalized) continue;
    if (normalized === needle) return { score: WEIGHTS.keywordExact, ranges: [] };
    if (normalized.includes(needle)) return { score: WEIGHTS.keywordIncludes, ranges: [] };
  }

  return null;
}

/** 可被排序的最小命令形状：注册表条目与测试夹具都满足它。 */
export interface RankableCommand {
  id: string;
  title: string;
  keywords?: readonly string[];
}

/** 一条排序后的结果。 */
export interface RankedCommand<T extends RankableCommand> {
  command: T;
  score: number;
  ranges: HighlightRange[];
}

/** 排序结果与「一共匹配到多少条」（超过 MAX_RESULTS 时界面要如实说明）。 */
export interface RankResult<T extends RankableCommand> {
  results: RankedCommand<T>[];
  matched: number;
}

/**
 * 排序命令。
 *
 * 空输入返回注册表顺序的前 limit 条（面板打开时先给一份清单，而不是空白）；
 * 有输入时按分数降序，同分保持注册表顺序（sort 是稳定的，但这里显式用下标兜底，
 * 避免不同引擎的稳定性差异影响测试）。
 */
export function rankCommands<T extends RankableCommand>(
  commands: readonly T[],
  query: string,
  limit: number = MAX_RESULTS,
): RankResult<T> {
  const needle = normalizeQuery(query);
  if (!needle) {
    return {
      results: commands
        .slice(0, limit)
        .map((command) => ({ command, score: 0, ranges: [] })),
      matched: commands.length,
    };
  }

  const scored: Array<RankedCommand<T> & { order: number }> = [];
  commands.forEach((command, order) => {
    const match = matchCommand(needle, command.title, command.keywords ?? []);
    if (!match) return;
    scored.push({ command, score: match.score, ranges: match.ranges, order });
  });

  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.order - right.order;
  });

  return {
    results: scored.slice(0, limit).map(({ command, score, ranges }) => ({
      command,
      score,
      ranges,
    })),
    matched: scored.length,
  };
}

/** 标题切片：一段普通文本 + 一段命中文本，供模板直接 v-for 渲染。 */
export interface TitleSegment {
  text: string;
  hit: boolean;
}

/**
 * 按高亮区间把标题切成片段（码点安全，不破坏代理对）。
 *
 * 区间越界时只取交集，不抛错：高亮是装饰，不该因为一次映射偏差把整行渲染打断。
 */
export function highlightSegments(
  title: string,
  ranges: readonly HighlightRange[],
): TitleSegment[] {
  const chars = [...title];
  if (ranges.length === 0) return chars.length > 0 ? [{ text: chars.join(""), hit: false }] : [];

  const flags = new Array<boolean>(chars.length).fill(false);
  for (const range of ranges) {
    const start = Math.max(0, range.start);
    const end = Math.min(chars.length, range.end);
    for (let index = start; index < end; index += 1) flags[index] = true;
  }

  const segments: TitleSegment[] = [];
  for (let index = 0; index < chars.length; index += 1) {
    const hit = flags[index] === true;
    const last = segments[segments.length - 1];
    if (last && last.hit === hit) {
      last.text += chars[index];
      continue;
    }
    segments.push({ text: chars[index] ?? "", hit });
  }
  return segments;
}
