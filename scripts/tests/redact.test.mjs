//! 证据脱敏的离线测试（Issue #41）：报告入库前不得带出用户主目录。

import test from "node:test";
import assert from "node:assert/strict";

import { redactHome } from "../lib/redact.mjs";

test("主目录前缀被替换成 ~，其它内容不变", () => {
  const input = {
    sessionFile: "C:\\Users\\alice\\AppData\\Local\\Temp\\x\\s.jsonl",
    nested: [{ path: "/home/alice/sessions/a.jsonl" }, 42, null, true],
  };
  const win = redactHome(input, "C:\\Users\\alice");
  assert.equal(win.sessionFile, "~\\AppData\\Local\\Temp\\x\\s.jsonl");
  assert.deepEqual(win.nested, [{ path: "/home/alice/sessions/a.jsonl" }, 42, null, true]);

  const posix = redactHome(input, "/home/alice");
  assert.equal(posix.nested[0].path, "~/sessions/a.jsonl");
  assert.equal(posix.sessionFile, input.sessionFile);
});

test("没有主目录或空主目录时原样返回", () => {
  const input = { a: 1 };
  assert.deepEqual(redactHome(input, ""), input);
  assert.deepEqual(redactHome(input, undefined), input);
});
