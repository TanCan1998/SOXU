// PR data is untrusted. Only explicit closing references and known task branches
// are treated as evidence; semantic similarity needs human review.
export function duplicatePrs(issueNumber, prs) {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1 || !Array.isArray(prs)) throw new Error("Invalid duplicate PR input");
  const close = new RegExp(String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#${issueNumber}\b`, "i");
  const branch = new RegExp(`^agent/(?:github-issue-|issue-)${issueNumber}-`);
  return prs.filter(p => p?.state === "OPEN" && p.baseRefName === "main" &&
    (close.test(String(p.body ?? "")) || branch.test(String(p.headRefName ?? ""))))
    .map(p => ({number:p.number, url:p.url})).filter(p => Number.isSafeInteger(p.number) && p.number > 0);
}
