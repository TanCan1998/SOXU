import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";
export const TOOL_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const projectRoot = process.env.SOXU_PROJECT_ROOT;
if (projectRoot !== undefined && (!projectRoot || !isAbsolute(projectRoot))) {
  throw new Error("SOXU_PROJECT_ROOT must be a non-empty absolute path");
}
// The legacy layout remains the default until the independent distribution is ready.
export const ROOT = projectRoot ? resolve(projectRoot) : TOOL_ROOT;
export async function policy() {
  const value = JSON.parse(await readFile(resolve(ROOT, "automation/policy.json"), "utf8"));
  for (const name of ["maxConcurrentAgents", "maxRoundsPerInvocation", "maxRetries", "maxChangedFiles", "maxChangedBytes"]) {
    if (!Number.isSafeInteger(value[name]) || value[name] < 0) throw new Error(`Invalid policy: ${name}`);
  }
  if (value.maxConcurrentAgents < 1 || value.maxConcurrentAgents > 4) throw new Error("maxConcurrentAgents must be 1..4");
  if (value.maxRoundsPerInvocation > 50 || value.maxRetries > 3) throw new Error("policy exceeds safety limits");
  if (value.watchIntervalMinutes < 5 || value.maxContinuousHours > 24 || value.maxIssuesPerWatch > 50) throw new Error("Watch budget is outside safe bounds");
  const t = value.timeouts ?? {};
  for (const [name, min, max] of [["piStartupSeconds", 10, 300], ["piIdleSeconds", 30, 900], ["piHardMinutes", 5, 90], ["reviewHardMinutes", 2, 30], ["installMinutes", 1, 20], ["networkSeconds", 10, 120], ["shutdownGraceSeconds", 1, 10]]) {
    if (!Number.isSafeInteger(t[name]) || t[name] < min || t[name] > max) throw new Error(`Invalid timeouts.${name} (expected ${min}..${max})`);
  }
  if (t.piHardMinutes * 60 <= t.piStartupSeconds || t.piHardMinutes * 60 <= t.piIdleSeconds) throw new Error("Hard timeout must exceed startup/idle timeout");
  if (value.recovery?.automaticApiRetries !== 0 || !value.recovery?.preserveWorktree || !value.recovery?.manualOnQuota || !value.recovery?.manualOnNetwork) throw new Error("Bootstrap recovery policy requires no automatic API retries and preserved worktrees");
  if (value.releaseChannel !== "prerelease") throw new Error("Only prerelease is permitted in bootstrap");
  return value;
}
