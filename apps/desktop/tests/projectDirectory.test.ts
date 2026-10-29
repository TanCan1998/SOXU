/**
 * 回归测试：「添加项目」的系统目录选择结果规整。
 *
 * 关键语义是「取消不等于错误」——返回 null 时必须给出 cancelled，
 * 界面才能既不改输入框、也不弹错误提示。这里用注入的假 open 覆盖，
 * 不启动 Tauri、不弹真实对话框。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  PROJECT_DIRECTORY_DIALOG_TITLE,
  normalizePickedDirectory,
  pickProjectDirectory,
  type DirectoryDialogOptions,
} from "../src/services/projectDirectory.ts";

test("选择器按「单个目录」打开并回填绝对路径", async () => {
  const seen: DirectoryDialogOptions[] = [];
  const outcome = await pickProjectDirectory(async (options) => {
    seen.push(options);
    return "F:\\workplace\\pi";
  });

  assert.deepEqual(seen, [
    { directory: true, multiple: false, title: PROJECT_DIRECTORY_DIALOG_TITLE },
  ]);
  assert.deepEqual(outcome, { status: "picked", path: "F:\\workplace\\pi" });
});

test("用户取消（返回 null）不产生路径也不产生错误", async () => {
  const outcome = await pickProjectDirectory(async () => null);
  assert.deepEqual(outcome, { status: "cancelled" });
});

test("空白路径按取消处理，不会去登记空目录", async () => {
  for (const selected of ["", "   ", [] as string[]]) {
    const outcome = await pickProjectDirectory(async () => selected);
    assert.deepEqual(outcome, { status: "cancelled" }, `selected=${JSON.stringify(selected)}`);
  }
});

test("多选数组只取第一个路径并去掉首尾空白", async () => {
  const outcome = await pickProjectDirectory(async () => ["  F:\\a  ", "F:\\b"]);
  assert.deepEqual(outcome, { status: "picked", path: "F:\\a" });
});

test("选择器抛错时返回 unavailable 并带上原因，不伪装成取消", async () => {
  const outcome = await pickProjectDirectory(async () => {
    throw new Error("dialog plugin not allowed");
  });
  assert.deepEqual(outcome, { status: "unavailable", reason: "dialog plugin not allowed" });
});

test("非 Error 的抛错也有可读原因", async () => {
  const outcome = await pickProjectDirectory(async () => {
    throw "window closed";
  });
  assert.deepEqual(outcome, { status: "unavailable", reason: "window closed" });
});

test("normalizePickedDirectory 只接受非空字符串", () => {
  assert.equal(normalizePickedDirectory("F:\\pi"), "F:\\pi");
  assert.equal(normalizePickedDirectory("  F:\\pi  "), "F:\\pi");
  assert.equal(normalizePickedDirectory(null), null);
  assert.equal(normalizePickedDirectory(undefined), null);
  assert.equal(normalizePickedDirectory(""), null);
  assert.equal(normalizePickedDirectory(["", "F:\\b"]), null);
});
