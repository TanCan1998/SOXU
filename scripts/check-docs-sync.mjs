#!/usr/bin/env node
/**
 * 文档同步门禁：改了产品代码却没动任何文档的 PR 会被拦下。
 *
 * 背景：README / docs 的更新过去靠「谁碰巧改了相关功能就顺手改一下」，
 * 实测 README 的功能描述落后于实际实现数月（V4 做了设置页/通知/搜索抽屉，
 * README 仍停在多会话工作区）。AGENTS.md 与 policies/*.md 都要求同步，
 * 但没有执行者，也没有触发点。
 *
 * 豁免方式：PR 描述里写 [skip docs]，或改动只涉及测试/配置/脚本。
 */
import { execSync } from "node:child_process";

const base = process.env.GITHUB_BASE_REF || process.env.DOCS_BASE_REF || "dev";
const body = process.env.PR_BODY || "";
const SKIP = /\[skip docs\]/i;

function changedFiles() {
  try {
    return execSync(`git diff --name-only origin/${base}...HEAD`, { encoding: "utf8" })
      .split("\n").map(x => x.trim()).filter(Boolean);
  } catch (error) {
    // 浅克隆或缺少 base ref：不阻塞，但要说清楚
    console.warn("check-docs-sync: unable to diff against origin/" + base + " — " + error.message);
    return null;
  }
}

const CODE = /^(?:apps\/desktop\/src\/|apps\/desktop\/src-tauri\/src\/|crates\/)/;
const DOCS = /^(?:README[^/]*\.md|docs\/)/;
// 测试与脚本不算「产品代码变更」，不强制文档
const NOT_PRODUCT = /(?:^|\/)(?:tests?|__tests__|fixtures|scripts)\//;

const files = changedFiles();
if (files === null) process.exit(0);
if (files.length === 0) process.exit(0);

const code = files.filter(f => CODE.test(f) && !NOT_PRODUCT.test(f));
const docs = files.filter(f => DOCS.test(f));

if (code.length === 0) {
  console.log("check-docs-sync: no product code changed, docs gate skipped.");
  process.exit(0);
}
if (docs.length > 0) {
  console.log("check-docs-sync: " + code.length + " code file(s) and " + docs.length + " doc file(s) changed — OK.");
  process.exit(0);
}
if (SKIP.test(body)) {
  console.log("check-docs-sync: [skip docs] present in PR body — allowed.");
  process.exit(0);
}

console.error("✖ 改了产品代码但没有任何文档变更：");
for (const f of code.slice(0, 20)) console.error("    " + f);
if (code.length > 20) console.error("    ... and " + (code.length - 20) + " more");
console.error("");
console.error("AGENTS.md 与 agents/policies/documentation.md 要求：用户可见功能更新 README/PRD，");
console.error("架构变化新建 ADR。请二选一：");
console.error("  1. 同步更新 README.md / README.en.md 或 docs/ 下的文档；");
console.error("  2. 在 PR 描述里写明 [skip docs] 并说明理由（纯内部重构、无用户可见变化）。");
process.exit(1);
