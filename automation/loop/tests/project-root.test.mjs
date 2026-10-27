import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const config = fileURLToPath(new URL("../src/config.mjs", import.meta.url));
const probe = (value) => spawnSync(process.execPath, ["--input-type=module", "-e", `import {ROOT, TOOL_ROOT} from ${JSON.stringify(new URL("../src/config.mjs", import.meta.url).href)}; console.log(JSON.stringify({ROOT, TOOL_ROOT}))`], {
  env: { ...process.env, SOXU_PROJECT_ROOT: value }, encoding: "utf8",
});

test("explicit project root is independent from tool installation", () => {
  const target = resolve(config, "../../../../separate-project");
  const result = probe(target);
  assert.equal(result.status, 0, result.stderr);
  const paths = JSON.parse(result.stdout);
  assert.equal(paths.ROOT, target);
  assert.notEqual(paths.ROOT, paths.TOOL_ROOT);
});

test("relative and empty explicit project roots fail closed", () => {
  for (const target of ["relative-project", ""]) {
    const result = probe(target);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SOXU_PROJECT_ROOT must be a non-empty absolute path/);
  }
});
