/**
 * 选项档位的界面文案（Issue #145）。
 *
 * 背景：主题两档、字号四档、强调色六色…这些表定义在 theme/appearance.ts 与
 * settings/*.ts，是**纯数据**，被大量测试与持久化逻辑引用；Issue #145 只要求
 * 「界面文案跟随语言」，因此这里做一层「显示时查表」：
 *
 * - 语言包里有 key（settings.option.<组>.<值>）→ 用语言包的文案；
 * - 没有（社区语言包只翻了一部分）→ 回退数据表里的 label，界面不会出现空白。
 *
 * 为什么不直接把表改成 key：表被持久化校验与几十条断言当作「档位事实」使用，
 * 换成 key 会把纯数据变成需要 t 的 UI 结构，回退链也会消失。
 */

import { camelToKey, type Translate } from "./catalog.ts";

/** 取一条选项文案：语言包优先，缺 key 时回退数据表里的字面量。 */
export function optionText(t: Translate, key: string, fallback: string): string {
  const text = t(key);
  // t() 在两边都没有时原样返回 key——这正是「缺 key」的可靠信号。
  return text === key ? fallback : text;
}

export interface LabeledOption {
  value: string;
  label: string;
}

export interface DescribedOption extends LabeledOption {
  description: string;
}

/**
 * 只带 label 的选项表（字号、字体、宽度、强调色…）。
 *
 * prefix 是合并后的 key 前缀，例如 "settings.option.accent"，
 * 具体档位用 value 拼上去：settings.option.accent.blue。
 * value 与 id 一样可能是驼峰（followUp），因此走同一个 camelToKey 转换。
 */
export function localizedOptions<T extends LabeledOption>(
  options: readonly T[],
  t: Translate,
  prefix: string,
): Array<T & { label: string }> {
  return options.map((option) => ({
    ...option,
    label: optionText(t, optionKey(prefix, option.value), option.label),
  }));
}

/** 档位值 → 语言包 key（settings.option.busy.delivery + followUp → …follow.up）。 */
export function optionKey(prefix: string, value: string): string {
  return prefix + "." + camelToKey(value);
}

/** label + description 的选项表（思考强度、忙碌时发送）。 */
export function localizedDescribedOptions<T extends DescribedOption>(
  options: readonly T[],
  t: Translate,
  prefix: string,
): Array<T & { label: string; description: string }> {
  return options.map((option) => ({
    ...option,
    label: optionText(t, optionKey(prefix, option.value), option.label),
    description: optionText(
      t,
      optionKey(prefix, option.value) + ".description",
      option.description,
    ),
  }));
}
