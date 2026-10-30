/**
 * 语言包文件的顶层键扫描（Issue #135）。
 *
 * 单独成文件、**不 import 任何东西**，因此既能被前端（locales/community.ts）
 * 使用，也能被 CI 脚本 scripts/check-locales.mjs 直接 import：
 * 同一份「重复 key」判定只写一次，不会出现两处规则漂移。
 */

export interface TopLevelKeyScan {
  /** 顶层键，按出现顺序。 */
  keys: string[];
  /** 重复出现的键（JSON.parse 会静默取最后一个，必须自己扫）。 */
  duplicates: string[];
  /** 结构性问题（字符串没闭合等）；null 表示扫描本身没出错。 */
  error: string | null;
}

/**
 * 扫出 JSON 顶层的键，并找出重复键。
 *
 * 只记深度 1 的字符串键，不构造完整对象：语言包都很小，但这里是
 * 「用户给什么就扫什么」的入口，保持线性且不递归更安全。
 */
export function scanTopLevelKeys(raw: string): TopLevelKeyScan {
  const keys: string[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();
  let depth = 0;
  let index = 0;
  let previousSignificant = "";

  while (index < raw.length) {
    const char = raw[index];
    if (char === '"') {
      let end = index + 1;
      let escaped = false;
      while (end < raw.length) {
        const current = raw[end];
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === '"') break;
        end += 1;
      }
      if (end >= raw.length) return { keys, duplicates, error: "字符串没有闭合" };
      const literal = raw.slice(index, end + 1);
      // 深度 1 且前一个有效字符是 { 或 , 时，这个字符串是顶层键而不是值。
      if (depth === 1 && (previousSignificant === "{" || previousSignificant === ",")) {
        let text: string;
        try {
          text = JSON.parse(literal) as string;
        } catch {
          return { keys, duplicates, error: "键名不是合法的 JSON 字符串" };
        }
        if (seen.has(text)) duplicates.push(text);
        else seen.add(text);
        keys.push(text);
      }
      previousSignificant = '"';
      index = end + 1;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
      previousSignificant = char;
    } else if (char === "}" || char === "]") {
      depth -= 1;
      previousSignificant = char;
    } else if (char !== " " && char !== "\n" && char !== "\r" && char !== "\t") {
      previousSignificant = char;
    }
    index += 1;
  }
  return { keys, duplicates, error: null };
}
