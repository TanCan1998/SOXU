import { access } from "node:fs/promises";
import { ROOT } from "./lib/config.mjs";
import { git, run } from "./lib/process.mjs";
try { await access(new URL("../.git/", import.meta.url)); console.log("Git already initialized; no changes made"); process.exit(0); } catch {}
await run("git", ["init", "-b", "main"], { cwd: ROOT });
await git(["add", "-A"], ROOT);
await git(["commit", "-m", "chore: bootstrap SOXU monorepo"], ROOT);
console.log("SOXU Git initialized on main. Configure origin and branch protection separately.");
