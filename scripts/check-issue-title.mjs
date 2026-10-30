#!/usr/bin/env node
/**
 * Issue 标题格式门禁。
 *
 * dashboard 的任务列表与里程碑统计都靠 taskIdFromIssueTitle 解析
 * `[M?] [TASK-NNN] 标题`。人工建的 issue 如果写成 `V4-S0 …` 或
 * `[REQ-xxx]`，会完全不出现在面板上——2026-10-30 就因为这样丢过 6 个切片。
 *
 * 只检查 PR 正文里 Closes/Fixes 关联到的 issue，避免历史 issue 拖累。
 * 豁免：PR 描述写 [skip issue-title]。
 */
import { execSync } from "node:child_process";

const body = process.env.PR_BODY || "";
const repo = process.env.GITHUB_REPOSITORY || "";

if (/\[skip issue-title\]/i.test(body)) {
  console.log("check-issue-title: [skip issue-title] present — allowed.");
  process.exit(0);
}

const refs = [...String(body).matchAll(/(?:closes|closed|close|fixes|fixed|fix|resolves|resolved|resolve)\s+#(\d+)/gi)]
  .map(m => Number(m[1]));
if (!refs.length) {
  console.log("check-issue-title: no linked issue in PR body — nothing to check.");
  process.exit(0);
}

const GOOD = /^\[M\d+\]\s+\[TASK-\d{3,}\]\s+\S/;
const bad = [];
for (const n of [...new Set(refs)]) {
  let title;
  try {
    title = execSync(`gh issue view ${n} --repo ${repo} --json title --jq .title`, { encoding: "utf8" }).trim();
  } catch (error) {
    console.warn(`check-issue-title: unable to read issue #${n} — ${String(error.message).slice(0, 120)}`);
    continue;
  }
  if (!GOOD.test(title)) bad.push({ n, title });
}

if (!bad.length) {
  console.log("check-issue-title: all linked issues match [M?] [TASK-NNN] — OK.");
  process.exit(0);
}

console.error("✖ 以下关联 Issue 的标题不符合 [M<数字>] [TASK-NNN] 描述：");
for (const { n, title } of bad) console.error(`    #${n}  ${title}`);
console.error("");
console.error("dashboard 的任务列表与里程碑统计依赖这个格式（taskIdFromIssueTitle）。");
console.error("请用 \`gh issue edit <n> --title '[M1] [TASK-0NN] 描述'\` 修正后重跑；");
console.error("或在 PR 描述里写 [skip issue-title] 说明豁免理由。");
process.exit(1);
