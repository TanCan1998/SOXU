/**
 * 把发布输入评估成可核验结论；纯函数，不发网络请求、不写文件。
 * 等级含义：ok 已核验通过｜warn 需人工关注｜blocked 阻止发布｜unverified 无法在本机验证。
 */
import {
  DEFAULT_TAURI_IDENTIFIER,
  ICON_HINT,
  PRODUCT_VERSION_PATTERN,
  describeIconExpectation,
  inspectIconBytes,
  parseCargoLockVersions,
  parseCargoPackageName,
  parseCargoPackageVersion,
  parsePnpmImporters,
} from "./release-manifest.mjs";

const SIGNING_ENV = Object.freeze({
  "windows-authenticode": ["WINDOWS_CERTIFICATE", "WINDOWS_CERTIFICATE_PASSWORD"],
  "macos-codesign": ["APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "APPLE_SIGNING_IDENTITY"],
  "macos-notarization": ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"],
});

function declaredPlatforms(workflow) {
  const platforms = new Set();
  if (!workflow) return platforms;
  for (const match of String(workflow).matchAll(/matrix:\s*\n\s*platform:\s*\[([^\]]+)\]/gu)) {
    for (const raw of match[1].split(",")) {
      const value = raw.trim().replace(/^['"]|['"]$/gu, "");
      if (/ubuntu/iu.test(value)) platforms.add("linux");
      else if (/windows/iu.test(value)) platforms.add("windows");
      else if (/macos/iu.test(value)) platforms.add("macos");
    }
  }
  return platforms;
}

function iconExpectationDetail(inputs) {
  const entries = [];
  for (const relative of inputs.icons?.declared ?? []) {
    const expectation = describeIconExpectation(relative);
    if (expectation.kind === "unknown") {
      entries.push({ relative, ok: false, detail: "未识别的图标文件名" });
      continue;
    }
    const bytes = inputs.icons.files?.[relative] ?? null;
    entries.push({ relative, ...inspectIconBytes(bytes, expectation) });
  }
  return entries;
}

function checkVersions(inputs, add) {
  const sources = {
    "package.json": inputs.rootPackage?.version ?? null,
    "apps/desktop/package.json": inputs.desktopPackage?.version ?? null,
    "apps/desktop/src-tauri/tauri.conf.json": inputs.tauriConfig?.version ?? null,
    "apps/desktop/src-tauri/Cargo.toml": parseCargoPackageVersion(inputs.desktopCargoToml ?? ""),
  };
  const missing = Object.entries(sources).filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    add("version-declared", "blocked", "版本号声明完整", "缺少 version：" + missing.join("、"));
  }

  const version = sources["package.json"];
  const mismatched = Object.entries(sources).filter(([, value]) => value && value !== version);
  if (mismatched.length > 0) {
    add(
      "version-consistency",
      "blocked",
      "package / app / Tauri / Cargo 版本一致",
      "基准 " + version + "，不一致：" + mismatched.map(([name, value]) => name + "=" + value).join("、"),
    );
  } else if (missing.length === 0) {
    add("version-consistency", "ok", "package / app / Tauri / Cargo 版本一致", "全部为 " + version);
  }

  if (version && !PRODUCT_VERSION_PATTERN.test(version)) {
    add(
      "version-release-pattern",
      "blocked",
      "版本号可被发布脚本接受",
      "当前 " + version + "，Tag 规则要求 0.x.y 或 0.x.y-rc.N",
    );
  } else if (version) {
    add("version-release-pattern", "ok", "版本号可被发布脚本接受", version);
  }

  const lock = inputs.cargoLock ? parseCargoLockVersions(inputs.cargoLock) : null;
  if (!lock) {
    add("cargo-lock", "blocked", "Cargo.lock 存在", "缺少 Cargo.lock，依赖不可复现");
  } else {
    const problems = [];
    for (const relative of inputs.workspaceCrates ?? []) {
      const toml = inputs.cargoMembers?.[relative];
      const name = toml ? parseCargoPackageName(toml) : null;
      const expected = toml ? parseCargoPackageVersion(toml) : null;
      if (!name || !expected) {
        problems.push(relative + " 无法解析 name/version");
        continue;
      }
      const locked = lock.get(name) ?? [];
      if (!locked.includes(expected)) {
        problems.push(name + " 期望 " + expected + "，Cargo.lock 为 [" + locked.join(", ") + "]");
      }
    }
    add(
      "cargo-lock",
      problems.length === 0 ? "ok" : "blocked",
      "Cargo.lock 与各 crate 版本一致",
      problems.length === 0 ? "已核验 " + (inputs.workspaceCrates?.length ?? 0) + " 个 workspace crate" : problems.join("；"),
    );
  }
}

function checkPnpmLock(inputs, add) {
  if (!inputs.pnpmLock) {
    add("pnpm-lock", "blocked", "pnpm-lock.yaml 存在", "缺少 pnpm-lock.yaml，--frozen-lockfile 无法复现");
    return;
  }
  const importers = parsePnpmImporters(inputs.pnpmLock);
  const desktop = importers.get("apps/desktop");
  if (!desktop) {
    add("pnpm-lock", "blocked", "pnpm-lock.yaml 覆盖 apps/desktop", "importers 段缺少 apps/desktop");
    return;
  }
  const declared = {
    ...(inputs.desktopPackage?.dependencies ?? {}),
    ...(inputs.desktopPackage?.devDependencies ?? {}),
  };
  const problems = [];
  for (const [name, specifier] of Object.entries(declared)) {
    const locked = desktop.dependencies.get(name) ?? desktop.devDependencies.get(name);
    if (!locked) problems.push(name + " 未锁定");
    else if (!locked.specifier || !String(locked.specifier).includes(specifier)) {
      problems.push(name + " 期望 " + specifier + "，锁定 specifier 为 " + locked.specifier);
    }
  }
  add(
    "pnpm-lock",
    problems.length === 0 ? "ok" : "blocked",
    "pnpm-lock.yaml 覆盖 apps/desktop 依赖",
    problems.length === 0 ? "已核验 " + Object.keys(declared).length + " 个直接依赖" : problems.join("；"),
  );
}

function checkIdentity(inputs, add) {
  const identifier = inputs.tauriConfig?.identifier ?? "";
  if (!identifier || identifier === DEFAULT_TAURI_IDENTIFIER) {
    add("tauri-identifier", "blocked", "应用标识未使用 Tauri 默认值", "当前 identifier=" + (identifier || "空"));
  } else {
    add("tauri-identifier", "ok", "应用标识未使用 Tauri 默认值", identifier);
  }

  const productName = inputs.tauriConfig?.productName ?? "";
  if (!productName) {
    add("product-name", "blocked", "productName 已声明", "缺少 productName");
  } else {
    add("product-name", "ok", "productName 已声明", productName);
  }

  const bundle = inputs.tauriConfig?.bundle ?? {};
  const targets = bundle.targets ?? [];
  const usable = bundle.active === true && targets !== "none";
  add(
    "bundle-enabled",
    usable ? "ok" : "blocked",
    "bundle 打包已启用",
    usable ? "targets=" + JSON.stringify(targets) : "bundle.active/targets 关闭，无法产出安装包",
  );
}

function checkIcons(inputs, add) {
  const declared = inputs.icons?.declared ?? [];
  if (declared.length === 0) {
    add("icons-declared", "blocked", "bundle.icon 已声明", "tauri.conf.json 未声明 bundle.icon");
    return;
  }
  const entries = iconExpectationDetail(inputs);
  const broken = entries.filter((entry) => !entry.ok);
  add(
    "icons-declared",
    broken.length === 0 ? "ok" : "blocked",
    "bundle.icon 全部有效",
    broken.length === 0
      ? entries.map((entry) => entry.relative + "(" + entry.detail + ")").join("、")
      : broken.map((entry) => entry.relative + "：" + entry.detail).join("；") + "；" + ICON_HINT,
  );

  const master = inputs.icons?.master ?? null;
  const masterInfo = inspectIconBytes(master, { kind: "png", width: 1024, height: 1024 });
  add(
    "icons-master",
    masterInfo.ok ? "ok" : "blocked",
    "图标源图存在且为 1024x1024 PNG",
    masterInfo.ok ? "apps/desktop/assets/soxu-master.png " + masterInfo.detail : "apps/desktop/assets/soxu-master.png：" + masterInfo.detail,
  );
}

function checkPolicy(inputs, add) {
  const policy = inputs.policy ?? {};
  const channelOk = policy.releaseChannel === "prerelease";
  add(
    "policy-channel",
    channelOk ? "ok" : "blocked",
    "发布通道为 prerelease",
    "releaseChannel=" + String(policy.releaseChannel),
  );
  add(
    "policy-auto-release",
    policy.autoRelease === false ? "ok" : "warn",
    "自动发布默认关闭，需显式授权",
    policy.autoRelease === false
      ? "autoRelease=false：发布只能由维护者按 policy 显式授权后执行"
      : "autoRelease 已开启，必须确认分支保护与签名证书审核完成",
  );
  const guarded = Array.isArray(policy.protectedPaths) ? policy.protectedPaths : [];
  const expected = ["automation/policy.json", ".github/workflows/", "scripts/release.mjs"];
  const missing = expected.filter((path) => !guarded.includes(path));
  add(
    "policy-protected-paths",
    missing.length === 0 ? "ok" : "warn",
    "发布相关受保护路径已登记",
    missing.length === 0 ? "已登记 " + guarded.length + " 条受保护路径" : "未登记：" + missing.join("、"),
  );
}

function normalizePlatform(platform) {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  return String(platform);
}

function checkWorkflow(inputs, platform, add) {
  const platforms = declaredPlatforms(inputs.releaseWorkflow);
  if (platforms.size === 0) {
    add("release-workflow", "warn", "发布 workflow 声明平台矩阵", "未解析到发布 workflow 的平台矩阵");
  } else {
    add("release-workflow", "ok", "发布 workflow 声明平台矩阵", [...platforms].join("、"));
  }
  const host = normalizePlatform(platform);
  const unverified = ["windows", "macos", "linux"].filter((name) => name !== host);
  add(
    "host-platform",
    unverified.length === 0 ? "ok" : "unverified",
    "各平台构建与安装/卸载验证范围",
    unverified.length === 0
      ? "当前平台 " + host + "，仍需人工确认安装/卸载冒烟结果"
      : "当前平台 " + host + "；" + unverified.join("、") + " 的构建与安装/卸载未在本机验证",
  );
}

function checkSigning(inputs, env, add) {
  const windows = inputs.tauriConfig?.bundle?.windows ?? {};
  const windowsConfigured = Boolean(windows.certificateThumbprint) || SIGNING_ENV["windows-authenticode"].every((key) => Boolean(env[key]));
  add(
    "signing-windows",
    windowsConfigured ? "ok" : "unverified",
    "Windows 代码签名证书",
    windowsConfigured ? "已配置（未在本机验证签名结果）" : "未配置 Authenticode 证书，安装包为未签名状态",
  );

  const macosConfigured = SIGNING_ENV["macos-codesign"].some((key) => Boolean(env[key]));
  add(
    "signing-macos",
    macosConfigured ? "ok" : "unverified",
    "macOS 代码签名证书",
    macosConfigured ? "已配置（未在本机验证签名结果）" : "未配置 Apple 签名凭据，macOS 包无法签名",
  );

  const macosBundle = inputs.tauriConfig?.bundle?.macOS ?? {};
  const notarizeConfigured = SIGNING_ENV["macos-notarization"].every((key) => Boolean(env[key])) || Boolean(macosBundle.signingIdentity);
  add(
    "notarization-macos",
    notarizeConfigured ? "ok" : "unverified",
    "macOS 公证凭据",
    notarizeConfigured ? "已配置（未在本机验证公证结果）" : "未配置公证凭据，分发时用户会遇到 Gatekeeper 提示",
  );
}

export function evaluateReleaseReadiness(inputs, options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? {};
  const checks = [];
  const add = (id, level, title, detail) => checks.push({ id, level, title, detail });

  checkVersions(inputs, add);
  checkPnpmLock(inputs, add);
  checkIdentity(inputs, add);
  checkIcons(inputs, add);
  checkPolicy(inputs, add);
  checkWorkflow(inputs, platform, add);
  checkSigning(inputs, env, add);

  const counts = { ok: 0, warn: 0, blocked: 0, unverified: 0 };
  for (const check of checks) counts[check.level] += 1;
  return {
    status: counts.blocked > 0 ? "blocked" : "ready",
    version: inputs.rootPackage?.version ?? null,
    platform: normalizePlatform(platform),
    counts,
    checks,
  };
}

const LABELS = Object.freeze({ ok: "通过", warn: "注意", blocked: "阻断", unverified: "未验证" });

export function renderReport(report) {
  const lines = [];
  for (const check of report.checks) {
    lines.push("[" + LABELS[check.level] + "] " + check.title + "：" + check.detail);
  }
  lines.push(
    "汇总：通过 " + report.counts.ok + "，未验证 " + report.counts.unverified +
      "，注意 " + report.counts.warn + "，阻断 " + report.counts.blocked,
  );
  lines.push(
    report.status === "ready"
      ? "结论：本机可核验项通过；未验证项不得写成已验证。"
      : "结论：存在阻断项，发布就绪检查未通过。",
  );
  return lines.join("\n");
}
