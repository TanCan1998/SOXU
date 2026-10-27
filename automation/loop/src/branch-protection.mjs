// Require every current CI check, including native and commit validation.
export const REQUIRED_CHECKS = Object.freeze(["quality (24)", "quality (26)", "Rust / Tauri", "Validate commit messages"]);
export function hasRequiredChecks(protection) {
  const checks = protection?.required_status_checks;
  if (!checks || !protection.required_pull_request_reviews) return false;
  const contexts = new Set([...(Array.isArray(checks.contexts) ? checks.contexts : []), ...(Array.isArray(checks.checks) ? checks.checks.map(x => x?.context) : [])]);
  return REQUIRED_CHECKS.every(name => contexts.has(name));
}
