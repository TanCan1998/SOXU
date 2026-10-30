/**
 * 语言包的后端访问（Issue #135）。
 *
 * 单一 owner：**只有这个模块**调用语言包相关的 Tauri 命令，其它地方（设置页、
 * 启动引导）都通过这里注入的桥接对象访问，测试可以换成假实现。
 *
 * 为什么语言包不放在仓库、也不放在 localStorage：
 * - 不写仓库：社区翻译是用户数据，不能变成需要合并的代码；
 * - 不放 localStorage：清缓存/换 WebView 会丢，且用户看不见文件；
 * - 落在应用数据目录的 locales/ 下：更新应用不会覆盖，用户也能备份与分享。
 */

import { invoke } from "@tauri-apps/api/core";

import { isTauriRuntime } from "../workspace/bridge.ts";

/** 与 src-tauri/src/dto/extension.rs 的 LocalePackList 一一对应。 */
export interface LocalePackList {
  /** 语言包目录的绝对路径（设置页展示给用户）。 */
  directory: string;
  /** 已导入的语言标签，后端已排序。 */
  tags: string[];
}

export interface LocalePacksBridge {
  list(): Promise<LocalePackList>;
  /** 读取一个已导入语言包的原文。 */
  read(tag: string): Promise<string>;
  /** 写入（覆盖）一个语言包；tag 已由前端校验，后端仍会再校验一次。 */
  save(tag: string, json: string): Promise<void>;
  /** 删除一个语言包；返回是否真的删掉了。 */
  remove(tag: string): Promise<boolean>;
  /** 读取用户通过系统对话框选中的源文件（只允许 .json，且有大小上限）。 */
  readSource(path: string): Promise<string>;
}

export function createTauriLocalePacks(): LocalePacksBridge {
  return {
    list: () => invoke<LocalePackList>("list_locale_packs"),
    read: (tag) => invoke<string>("read_locale_pack", { tag }),
    save: (tag, json) => invoke<void>("save_locale_pack", { tag, json }),
    remove: (tag) => invoke<boolean>("delete_locale_pack", { tag }),
    readSource: (path) => invoke<string>("read_locale_source", { path }),
  };
}

/**
 * 浏览器预览下的桥接：每个方法都显式失败。
 * 不用假数据冒充成功——设置页会据此禁用「导入语言包」并说明原因。
 */
export function unavailableLocalePacks(reason: string): LocalePacksBridge {
  const fail = () => Promise.reject(new Error(reason));
  return {
    list: fail,
    read: fail,
    save: fail,
    remove: fail,
    readSource: fail,
  };
}

/** 默认桥接：桌面端走真实命令，浏览器预览走显式失败。 */
export function defaultLocalePacks(): LocalePacksBridge {
  return isTauriRuntime()
    ? createTauriLocalePacks()
    : unavailableLocalePacks("浏览器预览没有文件访问能力，语言包只能在桌面端导入");
}
