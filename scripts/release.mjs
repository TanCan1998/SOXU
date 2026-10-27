// 自主预发布候选 Tag：严格依赖主分支、GitHub 主分支 CI、版本声明和治理策略。
import { readFile } from "node:fs/promises";
import { ROOT, policy } from "./lib/config.mjs";
import { gh, git } from "./lib/process.mjs";
const version = process.argv[2];
if (!version || !/^0\.\d+\.\d+(?:-rc\.\d+)?$/.test(version)) throw new Error("Usage: node scripts/release.mjs 0.x.y[-rc.N]");
const p = await policy();
if (!p.autoRelease || p.releaseChannel !== "prerelease") throw new Error("Auto release denied by policy");
if (await git(["branch", "--show-current"], ROOT) !== "main") throw new Error("Release requires main");
if (await git(["status", "--porcelain"], ROOT)) throw new Error("Release requires clean main");
await git(["fetch", "origin", "main", "--tags"], ROOT);
// Only fast-forward local main from protected origin/main, no merge commits or forced updates.
await git(["merge", "--ff-only", "origin/main"], ROOT);
const head = await git(["rev-parse", "HEAD"], ROOT);
if (head !== await git(["rev-parse", "origin/main"], ROOT)) throw new Error("Local HEAD != protected origin/main");
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const tauri = JSON.parse(await readFile(new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const appPkg = JSON.parse(await readFile(new URL("../apps/desktop/package.json", import.meta.url), "utf8"));
if (pkg.version !== version || tauri.version !== version || appPkg.version !== version) throw new Error("Version must match root package.json and tauri.conf.json");
const runs = JSON.parse(await gh(["run", "list", "--branch", "main", "--workflow", "ci.yml", "--limit", "30", "--json", "headSha,conclusion,status"], ROOT));
if (!runs.some(r => r.headSha === head && r.status === "completed" && r.conclusion === "success")) throw new Error("No successful CI for main HEAD");
const tag = `v${version}`;
if ((await git(["tag", "--list", tag], ROOT)).trim() === tag) throw new Error(`Tag ${tag} already exists`);
await git(["tag", "-a", tag, "-m", `SOXU ${tag} prerelease`], ROOT);
await git(["push", "origin", `refs/tags/${tag}`], ROOT);
console.log(`Created ${tag}; GitHub release.yml will build packages. Signed/notarized releases require separate configured secrets.`);
