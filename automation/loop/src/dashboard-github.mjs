import { run } from "./process.mjs";
import { loadTaskCatalog, taskIdFromIssueTitle } from "./task-catalog.mjs";
import { mergedIssueNumbers } from "./github-queue.mjs";

// Remote data is advisory; scheduling remains governed by github-queue.mjs.
export function buildGithubStatus(catalog, issues, prs) {
  const byTask = new Map();
  for (const issue of issues) {
    const id = taskIdFromIssueTitle(issue.title);
    if (!id) continue;
    if (byTask.has(id)) throw new Error("Duplicate task issue");
    byTask.set(id, issue);
  }
  const merged = mergedIssueNumbers(prs);
  const completed = new Set(catalog.filter(t => {
    const issue = byTask.get(t.id);
    return issue?.state === "CLOSED" && merged.has(issue.number);
  }).map(t => t.id));
  const tasks = {};
  for (const task of catalog) {
    const issue = byTask.get(task.id);
    const matches = issue ? prs.filter(pr => pr.baseRefName === "main" &&
      new RegExp(`(?:^|\\n)\\s*(?:closes|closed|close|fixes|fixed|fix|resolves|resolved|resolve)\\s+#${issue?.number}\\b`, "im").test(String(pr.body ?? ""))) : [];
    const pr = matches.find(p => p.state === "OPEN") ?? matches.find(p => p.mergedAt) ?? null;
    let ci = "unknown";
    if (pr && Array.isArray(pr.statusCheckRollup) && pr.statusCheckRollup.length) {
      const checks = pr.statusCheckRollup;
      ci = checks.some(c => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STALE"].includes(c.conclusion) || c.state === "FAILURE" || c.state === "ERROR") ? "failure" :
        checks.some(c => c.status && c.status !== "COMPLETED" || c.state === "PENDING" || c.state === "EXPECTED") ? "pending" :
        checks.every(c => ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion) || c.state === "SUCCESS") ? "success" : "unknown";
    }
    tasks[task.id] = { issue: issue?.number ?? null, issueState: issue?.state ?? null,
      missing: task.dependencies.filter(id => !completed.has(id)),
      pr: pr ? {number: pr.number, state: pr.mergedAt ? "merged" : pr.state === "OPEN" ? "open" : "closed", ci} : null };
  }
  return tasks;
}
export async function readGithubStatus(root, execute = run) {
  const [catalog, issues, prs] = await Promise.all([
    loadTaskCatalog(root),
    execute("gh", ["issue", "list", "--state", "all", "--limit", "1000", "--json", "number,title,state"], {cwd:root, timeoutMs:15000}),
    execute("gh", ["pr", "list", "--state", "all", "--limit", "1000", "--json", "number,state,body,baseRefName,mergedAt,statusCheckRollup"], {cwd:root, timeoutMs:15000}),
  ]);
  return buildGithubStatus(catalog, JSON.parse(issues.stdout), JSON.parse(prs.stdout));
}
