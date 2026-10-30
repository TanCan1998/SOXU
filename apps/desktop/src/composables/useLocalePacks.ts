/**
 * 设置 → 扩展 → 语言包的状态（Issue #135）。
 *
 * 职责边界：
 * - 校验在 locales/community.ts（纯函数，Node 可测）；
 * - 落盘在 services/localePacks.ts（唯一调用 Tauri 命令的地方）；
 * - 这里只做「读列表 / 切换 / 导入 / 移除」的编排与用户可读提示。
 *
 * 失败一律变成 notice 里的具体原因，不静默吞掉：用户导入失败时必须知道
 * 是 JSON 不合法、key 不对、还是标签重复。
 */

import { ref } from "vue";

import { baseLocaleKeys, validateLocalePack } from "../locales/community.ts";
import {
  isBuiltinLocale,
  localeLabel,
  registerCommunityLocale,
  unregisterCommunityLocale,
  useLocale,
} from "../locales/index.ts";
import { defaultLocalePacks, type LocalePacksBridge } from "../services/localePacks.ts";

export interface LocaleNotice {
  tone: "ok" | "error";
  text: string;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useLocalePacks(bridge: LocalePacksBridge = defaultLocalePacks()) {
  const { t, locale } = useLocale();
  const tags = ref<string[]>([]);
  const directory = ref("");
  const busy = ref(false);
  const notice = ref<LocaleNotice | null>(null);

  async function refresh(): Promise<void> {
    try {
      const list = await bridge.list();
      tags.value = [...list.tags];
      directory.value = list.directory;
    } catch (error) {
      notice.value = { tone: "error", text: reasonOf(error) };
    }
  }

  /** 切换语言；返回是否成功（失败时 notice 里有原因）。 */
  async function activate(tag: string): Promise<boolean> {
    if (tag === locale.value) return true;
    if (isBuiltinLocale(tag)) {
      await applyLocale(tag);
      return true;
    }
    try {
      const raw = await bridge.read(tag);
      const result = validateLocalePack({ raw, tag, baseKeys: baseLocaleKeys() });
      if (!result.ok) {
        notice.value = {
          tone: "error",
          text: t("settings.locale.failed", { reason: result.problems.join("；") }),
        };
        return false;
      }
      registerCommunityLocale(result.tag, result.entries);
      await applyLocale(result.tag);
      return true;
    } catch (error) {
      notice.value = {
        tone: "error",
        text: t("settings.locale.failed", { reason: reasonOf(error) }),
      };
      return false;
    }
  }

  /** 切语言 + 给成功提示：两处调用共用，避免提示文案漂移。 */
  async function applyLocale(tag: string): Promise<void> {
    await useLocale().setLocale(tag);
    notice.value = {
      tone: "ok",
      text: t("settings.locale.switched", { label: localeLabel(tag) }),
    };
  }

  /**
   * 导入用户选中的语言包文件。
   * 保存的是**原文**（已通过校验），这样译者自己的排版与顺序不会被打乱。
   */
  async function importFromFile(path: string): Promise<boolean> {
    if (busy.value) return false;
    busy.value = true;
    try {
      const raw = await bridge.readSource(path);
      const fileName = path.split(/[\\/]/u).pop() ?? "";
      const result = validateLocalePack({
        raw,
        fileName,
        baseKeys: baseLocaleKeys(),
      });
      if (!result.ok) {
        notice.value = {
          tone: "error",
          text: t("settings.locale.failed", { reason: result.problems.join("；") }),
        };
        return false;
      }
      await bridge.save(result.tag, raw);
      registerCommunityLocale(result.tag, result.entries);
      await refresh();
      notice.value = {
        tone: "ok",
        text: t("settings.locale.imported.ok", {
          tag: result.tag,
          count: Object.keys(result.entries).length,
        }),
      };
      return true;
    } catch (error) {
      notice.value = {
        tone: "error",
        text: t("settings.locale.failed", { reason: reasonOf(error) }),
      };
      return false;
    } finally {
      busy.value = false;
    }
  }

  /** 移除导入的语言包：文件与内存注册一起清掉，正在用就先回退。 */
  async function remove(tag: string): Promise<void> {
    if (busy.value) return;
    busy.value = true;
    try {
      const removed = await bridge.remove(tag);
      if (!removed) {
        notice.value = {
          tone: "error",
          text: t("settings.locale.failed", { reason: tag + " 不在语言包目录里" }),
        };
        return;
      }
      await unregisterCommunityLocale(tag);
      await refresh();
      notice.value = { tone: "ok", text: t("settings.locale.removed", { tag }) };
    } catch (error) {
      notice.value = {
        tone: "error",
        text: t("settings.locale.failed", { reason: reasonOf(error) }),
      };
    } finally {
      busy.value = false;
    }
  }

  function dismissNotice(): void {
    notice.value = null;
  }

  return { tags, directory, busy, notice, refresh, activate, importFromFile, remove, dismissNotice };
}
