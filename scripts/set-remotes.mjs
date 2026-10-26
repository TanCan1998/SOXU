import { ROOT } from "../automation/loop/src/config.mjs";
import { git } from "../automation/loop/src/process.mjs";
const [githubUrl, atomgitUrl] = process.argv.slice(2);
if (!githubUrl || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(githubUrl)) throw new Error("Usage: node scripts/set-remotes.mjs https://github.com/OWNER/SOXU.git [https://atomgit.com/OWNER/SOXU.git]");
const remotes = (await git(["remote"], ROOT)).split("\n");
if (remotes.includes("origin")) await git(["remote", "set-url", "origin", githubUrl], ROOT);
else await git(["remote", "add", "origin", githubUrl], ROOT);
if (atomgitUrl) {
  if (!/^https:\/\/atomgit\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(atomgitUrl)) throw new Error("Invalid AtomGit URL");
  if (remotes.includes("atomgit")) await git(["remote", "set-url", "atomgit", atomgitUrl], ROOT);
  else await git(["remote", "add", "atomgit", atomgitUrl], ROOT);
}
console.log(await git(["remote", "-v"], ROOT));
