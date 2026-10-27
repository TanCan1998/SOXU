/**
 * 发布就绪性核验（版本 / 标识 / 图标 / 锁文件 / 策略 / 签名能力边界）。
 *
 * 设计取舍：
 * - 解析函数只接收文本与 Buffer，便于用固定夹具做单元测试，过程中不访问网络、不执行安装。
 * - 解析失败一律返回 null 或空集合，由评估函数转成 blocked，绝不静默当作通过。
 * - 结果区分 blocked / warn / unverified：缺少签名证书、缺少其它平台 Runner 属于
 *   unverified（未验证），不能被写成通过，也不应阻止本机可做的核验。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** 与 scripts/release.mjs、scripts/check-release-context.mjs 的 Tag 规则保持一致。 */
export const PRODUCT_VERSION_PATTERN = /^0\.\d+\.\d+(?:-rc\.\d+)?$/u;
export const DEFAULT_TAURI_IDENTIFIER = "com.tauri.dev";
export const ICON_HINT = "运行 pnpm icons:generate（源图 apps/desktop/assets/soxu-master.png）";

export const WORKSPACE_CRATES = Object.freeze([
  "apps/desktop/src-tauri/Cargo.toml",
  "crates/pi-protocol/Cargo.toml",
  "crates/agent-runtime/Cargo.toml",
  "crates/session-index/Cargo.toml",
  "crates/resource-monitor/Cargo.toml",
  "crates/git-worktree/Cargo.toml",
]);

export function stripQuotes(value) {
  return value.replace(/^['"]/u, "").replace(/['"]$/u, "");
}

/** 只读取 [package] 段，避免误命中 [workspace] 或依赖表。 */
function parseCargoSectionField(toml, key) {
  let section = "";
  for (const raw of String(toml).split(/\r?\n/u)) {
    const line = raw.trim();
    const header = /^\[([^\]]+)\]$/u.exec(line);
    if (header) {
      section = header[1];
      continue;
    }
    if (section !== "package") continue;
    const match = new RegExp("^" + key + "\\s*=\\s*\"([^\"]+)\"", "u").exec(line);
    if (match) return match[1];
  }
  return null;
}

export function parseCargoPackageVersion(toml) {
  return parseCargoSectionField(toml, "version");
}

export function parseCargoPackageName(toml) {
  return parseCargoSectionField(toml, "name");
}

/** Cargo.lock 中同名 crate 可能有多个版本，因此返回 Map<name, versions[]>。 */
export function parseCargoLockVersions(lockText) {
  const packages = new Map();
  let current = null;
  const push = (name, version) => {
    const known = packages.get(name);
    if (!known) packages.set(name, [version]);
    else if (!known.includes(version)) known.push(version);
  };
  for (const raw of String(lockText).split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === "[[package]]") {
      current = {};
      continue;
    }
    if (line.startsWith("[")) {
      current = null;
      continue;
    }
    if (!current) continue;
    const name = /^name\s*=\s*"([^"]+)"$/u.exec(line);
    if (name) current.name = name[1];
    const version = /^version\s*=\s*"([^"]+)"$/u.exec(line);
    if (version) current.version = version[1];
    if (current.name && current.version) {
      push(current.name, current.version);
      current = {};
    }
  }
  return packages;
}

/**
 * 解析 pnpm-lock.yaml 的 importers 段（只需要依赖名与 specifier）。
 * 返回 Map<importer, { dependencies, devDependencies, optionalDependencies }>。
 */
export function parsePnpmImporters(lockText) {
  const importers = new Map();
  const lines = String(lockText).split(/\r?\n/u);

  let current = null;
  let section = null;
  let entry = null;
  let inImporters = false;
  // 锁文件可能包含多个 YAML 文档，每个文档都可能带自己的 importers 段。
  for (const line of lines) {
    if (/^\S/u.test(line)) {
      inImporters = line.trim() === "importers:";
      if (!inImporters) {
        current = null;
        section = null;
        entry = null;
      }
      continue;
    }
    if (!inImporters || !line.trim()) continue;
    const importer = /^ {2}(\S.*?):(?:\s*\{\})?$/u.exec(line);
    if (importer) {
      current = { dependencies: new Map(), devDependencies: new Map(), optionalDependencies: new Map() };
      importers.set(stripQuotes(importer[1]), current);
      section = null;
      entry = null;
      continue;
    }
    if (!current) continue;
    const header = /^ {4}([a-zA-Z]+):$/u.exec(line);
    if (header) {
      section = header[1];
      entry = null;
      continue;
    }
    const key = /^ {6}(\S.*?):$/u.exec(line);
    if (key) {
      const map = current[section];
      if (!map) continue;
      entry = { specifier: null, version: null };
      map.set(stripQuotes(key[1]), entry);
      continue;
    }
    if (!entry) continue;
    const specifier = /^ {8}specifier:\s*(.+)$/u.exec(line);
    if (specifier) entry.specifier = stripQuotes(specifier[1].trim());
    const version = /^ {8}version:\s*(.+)$/u.exec(line);
    if (version) entry.version = stripQuotes(version[1].trim());
  }
  return importers;
}

/** 从文件名推断 Tauri 图标的期望格式与像素尺寸（128x128@2x.png 即 256x256）。 */
export function describeIconExpectation(relativePath) {
  const file = String(relativePath).split("/").pop() ?? "";
  const png = /^(\d+)x(\d+)(?:@(\d+)x)?\.png$/u.exec(file);
  if (png) {
    const scale = Number(png[3] ?? 1);
    return { kind: "png", width: Number(png[1]) * scale, height: Number(png[2]) * scale };
  }
  if (file.endsWith(".ico")) return { kind: "ico", width: null, height: null };
  if (file.endsWith(".icns")) return { kind: "icns", width: null, height: null };
  return { kind: "unknown", width: null, height: null };
}

/** 校验图标字节：PNG 必须尺寸匹配，ICO/ICNS 校验魔数，避免 0 字节占位文件算通过。 */
export function inspectIconBytes(bytes, expectation) {
  if (!bytes || bytes.length === 0) return { ok: false, detail: "文件缺失或为空" };
  if (expectation.kind === "png") {
    if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return { ok: false, detail: "不是 PNG" };
    if (bytes.length < 24) return { ok: false, detail: "PNG 头部不完整" };
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width !== expectation.width || height !== expectation.height) {
      return { ok: false, detail: "尺寸 " + width + "x" + height + "，期望 " + expectation.width + "x" + expectation.height };
    }
    return { ok: true, detail: width + "x" + height };
  }
  if (expectation.kind === "ico") {
    if (bytes.length < 6 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) {
      return { ok: false, detail: "不是有效 ICO" };
    }
    const count = bytes.readUInt16LE(4);
    return count > 0 ? { ok: true, detail: count + " 个子图" } : { ok: false, detail: "ICO 无子图" };
  }
  if (expectation.kind === "icns") {
    if (bytes.subarray(0, 4).toString("latin1") !== "icns") return { ok: false, detail: "不是有效 ICNS" };
    return { ok: true, detail: bytes.length + " 字节" };
  }
  return { ok: false, detail: "无法识别的图标格式" };
}

/** 只读取文件，不修改、不联网；缺失文件以 null 表示，交给评估函数判定。 */
export async function readReleaseInputs(root) {
  const read = (relative) => readFile(join(root, relative), "utf8");
  const readBytes = (relative) => readFile(join(root, relative));
  const tryRead = (relative) => read(relative).catch(() => null);
  const tryReadBytes = (relative) => readBytes(relative).catch(() => null);

  const tauriConfig = JSON.parse(await read("apps/desktop/src-tauri/tauri.conf.json"));
  const declaredIcons = tauriConfig.bundle?.icon ?? [];
  const icons = { declared: declaredIcons, files: {}, master: null };
  for (const relative of declaredIcons) {
    icons.files[relative] = await tryReadBytes(join("apps/desktop/src-tauri", relative));
  }
  icons.master = await tryReadBytes("apps/desktop/assets/soxu-master.png");

  const cargoMembers = {};
  for (const relative of WORKSPACE_CRATES) {
    cargoMembers[relative] = await tryRead(relative);
  }

  return {
    rootPackage: JSON.parse(await read("package.json")),
    desktopPackage: JSON.parse(await read("apps/desktop/package.json")),
    tauriConfig,
    desktopCargoToml: await read("apps/desktop/src-tauri/Cargo.toml"),
    cargoLock: await tryRead("Cargo.lock"),
    pnpmLock: await tryRead("pnpm-lock.yaml"),
    policy: JSON.parse(await read("automation/policy.json")),
    releaseWorkflow: await tryRead(".github/workflows/release.yml"),
    cargoMembers,
    icons,
    workspaceCrates: WORKSPACE_CRATES,
  };
}
