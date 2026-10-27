#!/usr/bin/env node
/**
 * 发布就绪检查 CLI（离线，只读）。
 *
 * 用法：
 *   node scripts/check-release-readiness.mjs            人类可读报告
 *   node scripts/check-release-readiness.mjs --json     结构化输出
 *   node scripts/check-release-readiness.mjs --root DIR 指定仓库根（测试/复验用）
 *   node scripts/check-release-readiness.mjs --platform macos 覆盖当前平台标识
 *
 * 退出码：0 可核验项全部通过；1 存在阻断项；2 用法或读取错误。
 * 只读取版本、图标、锁文件和策略，绝不读取凭据内容，也不执行安装或打包。
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./lib/config.mjs";
import { readReleaseInputs } from "./lib/release-manifest.mjs";
import { evaluateReleaseReadiness, renderReport } from "./lib/release-readiness.mjs";

const USAGE = [
  "用法：node scripts/check-release-readiness.mjs [--json] [--root <dir>] [--platform <os>]",
  "  --json            输出机器可读 JSON 报告",
  "  --root <dir>      指定仓库根目录（默认仓库根）",
  "  --platform <os>   覆盖平台标识（默认当前 process.platform）",
].join("\n");

export function parseArgs(argv) {
  const options = { json: false, root: ROOT, platform: process.platform };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--root" || arg === "--platform") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(arg + " 需要一个值");
      if (arg === "--root") options.root = resolve(value);
      else options.platform = value;
      index += 1;
    } else {
      throw new Error("未知参数：" + arg);
    }
  }
  return options;
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error.message + "\n" + USAGE);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  let inputs;
  try {
    inputs = await readReleaseInputs(options.root);
  } catch (error) {
    console.error("读取发布输入失败：" + error.message);
    return 2;
  }
  const report = evaluateReleaseReadiness(inputs, { platform: options.platform, env: process.env });
  console.log(options.json ? JSON.stringify(report, null, 2) : renderReport(report));
  return report.status === "ready" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error("发布就绪检查异常：" + error.message);
    process.exitCode = 2;
  }
}
