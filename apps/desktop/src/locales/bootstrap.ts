/**
 * 启动时的语言引导（Issue #135）。
 *
 * 内置语言在 loader 加载时就已经生效，这里只处理一件事：
 * **上次选的是社区语言包**——它的内容在磁盘上，必须异步读回来。
 *
 * 读不到（文件被删、后端不可用）就回退简体中文，且**不覆盖**用户偏好：
 * 用户把语言包放回去后下次启动仍然是他选的语言。
 */

import { baseLocaleKeys, validateLocalePack } from "./community.ts";
import {
  FALLBACK_LOCALE,
  isBuiltinLocale,
  registerCommunityLocale,
  useLocale,
} from "./index.ts";
import { readLocalePreference } from "../settings/locale.ts";
import { defaultLocalePacks, type LocalePacksBridge } from "../services/localePacks.ts";

/**
 * 把持久化的语言偏好落地，返回最终生效的语言标签。
 *
 * 这个函数必须在挂载后调用（不能阻塞首帧）：先按内置语言渲染，
 * 社区包读回来再切一次，用户看到的只是文案替换，没有白屏。
 */
export async function startLocale(
  bridge: LocalePacksBridge = defaultLocalePacks(),
  preference: string | null = readLocalePreference(),
): Promise<string> {
  const runtime = useLocale();
  if (!preference) return runtime.locale.value;
  if (isBuiltinLocale(preference)) {
    // 内置语言不需要读盘；persist=false 是因为偏好本来就来自存储。
    await runtime.setLocale(preference, { persist: false });
    return runtime.locale.value;
  }

  try {
    const raw = await bridge.read(preference);
    const result = validateLocalePack({
      raw,
      tag: preference,
      baseKeys: baseLocaleKeys(),
    });
    if (result.ok) {
      registerCommunityLocale(result.tag, result.entries);
      await runtime.setLocale(result.tag);
      return result.tag;
    }
  } catch {
    // 语言包被删掉或后端不可用：静默回退，界面用简体中文继续工作。
  }
  await runtime.setLocale(FALLBACK_LOCALE, { persist: false });
  return FALLBACK_LOCALE;
}
