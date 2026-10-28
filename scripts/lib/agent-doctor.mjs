//! agent:doctor 的离线可测逻辑。
//!
//! 只做两件事：
//! 1. 解析版本字符串，并与 docs/development/approved-toolchain.md 的批准基线比较。
//! 2. 核对锁文件与 rust-toolchain.toml 是否存在、可读、值是否匹配。
//!
//! 不联网、不安装、不修改任何文件：doctor 只报告事实，缺什么就说什么，
//! 不能把「没检测到」写成通过。

/** 已批准基线（见 docs/development/approved-toolchain.md）。 */
export const APPROVED_TOOLCHAIN = Object.freeze({
  node: Object.freeze({ label: "Node.js", spec: ">=24" }),
  pnpm: Object.freeze({ label: "pnpm", spec: "12.15.0" }),
  rustc: Object.freeze({ label: "Rust (rustc)", spec: "1.99.1" }),
  cargo: Object.freeze({ label: "Cargo", spec: "1.99.1" }),
  pi: Object.freeze({ label: "Pi Agent", spec: null }),
});

/** 可复现构建依赖的两份锁文件；小于 1 KiB 基本说明是空壳或占位。 */
export const REQUIRED_FILES = Object.freeze([
  Object.freeze({ path: "pnpm-lock.yaml", minBytes: 1024, label: "pnpm 锁文件" }),
  Object.freeze({ path: "Cargo.lock", minBytes: 1024, label: "Cargo 锁文件" }),
]);

/** 从 "v26.10.0"、"rustc 1.99.1 (hash 2026-10-13)"、"pi 1.4.0" 等文本里取第一个 semver。 */
export function parseVersion(raw) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(raw ?? ""));
  if (!match) return null;
  const version = { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
  return Object.values(version).every(Number.isSafeInteger) ? version : null;
}

export function formatVersion(version) {
  return version ? version.major + "." + version.minor + "." + version.patch : "unknown";
}

/** 负数表示 a < b。 */
export function compareVersions(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * 只支持基线里用到的两种写法：精确版本（如 12.15.0）和下界（如 >=24）。
 * 未知写法返回 false，让调用方按失败处理，而不是猜。
 */
export function matchesSpec(actual, spec) {
  if (!actual || !spec) return false;
  if (spec.startsWith(">=")) {
    const floor = parseLowerBound(spec.slice(2));
    return floor ? compareVersions(actual, floor) >= 0 : false;
  }
  const exact = parseVersion(spec);
  return exact ? compareVersions(actual, exact) === 0 : false;
}

/** 下界允许只写主版本（如 >=24），缺失的段按 0 补齐。 */
export function parseLowerBound(raw) {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(String(raw ?? "").trim());
  if (!match) return null;
  const version = { major: Number(match[1]), minor: Number(match[2] ?? 0), patch: Number(match[3] ?? 0) };
  return Object.values(version).every(Number.isSafeInteger) ? version : null;
}

function check(id, title, passed, detail) {
  return { id, title, status: passed ? "pass" : "fail", detail: detail ?? "" };
}

/**
 * probes 形如 { pnpm: { ok, raw, error }, rustc: {...}, cargo: {...}, pi: {...} }。
 * node 由当前进程本身提供，不需要外部探测。
 */
export function assessToolchain(probes) {
  const checks = [];
  for (const [name, rule] of Object.entries(APPROVED_TOOLCHAIN)) {
    const probe = probes?.[name];
    if (!probe) {
      checks.push(check("tool:" + name, rule.label + " 可执行", false, "未提供探测结果"));
      continue;
    }
    if (probe.ok === false) {
      checks.push(check("tool:" + name, rule.label + " 可执行", false, probe.error || "执行失败"));
      continue;
    }
    const actual = parseVersion(probe.raw);
    if (!actual) {
      checks.push(check("tool:" + name, rule.label + " 可执行", false, "无法从输出解析版本: " + String(probe.raw ?? "").trim().slice(0, 120)));
      continue;
    }
    if (!rule.spec) {
      checks.push(check("tool:" + name, rule.label + " 可执行", true, "实际 " + formatVersion(actual)));
      continue;
    }
    const passed = matchesSpec(actual, rule.spec);
    checks.push(check(
      "tool:" + name,
      rule.label + " 版本符合批准基线 " + rule.spec,
      passed,
      "实际 " + formatVersion(actual) + (passed ? "" : "，要求 " + rule.spec),
    ));
  }
  return checks;
}

/** entries: [{ path, label, minBytes, exists, bytes, error }] */
export function assessLockfiles(entries) {
  return entries.map((entry) => {
    if (entry.error) return check("file:" + entry.path, entry.label + " 可读取", false, entry.error);
    const exists = entry.exists === true;
    const bytes = Number(entry.bytes ?? 0);
    const passed = exists && bytes >= entry.minBytes;
    return check(
      "file:" + entry.path,
      entry.label + " 存在且非占位（≥ " + entry.minBytes + " 字节）",
      passed,
      exists ? "实际 " + bytes + " 字节" : "文件不存在",
    );
  });
}

/** rust-toolchain.toml 的 channel 必须与批准版本一致。 */
export function assessRustToolchain(text) {
  const id = "file:rust-toolchain.toml";
  const title = "rust-toolchain.toml 的 toolchain channel 符合批准基线";
  if (typeof text !== "string") return [check(id, title, false, "文件不可读")];
  const match = /^\s*channel\s*=\s*"([^"]+)"/m.exec(text);
  if (!match) return [check(id, title, false, "未找到 channel 声明")];
  const actual = parseVersion(match[1]);
  const expected = parseVersion(APPROVED_TOOLCHAIN.rustc.spec);
  const passed = Boolean(actual && expected && compareVersions(actual, expected) === 0);
  return [check(id, title, passed, "channel=" + match[1] + (passed ? "" : "，要求 " + APPROVED_TOOLCHAIN.rustc.spec))];
}

export function summarize(checks) {
  const failed = checks.filter((item) => item.status === "fail");
  return { total: checks.length, passed: checks.length - failed.length, failed: failed.length };
}

export function buildReport({ platform, probes, files, toolchainText, generatedAt }) {
  const checks = [
    ...assessToolchain(probes),
    ...assessLockfiles(files),
    ...assessRustToolchain(toolchainText),
  ];
  const summary = summarize(checks);
  return {
    kind: "soxu-agent-doctor",
    generatedAt: generatedAt ?? new Date().toISOString(),
    platform: platform ?? process.platform,
    node: { raw: probes?.node?.raw ?? null, execPath: probes?.node?.execPath ?? null },
    checks,
    summary,
    verdict: summary.failed === 0 ? "pass" : "fail",
  };
}

/** 文本渲染与 JSON 报告共用同一份事实，避免两种输出互相矛盾。 */
export function renderText(report) {
  const lines = [
    "SOXU agent:doctor · " + report.platform + " · node " + (report.node.raw ?? "?"),
    "基线来源: docs/development/approved-toolchain.md",
  ];
  for (const item of report.checks) {
    lines.push("  [" + (item.status === "pass" ? "PASS" : "FAIL") + "] " + item.id + " - " + item.title
      + (item.detail ? " :: " + item.detail : ""));
  }
  lines.push("结论: " + report.verdict + " (" + report.summary.passed + "/" + report.summary.total
    + " 通过, " + report.summary.failed + " 失败)");
  return lines.join("\n");
}
