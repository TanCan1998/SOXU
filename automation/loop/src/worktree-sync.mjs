
import { open, readFile, readdir, realpath, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { ROOT } from "./config.mjs";
import { git } from "./process.mjs";
import { writeCheckpoint } from "./checkpoint.mjs";

const EARLY = new Set(["worktree", "install", "develop"]);
const NAME = /^(local|github)-issue-([1-9]\d*)\.json$/;

async function loadStates(root) {
  const dir = join(root, ".soxu", "checkpoints");
  let filenames;
  try { filenames = await readdir(dir); }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
  const result = [];
  for (const file of filenames.filter(f => NAME.test(f)).sort()) {
    const [, kind, number] = NAME.exec(file);
    const state = JSON.parse(await readFile(join(dir, file), "utf8"));
    if (state?.issue?.number !== Number(number) || Boolean(state.local) !== (kind === "local"))
      throw new Error("Checkpoint identity mismatch: " + file);
    result.push({ state, dir });
  }
  return result;
}

function taskLock(root, state) {
  return join(root, ".soxu", "locks", (state.local ? "local" : "github") + "-issue-" + state.issue.number + ".lock");
}

async function lockState(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!Number.isInteger(value.pid) || value.pid <= 0) return "unsafe";
    try { process.kill(value.pid, 0); return "active"; }
    catch (e) { return e.code === "ESRCH" ? "orphan" : "unsafe"; }
  } catch (e) {
    return e.code === "ENOENT" ? "none" : "unsafe";
  }
}

async function inspect(root, state) {
  const info = {
    issue: state.issue.number, local: Boolean(state.local), phase: state.phase,
    status: state.status, branch: state.branch ?? null, directory: state.directory ?? null,
    ahead: null, behind: null, dirty: null, lock: "unknown", canSync: false, reason: null,
  };
  const wtRoot = resolve(root, "..", "soxu-worktrees");
  if (typeof state.directory !== "string") { info.reason = "no-worktree"; return info; }
  const rel = relative(wtRoot, resolve(state.directory));
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || resolve(state.directory).includes("\0")) {
    info.reason = "outside-managed-worktrees"; return info;
  }
  try {
    const parentReal = await realpath(wtRoot);
    const wtReal = await realpath(state.directory);
    const realRel = relative(parentReal, wtReal);
    if (!realRel || realRel === ".." || realRel.startsWith(".." + sep)) {
      info.reason = "worktree-symlink-escape"; return info;
    }
    const top = await git(["rev-parse", "--show-toplevel"], state.directory);
    const branch = await git(["branch", "--show-current"], state.directory);
    const prefix = "agent/" + (state.local ? "local" : "github") + "-issue-" + state.issue.number + "-";
    const legacy = "agent/issue-" + state.issue.number + "-";
    if (resolve(top).toLowerCase() !== resolve(state.directory).toLowerCase() ||
        branch !== state.branch || !(branch.startsWith(prefix) || branch.startsWith(legacy))) {
      info.reason = "worktree-identity-mismatch"; return info;
    }
    info.lock = await lockState(taskLock(root, state));
    info.dirty = Boolean(await git(["status", "--porcelain", "--untracked-files=all"], state.directory));
    const counts = await git(["rev-list", "--left-right", "--count", "HEAD...origin/main"], state.directory);
    [info.ahead, info.behind] = counts.split(/\s+/).map(Number);
    const head = await git(["rev-parse", "HEAD"], state.directory);
    const intent = state.syncPending;
    if (intent && head !== intent.from && head !== intent.to) info.reason = "unexpected-sync-head";
    else if (state.status !== "running" && state.status !== "paused") info.reason = "not-recoverable";
    else if (info.lock === "active" || info.lock === "unsafe") info.reason = "worktree-locked";
    else if (!EARLY.has(state.phase) || state.testedTree || state.reviewedTree || state.commit) info.reason = "advanced-phase";
    else if (info.dirty) info.reason = "uncommitted-task-changes";
    else if (!intent && state.base && state.base !== head) info.reason = "checkpoint-base-mismatch";
    else if (info.ahead > 0) info.reason = "diverged-from-main";
    else if (info.behind === 0 && !intent) info.reason = "up-to-date";
    else info.canSync = true;
  } catch (e) {
    info.reason = "inspection-failed: " + (e.code ?? "git-error");
  }
  return info;
}

/**
 * Reports lag without mutating anything by default.
 * --sync fast-forwards only clean, unlocked early-phase worktrees.
 * Persist syncPending first so interruption after moving HEAD can be reconciled.
 */
export async function inspectWorktrees({ root = ROOT, sync = false } = {}) {
  if (sync) await git(["fetch", "origin", "main"], root);
  const entries = await loadStates(root);
  const output = [];
  for (const { state, dir } of entries) {
    let item = await inspect(root, state);
    if (!sync || !item.canSync) { output.push(item); continue; }
    const path = taskLock(root, state);
    let handle;
    try {
      if (item.lock === "orphan") {
        // A dead owner is verified above; keep unrelated state and worktree.
        await rm(path, { force: true });
      }
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      await handle.close();
      handle = null;
    } catch (e) {
      if (handle) await handle.close();
      output.push({ ...item, canSync: false, reason: "lock-acquisition-failed" });
      continue;
    }
    try {
      const wt = state.directory;
      const dirty = Boolean(await git(["status", "--porcelain", "--untracked-files=all"], wt));
      const head = await git(["rev-parse", "HEAD"], wt);
      const target = await git(["rev-parse", "origin/main"], wt);
      const intent = state.syncPending;
      if (dirty || (!intent && state.base && state.base !== head) ||
          (intent && head !== intent.from && head !== intent.to)) {
        item.reason = "changed-during-sync";
      } else {
        // No task commits or divergent history. This is a fast-forward, not a rebase.
        await git(["merge-base", "--is-ancestor", head, target], wt);
        const pending = intent ?? { from: head, to: target };
        if (intent && intent.to !== target) throw new Error("main-changed-during-pending-sync");
        if (!intent) await writeCheckpoint({ ...state, syncPending: pending }, dir);
        if (head !== pending.to) await git(["merge", "--ff-only", pending.to], wt);
        const result = await git(["rev-parse", "HEAD"], wt);
        if (result !== pending.to) throw new Error("unexpected-git-head");
        const next = { ...state, base: result, phase: "install" };
        delete next.syncPending;
        await writeCheckpoint(next, dir);
        item = { ...item, ahead: 0, behind: 0, phase: "install", reason: "synced", updatedBase: result };
      }
    } catch (e) {
      item.reason = "sync-failed: " + (e.code ?? "inspect-git-or-checkpoint");
    } finally {
      await rm(path, { force: true });
    }
    item.canSync = false;
    output.push(item);
  }
  return output;
}
