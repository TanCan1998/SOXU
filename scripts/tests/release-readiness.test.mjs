import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  describeIconExpectation,
  inspectIconBytes,
  parseCargoLockVersions,
  parseCargoPackageName,
  parseCargoPackageVersion,
  parsePnpmImporters,
  readReleaseInputs,
} from "../lib/release-manifest.mjs";
import { evaluateReleaseReadiness, renderReport } from "../lib/release-readiness.mjs";

const png = (width, height) => {
  const buffer = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "latin1");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
};
const ico = () => {
  const buffer = Buffer.alloc(6);
  buffer.writeUInt16LE(0, 0);
  buffer.writeUInt16LE(1, 2);
  buffer.writeUInt16LE(6, 4);
  return buffer;
};
const icns = () => Buffer.from("icns00000010test", "latin1");

const CARGO_TOML = [
  "[package]",
  'name = "soxu-desktop"',
  'version = "0.1.0"',
  'edition = "2024"',
  "",
  "[workspace.package]",
  'version = "9.9.9"',
  "",
  "[dependencies]",
  'tauri = { version = "=2.12.5" }',
].join("\n");

function baseInputs() {
  return {
    rootPackage: { version: "0.1.0" },
    desktopPackage: {
      version: "0.1.0",
      dependencies: { vue: "3.5.44" },
      devDependencies: { vite: "8.3.5" },
    },
    tauriConfig: {
      version: "0.1.0",
      productName: "SOXU",
      identifier: "dev.soxu.desktop",
      bundle: { active: true, targets: "all", icon: ["icons/32x32.png", "icons/icon.ico", "icons/icon.icns"] },
    },
    desktopCargoToml: CARGO_TOML,
    cargoLock: [
      "[[package]]",
      'name = "soxu-desktop"',
      'version = "0.1.0"',
      "",
      "[[package]]",
      'name = "soxu-agent-runtime"',
      'version = "0.1.0"',
    ].join("\n"),
    pnpmLock: [
      "lockfileVersion: '9.0'",
      "",
      "importers:",
      "",
      "  .: {}",
      "",
      "  apps/desktop:",
      "    dependencies:",
      "      vue:",
      "        specifier: 3.5.44",
      "        version: 3.5.44(typescript@6.0.3)",
      "    devDependencies:",
      "      vite:",
      "        specifier: 8.3.5",
      "        version: 8.3.5(jiti@2.7.0)",
      "",
      "packages:",
    ].join("\n"),
    policy: {
      releaseChannel: "prerelease",
      autoRelease: false,
      protectedPaths: ["automation/policy.json", ".github/workflows/", "scripts/release.mjs"],
    },
    releaseWorkflow: ["matrix:", "  platform: [ubuntu-24.04, windows-latest]"].join("\n"),
    cargoMembers: { "apps/desktop/src-tauri/Cargo.toml": CARGO_TOML },
    workspaceCrates: ["apps/desktop/src-tauri/Cargo.toml"],
    icons: {
      declared: ["icons/32x32.png", "icons/icon.ico", "icons/icon.icns"],
      files: { "icons/32x32.png": png(32, 32), "icons/icon.ico": ico(), "icons/icon.icns": icns() },
      master: png(1024, 1024),
    },
  };
}

const levelOf = (report, id) => report.checks.find((check) => check.id === id)?.level;
const detailOf = (report, id) => report.checks.find((check) => check.id === id)?.detail;

test("Cargo [package] 段解析不受 workspace 与依赖表干扰", () => {
  assert.equal(parseCargoPackageName(CARGO_TOML), "soxu-desktop");
  assert.equal(parseCargoPackageVersion(CARGO_TOML), "0.1.0");
  assert.equal(parseCargoPackageVersion('[workspace]\nmembers = ["a"]'), null);
});

test("Cargo.lock 同名多版本全部保留", () => {
  const lock = [
    "[[package]]",
    'name = "serde"',
    'version = "1.0.200"',
    "",
    "[[package]]",
    'name = "serde"',
    'version = "1.0.210"',
    "",
    "[[package]]",
    'name = "soxu-desktop"',
    'version = "0.1.0"',
  ].join("\n");
  const parsed = parseCargoLockVersions(lock);
  assert.deepEqual(parsed.get("serde"), ["1.0.200", "1.0.210"]);
  assert.deepEqual(parsed.get("soxu-desktop"), ["0.1.0"]);
});

test("pnpm 锁文件解析覆盖跨 YAML 文档的 importers", () => {
  const lock = [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .:",
    "    packageManagerDependencies: {}",
    "",
    "---",
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  apps/desktop:",
    "    dependencies:",
    "      '@lucide/vue':",
    "        specifier: 1.61.0",
    "        version: 1.61.0(vue@3.5.44)",
    "",
    "packages:",
  ].join("\n");
  const importers = parsePnpmImporters(lock);
  assert.ok(importers.has("apps/desktop"));
  assert.equal(importers.get("apps/desktop").dependencies.get("@lucide/vue").specifier, "1.61.0");
});

test("图标期望尺寸按 @Nx 缩放，异常字节被拒绝", () => {
  assert.deepEqual(describeIconExpectation("icons/128x128@2x.png"), { kind: "png", width: 256, height: 256 });
  assert.equal(describeIconExpectation("icons/icon.ico").kind, "ico");
  assert.equal(describeIconExpectation("icons/logo.svg").kind, "unknown");
  assert.equal(inspectIconBytes(png(256, 256), { kind: "png", width: 256, height: 256 }).ok, true);
  assert.equal(inspectIconBytes(png(128, 128), { kind: "png", width: 256, height: 256 }).ok, false);
  assert.equal(inspectIconBytes(Buffer.alloc(0), { kind: "png", width: 1, height: 1 }).ok, false);
  assert.equal(inspectIconBytes(Buffer.from("not an icon"), { kind: "ico", width: null, height: null }).ok, false);
  assert.equal(inspectIconBytes(Buffer.from("icns0000"), { kind: "icns", width: null, height: null }).ok, true);
});

test("完整输入判定为可核验通过", () => {
  const report = evaluateReleaseReadiness(baseInputs(), { platform: "linux", env: {} });
  assert.equal(report.status, "ready");
  assert.equal(levelOf(report, "version-consistency"), "ok");
  assert.equal(levelOf(report, "pnpm-lock"), "ok");
  assert.equal(levelOf(report, "icons-declared"), "ok");
  assert.equal(report.counts.blocked, 0);
  assert.match(renderReport(report), /结论/u);
});

test("版本不一致、默认标识、缺失图标均阻断发布", () => {
  const inputs = baseInputs();
  inputs.desktopPackage.version = "0.2.0";
  inputs.tauriConfig.identifier = "com.tauri.dev";
  delete inputs.icons.files["icons/icon.icns"];
  const report = evaluateReleaseReadiness(inputs, { platform: "linux", env: {} });
  assert.equal(report.status, "blocked");
  assert.equal(levelOf(report, "version-consistency"), "blocked");
  assert.equal(levelOf(report, "tauri-identifier"), "blocked");
  assert.equal(levelOf(report, "icons-declared"), "blocked");
  assert.match(detailOf(report, "icons-declared"), /pnpm icons:generate/u);
});

test("锁文件缺失或 specifier 漂移被阻断", () => {
  const inputs = baseInputs();
  inputs.pnpmLock = inputs.pnpmLock.replace("specifier: 3.5.44", "specifier: 3.5.40");
  inputs.cargoLock = inputs.cargoLock.replace('version = "0.1.0"\n\n[[package]]\nname = "soxu-agent-runtime"', 'version = "0.0.9"\n\n[[package]]\nname = "soxu-agent-runtime"');
  const report = evaluateReleaseReadiness(inputs, { platform: "linux", env: {} });
  assert.equal(levelOf(report, "pnpm-lock"), "blocked");
  assert.equal(levelOf(report, "cargo-lock"), "blocked");
});

test("缺少签名与其它平台构建只标未验证，不伪装通过也不阻断", () => {
  const report = evaluateReleaseReadiness(baseInputs(), { platform: "win32", env: {} });
  assert.equal(levelOf(report, "signing-windows"), "unverified");
  assert.equal(levelOf(report, "signing-macos"), "unverified");
  assert.equal(levelOf(report, "notarization-macos"), "unverified");
  assert.equal(levelOf(report, "host-platform"), "unverified");
  assert.equal(report.platform, "windows");
  assert.ok(report.counts.unverified >= 4);

  const signed = evaluateReleaseReadiness(baseInputs(), {
    platform: "darwin",
    env: {
      APPLE_CERTIFICATE: "x",
      APPLE_ID: "x",
      APPLE_APP_SPECIFIC_PASSWORD: "x",
      APPLE_TEAM_ID: "x",
      WINDOWS_CERTIFICATE: "x",
      WINDOWS_CERTIFICATE_PASSWORD: "x",
    },
  });
  assert.equal(levelOf(signed, "signing-windows"), "ok");
  assert.equal(levelOf(signed, "signing-macos"), "ok");
  assert.equal(levelOf(signed, "notarization-macos"), "ok");
  assert.equal(signed.status, "ready");
});

test("policy 不是 prerelease 通道时阻断", () => {
  const inputs = baseInputs();
  inputs.policy.releaseChannel = "stable";
  inputs.policy.autoRelease = true;
  const report = evaluateReleaseReadiness(inputs, { platform: "linux", env: {} });
  assert.equal(levelOf(report, "policy-channel"), "blocked");
  assert.equal(levelOf(report, "policy-auto-release"), "warn");
  assert.equal(report.status, "blocked");
});

test("真实仓库清单可读取且版本/依赖锁定自洽", async () => {
  const inputs = await readReleaseInputs(fileURLToPath(new URL("../../", import.meta.url)));
  const report = evaluateReleaseReadiness(inputs, { platform: "linux", env: {} });
  assert.equal(levelOf(report, "version-consistency"), "ok");
  assert.equal(levelOf(report, "pnpm-lock"), "ok");
  assert.equal(levelOf(report, "cargo-lock"), "ok");
  assert.equal(levelOf(report, "tauri-identifier"), "ok");
});

test("目录缺少清单时报错而不是静默通过", async () => {
  const dir = mkdtempSync(join(tmpdir(), "soxu-readiness-"));
  try {
    await assert.rejects(() => readReleaseInputs(dir), /ENOENT/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
