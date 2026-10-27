
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectWorktrees } from "../src/worktree-sync.mjs";
import { readCheckpoint, writeCheckpoint } from "../src/checkpoint.mjs";

const run = promisify(execFile);
const git = async (cwd, ...args) => (await run("git", args, { cwd, timeout: 10000 })).stdout.trim();
async function fixture() {
  const outer = await mkdtemp(join(tmpdir(), "soxu-worktree-audit-"));
  const root = join(outer, "soxu");
  await mkdir(root);
  await git(root, "init", "--initial-branch=main");
  await writeFile(join(root, "file.txt"), "v1");
  await git(root, "add", "file.txt");
  await git(root, "-c", "user.name=Tester", "-c", "user.email=test@example.org", "commit", "-m", "initial");
  await git(root, "remote", "add", "origin", root);
  await git(root, "fetch", "origin", "main");
  const old = await git(root, "rev-parse", "HEAD");
  const wt = join(outer, "soxu-worktrees", "github-issue-1-example");
  await git(root, "worktree", "add", "-b", "agent/github-issue-1-example", wt, old);
  const state = { issue: { number:1, title:"Example", body:"" }, local:false,
    status:"paused", phase:"develop", directory:wt, branch:"agent/github-issue-1-example",
    base:old, attempt:0 };
  const dir = join(root, ".soxu", "checkpoints");
  await writeCheckpoint(state, dir);
  await writeFile(join(root, "file.txt"), "v2");
  await git(root, "add", "file.txt");
  await git(root, "-c", "user.name=Tester", "-c", "user.email=test@example.org", "commit", "-m", "next");
  await git(root, "fetch", "origin", "main");
  return { outer, root, wt, old, state, dir };
}
test("clean paused worktree syncs with new main and updates base", async () => {
  const f = await fixture();
  try {
    let rows = await inspectWorktrees({ root:f.root });
    assert.equal(rows[0].behind, 1);
    assert.equal(rows[0].canSync, true);
    rows = await inspectWorktrees({ root:f.root, sync:true });
    assert.equal(rows[0].reason, "synced");
    const saved = await readCheckpoint(1, f.dir);
    assert.equal(saved.base, await git(f.root, "rev-parse", "origin/main"));
    assert.equal(saved.phase, "install");
    assert.equal(saved.syncPending, undefined);
    assert.equal(await git(f.wt, "rev-parse", "HEAD"), saved.base);
  } finally { await rm(f.outer, { recursive:true, force:true }); }
});
test("dirty task worktree is not modified", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.wt, "untracked.txt"), "irreplaceable");
    assert.equal((await inspectWorktrees({ root:f.root, sync:true }))[0].reason, "uncommitted-task-changes");
    assert.equal(await git(f.wt, "rev-parse", "HEAD"), f.old);
    assert.equal((await readCheckpoint(1, f.dir)).base, f.old);
    assert.equal(await readFile(join(f.wt, "untracked.txt"), "utf8"), "irreplaceable");
  } finally { await rm(f.outer, { recursive:true, force:true }); }
});
test("active lock and reviewed checkpoint block synchronization", async () => {
  const f = await fixture();
  try {
    const locks = join(f.root, ".soxu", "locks");
    await mkdir(locks, { recursive:true });
    await writeFile(join(locks, "github-issue-1.lock"), JSON.stringify({pid:process.pid}));
    assert.equal((await inspectWorktrees({ root:f.root, sync:true }))[0].reason, "worktree-locked");
    await rm(join(locks, "github-issue-1.lock"));
    await writeCheckpoint({ ...f.state, phase:"review", testedTree:"example" }, f.dir);
    assert.equal((await inspectWorktrees({ root:f.root, sync:true }))[0].reason, "advanced-phase");
    assert.equal(await git(f.wt, "rev-parse", "HEAD"), f.old);
  } finally { await rm(f.outer, { recursive:true, force:true }); }
});
test("interrupted fast-forward completes recorded sync intent safely", async () => {
  const f = await fixture();
  try {
    const target = await git(f.root, "rev-parse", "origin/main");
    await writeCheckpoint({ ...f.state, syncPending:{from:f.old,to:target} }, f.dir);
    await git(f.wt, "merge", "--ff-only", target);
    assert.equal((await inspectWorktrees({ root:f.root, sync:true }))[0].reason, "synced");
    const state = await readCheckpoint(1, f.dir);
    assert.equal(state.base, target);
    assert.equal(state.syncPending, undefined);
  } finally { await rm(f.outer, { recursive:true, force:true }); }
});

test("explicit selection cannot update unrelated task checkpoints",async()=>{
  const f=await fixture();
  try{
    assert.deepEqual(await inspectWorktrees({root:f.root,sync:true,issueNumbers:[{id:2,local:false}]}),[]);
    assert.equal(await git(f.wt,"rev-parse","HEAD"),f.old);
    assert.equal((await inspectWorktrees({root:f.root,sync:true,issueNumbers:[{id:1,local:false}]}))[0].reason,"synced");
  }finally{await rm(f.outer,{recursive:true,force:true});}
});
