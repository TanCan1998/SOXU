/**
 * 发布 tag 的上下文规则（纯函数）。
 *
 * 为什么要抽出来：check-release-context.mjs 只在 GitHub Actions 里跑一次，
 * 逻辑写在脚本顶层就只能靠"真发一次版"验证。这里把「tag 允许指向哪个分支」
 * 和「四处版本是否与 tag 一致」做成可单测的纯函数，脚本只负责取 git/gh 数据。
 */
import { PRODUCT_VERSION_PATTERN } from "./release-manifest.mjs";

/** 预发布 tag：v0.x.y-rc.N。 */
export function isPreviewTag(tag) {
  return typeof tag === "string" && /-rc\.\d+$/u.test(tag);
}

/** 解析 v0.x.y / v0.x.y-rc.N；非法返回 null，绝不猜测。 */
export function parseReleaseTag(tag) {
  if (typeof tag !== "string" || !tag.startsWith("v")) return null;
  const version = tag.slice(1);
  if (!PRODUCT_VERSION_PATTERN.test(version)) return null;
  return { tag, version, preview: isPreviewTag(tag) };
}

/**
 * tag 允许指向的分支，按优先级排列。
 * - 正式 tag：只认发布分支（main 才能产出正式安装包）。
 * - 预发布 tag：允许多个来源——scripts/release.mjs 手动发 rc 时要求 main，
 *   看板「发布 preview」直接在集成分支（dev）打 tag。
 */
export function allowedBranches(tag, { releaseBranch = "main", integrationBranch = "dev" } = {}) {
  const parsed = parseReleaseTag(tag);
  if (!parsed) return [];
  const branches = [releaseBranch];
  if (parsed.preview && integrationBranch && integrationBranch !== releaseBranch) branches.push(integrationBranch);
  return branches;
}

/**
 * 清单里允许出现的版本。
 * - 正式 tag：必须与 tag 版本完全一致。
 * - 预发布 tag：既允许清单已经改成 0.x.y-rc.N（scripts/release.mjs 的手动发版），
 *   也允许清单仍是基线 0.x.y（看板「发布 preview」不改编产品版本，只给快照打 tag）。
 *   两种情况下四处清单本身仍必须彼此一致。
 */
function acceptedVersions(parsed) {
  if (!parsed.preview) return [parsed.version];
  return [parsed.version, parsed.version.replace(/-rc\.\d+$/u, "")];
}

/**
 * 四处版本声明必须与 tag 语义务相符；返回不一致明细（空数组表示通过），不抛错，
 * 由调用方决定是打印还是失败。
 */
export function versionMismatches(tag, { rootVersion, desktopVersion, tauriVersion, cargoVersion } = {}) {
  const parsed = parseReleaseTag(tag);
  if (!parsed) return [{ file: "tag", expected: "v0.x.y 或 v0.x.y-rc.N", actual: String(tag) }];
  const accepted = acceptedVersions(parsed);
  const declared = [
    ["package.json", rootVersion],
    ["apps/desktop/package.json", desktopVersion],
    ["apps/desktop/src-tauri/tauri.conf.json", tauriVersion],
    ["apps/desktop/src-tauri/Cargo.toml", cargoVersion],
  ];
  return declared
    .filter(([, value]) => !accepted.includes(value))
    .map(([file, value]) => ({ file, expected: accepted.join(" 或 "), actual: value ?? null }));
}
