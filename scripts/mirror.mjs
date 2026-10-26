// 可选的单向镜像推送：GitHub 是主仓库，AtomGit 必须是只读镜像。
// 优先使用 AtomGit 控制台 GitHub -> AtomGit Pull Mirror，不需要执行此脚本。
import { ROOT } from "../automation/loop/src/config.mjs";
import { git } from "../automation/loop/src/process.mjs";
const branch = await git(["branch", "--show-current"], ROOT);
if (branch !== "main") throw new Error("Mirror requires main checkout");
if (await git(["status", "--porcelain"], ROOT)) throw new Error("Mirror requires clean worktree");
const remotes = (await git(["remote"], ROOT)).split("\n");
if (!remotes.includes("atomgit") || !remotes.includes("origin")) throw new Error("Need origin and atomgit remotes");
await git(["fetch", "origin", "main", "--tags"], ROOT);
const localSha = await git(["rev-parse", "main"], ROOT);
const originSha = await git(["rev-parse", "origin/main"], ROOT);
if (localSha !== originSha) throw new Error("Local main differs from origin/main");
console.log("Sync only main and tags to AtomGit; no force push");
await git(["push", "atomgit", "refs/heads/main:refs/heads/main"], ROOT);
await git(["push", "atomgit", "--tags"], ROOT);
console.log("AtomGit synchronization complete");
