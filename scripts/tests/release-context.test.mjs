import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { allowedBranches, isPreviewTag, parseReleaseTag, versionMismatches } from "../lib/release-context.mjs";
import { parseCargoPackageVersion } from "../lib/release-manifest.mjs";

test("release tags are parsed strictly", () => {
  assert.deepEqual(parseReleaseTag("v0.1.0"), { tag: "v0.1.0", version: "0.1.0", preview: false });
  assert.equal(parseReleaseTag("v0.1.0-rc.2").preview, true);
  assert.equal(isPreviewTag("v0.1.0-rc.2"), true);
  assert.equal(isPreviewTag("v0.1.0"), false);
  for (const bad of ["0.1.0", "v1.0.0", "v0.1", "v0.1.0-rc", "v0.1.0-beta.1", "v00.1.0", "", null, undefined]) {
    assert.equal(parseReleaseTag(bad), null, String(bad));
  }
});

test("a preview tag may point at the integration branch, a release tag may not", () => {
  assert.deepEqual(allowedBranches("v0.1.0", { releaseBranch: "main", integrationBranch: "dev" }), ["main"]);
  assert.deepEqual(allowedBranches("v0.1.0-rc.1", { releaseBranch: "main", integrationBranch: "dev" }), ["main", "dev"]);
  // 没有独立集成分支时不应产生重复分支。
  assert.deepEqual(allowedBranches("v0.1.0-rc.1", { releaseBranch: "main", integrationBranch: "main" }), ["main"]);
  assert.deepEqual(allowedBranches("nonsense", { releaseBranch: "main", integrationBranch: "dev" }), []);
});

test("every manifest must declare the tag version", () => {
  const agreed = { rootVersion: "0.1.0", desktopVersion: "0.1.0", tauriVersion: "0.1.0", cargoVersion: "0.1.0" };
  // 看板 preview 不改产品版本：清单是基线 0.1.0，tag 是 v0.1.0-rc.N。
  assert.deepEqual(versionMismatches("v0.1.0-rc.3", agreed), []);
  // scripts/release.mjs 的手动 rc：清单本身带 rc 后缀，同样放行。
  assert.deepEqual(versionMismatches("v0.1.0-rc.3", { rootVersion: "0.1.0-rc.3", desktopVersion: "0.1.0-rc.3", tauriVersion: "0.1.0-rc.3", cargoVersion: "0.1.0-rc.3" }), []);
  // 正式 tag 不接受 rc 后缀。
  assert.equal(versionMismatches("v0.1.0", { ...agreed, rootVersion: "0.1.0-rc.3" })[0].file, "package.json");
  assert.deepEqual(versionMismatches("v0.1.0", { ...agreed, cargoVersion: "0.2.0" }),
    [{ file: "apps/desktop/src-tauri/Cargo.toml", expected: "0.1.0", actual: "0.2.0" }]);
  assert.deepEqual(versionMismatches("v0.1.0", { ...agreed, tauriVersion: null }),
    [{ file: "apps/desktop/src-tauri/tauri.conf.json", expected: "0.1.0", actual: null }]);
  // 跨清单漂移在 preview 里也不放过。
  assert.deepEqual(versionMismatches("v0.1.0-rc.1", { ...agreed, desktopVersion: "0.2.0" }),
    [{ file: "apps/desktop/package.json", expected: "0.1.0-rc.1 或 0.1.0", actual: "0.2.0" }]);
  assert.equal(versionMismatches("bad", agreed)[0].file, "tag");
});

test("the checked-in manifests still agree on one version", async () => {
  const read = path => readFile(new URL("../../" + path, import.meta.url), "utf8");
  const root = JSON.parse(await read("package.json"));
  const desktop = JSON.parse(await read("apps/desktop/package.json"));
  const tauri = JSON.parse(await read("apps/desktop/src-tauri/tauri.conf.json"));
  const cargo = parseCargoPackageVersion(await read("apps/desktop/src-tauri/Cargo.toml"));
  assert.deepEqual(versionMismatches("v" + root.version, {
    rootVersion: root.version,
    desktopVersion: desktop.version,
    tauriVersion: tauri.version,
    cargoVersion: cargo,
  }), []);
});
