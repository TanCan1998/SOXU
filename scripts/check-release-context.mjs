import { readFile } from "node:fs/promises";
import { ROOT, policy } from "./lib/config.mjs";
import { gh, git } from "./lib/process.mjs";
import { parseCargoPackageVersion } from "./lib/release-manifest.mjs";
import { allowedBranches, parseReleaseTag, versionMismatches } from "./lib/release-context.mjs";

const tag = process.env.GITHUB_REF_NAME;
const commit = process.env.GITHUB_SHA;
if (!parseReleaseTag(tag) || !commit || !/^[0-9a-f]{40}$/u.test(commit)) throw new Error("Invalid release tag or SHA");

const config = await policy();
const branches = allowedBranches(tag, {
  releaseBranch: config.releaseBranch ?? "main",
  integrationBranch: config.integrationBranch ?? "main",
});

// 预发布 tag 可以落在集成分支：看板的「发布 preview」就是直接在 dev 打 tag。
let branch = null;
for (const candidate of branches) {
  await git(["fetch", "origin", candidate], ROOT);
  if (await git(["merge-base", "--is-ancestor", commit, "origin/" + candidate], ROOT).then(() => true, () => false)) {
    branch = candidate;
    break;
  }
}
if (!branch) throw new Error("Release tag commit is not on " + branches.map(name => "origin/" + name).join(" or "));

const read = path => readFile(new URL("../" + path, import.meta.url), "utf8");
const rootPkg = JSON.parse(await read("package.json"));
const appPkg = JSON.parse(await read("apps/desktop/package.json"));
const tauri = JSON.parse(await read("apps/desktop/src-tauri/tauri.conf.json"));
const cargoVersion = parseCargoPackageVersion(await read("apps/desktop/src-tauri/Cargo.toml"));
const mismatches = versionMismatches(tag, {
  rootVersion: rootPkg.version,
  desktopVersion: appPkg.version,
  tauriVersion: tauri.version,
  cargoVersion,
});
if (mismatches.length) throw new Error("Version mismatch: " + mismatches.map(item => item.file + " is " + item.actual + ", expected " + item.expected).join("; "));

const runs = JSON.parse(await gh(["run", "list", "--workflow", "ci.yml", "--branch", branch, "--limit", "50", "--json", "headSha,conclusion,status"], ROOT));
if (!runs.some(run => run.headSha === commit && run.conclusion === "success" && run.status === "completed")) {
  throw new Error("Release commit has no successful CI on " + branch);
}
console.log("Release verified", tag, commit, "on", branch);
