/**
 * 复制到剪贴板（Issue #111 · V4-S1）。
 *
 * 消息操作里的「复制」必须是真实现：先走 `navigator.clipboard`，不可用
 * （非安全上下文、权限被拒、旧 WebView）时退回 `document.execCommand("copy")`。
 * 两个依赖都可注入，Node 测试里不需要浏览器。
 */

export interface ClipboardTarget {
  writeText(text: string): Promise<void>;
}

export interface ClipboardDeps {
  /** 显式注入的剪贴板实现；传 null 表示"环境没有 navigator.clipboard"。 */
  clipboard?: ClipboardTarget | null;
  /** 显式注入的兜底实现（返回是否成功）。 */
  fallback?: (text: string) => boolean;
}

function defaultClipboard(): ClipboardTarget | null {
  const clipboard = (globalThis as { navigator?: { clipboard?: ClipboardTarget } }).navigator
    ?.clipboard;
  return clipboard ?? null;
}

/**
 * 兜底复制：临时 textarea + execCommand。
 * 只在这里读写 DOM，失败一律返回 false，绝不抛错到调用方。
 */
function domFallback(text: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
  const holder = document.createElement("textarea");
  holder.value = text;
  holder.setAttribute("readonly", "");
  holder.style.position = "fixed";
  holder.style.top = "-1000px";
  holder.style.opacity = "0";
  document.body.appendChild(holder);
  try {
    holder.select();
    return document.execCommand("copy");
  } finally {
    holder.remove();
  }
}

/** 复制文本，返回是否成功（调用方据此显示「已复制」或失败提示）。 */
export async function copyText(text: string, deps: ClipboardDeps = {}): Promise<boolean> {
  const clipboard = deps.clipboard === undefined ? defaultClipboard() : deps.clipboard;
  if (clipboard) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // 权限被拒/非安全上下文：落到 execCommand 兜底，而不是直接判失败。
    }
  }
  const fallback = deps.fallback ?? domFallback;
  try {
    return fallback(text);
  } catch {
    return false;
  }
}
