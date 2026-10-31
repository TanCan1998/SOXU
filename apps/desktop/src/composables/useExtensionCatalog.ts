/**
 * 设置 → 扩展的只读状态（Issue #147）。
 *
 * 职责边界：
 * - 扫描与白名单在 Rust 的 crate::extension_catalog（前端传不了路径）；
 * - IPC 在 services/extensions.ts（唯一调用扩展命令的地方）；
 * - 这里只做「加载 / 失败 / 空」三态与技能详情的按需展开。
 *
 * 失败一律保留后端给出的具体原因（目录不存在、JSON 写坏……），
 * 绝不把失败变成空列表：那会让用户以为本机没装任何扩展。
 *
 * 没有定时器、没有监听器：catalog 与详情缓存都由本 composable 持有，
 * 组件卸载即结束，不需要额外的释放路径。
 */

import { ref, shallowRef } from "vue";

import { defaultExtensions, type ExtensionCatalog, type ExtensionDetail, type ExtensionsBridge } from "../services/extensions.ts";

export type CatalogStatus = "loading" | "ready" | "error";

/** 一条技能的详情状态：按需展开时才产生。 */
export interface DetailState {
  loading: boolean;
  detail: ExtensionDetail | null;
  error: string | null;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useExtensionCatalog(bridge: ExtensionsBridge = defaultExtensions()) {
  /** 首次进入即处于 loading：组件挂载后立刻发起读取，不会闪一帧空列表。 */
  const status = ref<CatalogStatus>("loading");
  /** shallowRef：清单里可能有上百条带长描述，深响应式代理没有必要。 */
  const catalog = shallowRef<ExtensionCatalog | null>(null);
  const error = ref<string | null>(null);
  const expanded = ref<string[]>([]);
  const details = shallowRef<Record<string, DetailState>>({});

  async function refresh(): Promise<void> {
    status.value = "loading";
    error.value = null;
    // 刷新后旧的详情可能已经过期（技能被删/改名），一并清掉。
    details.value = {};
    expanded.value = [];
    try {
      catalog.value = await bridge.list();
      status.value = "ready";
    } catch (reason) {
      catalog.value = null;
      error.value = reasonOf(reason);
      status.value = "error";
    }
  }

  function isExpanded(id: string): boolean {
    return expanded.value.includes(id);
  }

  function detailOf(id: string): DetailState | null {
    return details.value[id] ?? null;
  }

  function setDetail(id: string, state: DetailState): void {
    details.value = { ...details.value, [id]: state };
  }

  /** 展开 / 收起一条技能；详情只取一次，失败后再次展开会重试。 */
  async function toggleDetail(id: string): Promise<void> {
    if (isExpanded(id)) {
      expanded.value = expanded.value.filter((item) => item !== id);
      return;
    }
    expanded.value = [...expanded.value, id];
    const cached = detailOf(id);
    if (cached?.detail) return;
    setDetail(id, { loading: true, detail: null, error: null });
    try {
      const detail = await bridge.detail(id);
      setDetail(id, { loading: false, detail, error: null });
    } catch (reason) {
      setDetail(id, { loading: false, detail: null, error: reasonOf(reason) });
    }
  }

  return { status, catalog, error, expanded, details, refresh, isExpanded, detailOf, toggleDetail };
}
