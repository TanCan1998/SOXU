/**
 * 「添加项目」的系统目录选择逻辑。
 *
 * 只做两件事：把 dialog 插件的返回值规整成可登记路径，并把「用户取消」和
 * 「当前环境打不开选择器」区分开——取消必须无副作用、无错误提示。
 * 选中之后走与其他入口同一条项目登记流程，避免两份逻辑漂移。
 *
 * 打开对话框的函数通过参数注入，所以这段逻辑能在 Node 里直接测试，
 * 不需要 Tauri 运行时。
 */

/** 传给 tauri-plugin-dialog 的选项：只要单个目录，不要文件。 */
export type DirectoryDialogOptions = {
  directory: true;
  multiple: false;
  title: string;
};

/** 与 `@tauri-apps/plugin-dialog` 的 `open` 同形的窄接口。 */
export type OpenDirectoryDialog = (
  options: DirectoryDialogOptions,
) => Promise<string | string[] | null>;

export const PROJECT_DIRECTORY_DIALOG_TITLE = "选择项目目录";

/**
 * 选择器结果。只有 `picked` 带路径；`cancelled` 与 `unavailable`
 * 都要求调用方保持界面与已登记项目不变（Issue #100 后「添加项目」只走选择器，
 * 取消就是一次纯粹的「什么都没发生」）。
 */
export type DirectoryPickOutcome =
  | { status: "picked"; path: string }
  | { status: "cancelled" }
  | { status: "unavailable"; reason: string };

/** 只接受非空字符串；数组和纯空白路径都视作没选。 */
export function normalizePickedDirectory(
  selected: string | string[] | null | undefined,
): string | null {
  const candidate = Array.isArray(selected) ? selected[0] : selected;
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function pickProjectDirectory(
  openDirectory: OpenDirectoryDialog,
): Promise<DirectoryPickOutcome> {
  let selected: string | string[] | null;
  try {
    selected = await openDirectory({
      directory: true,
      multiple: false,
      title: PROJECT_DIRECTORY_DIALOG_TITLE,
    });
  } catch (error) {
    // 插件缺失、权限未授予或窗口已销毁都会走到这里：报出来比静默失败好排查。
    return { status: "unavailable", reason: describeError(error) };
  }
  const path = normalizePickedDirectory(selected);
  return path === null ? { status: "cancelled" } : { status: "picked", path };
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return "系统目录选择器不可用";
}
