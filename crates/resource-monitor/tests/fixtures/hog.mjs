#!/usr/bin/env node
// 测试夹具：一个可预测的内存占用进程，可选再拉一个同样大小的子进程。
//
// 用法：node hog.mjs <megabytes> <holdMs> [children]
//   1. 逐块写入（只 alloc 不写不会真的占常驻内存）；
//   2. 分配完成后向 stdout 打一行 "ready <pid>"，测试据此确认内存已经真实占用；
//   3. 可选再 spawn 一个同样大小的子进程，用来验证「进程树」而不是「单进程」的聚合。
//
// 自带的兜底定时器保证测试异常时不会留下长期占用内存的进程。
import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const [mbArg = "32", holdArg = "15000", childrenArg = "0"] = process.argv.slice(2);
const megabytes = Number.parseInt(mbArg, 10);
const holdMs = Number.parseInt(holdArg, 10);
const childCount = Number.parseInt(childrenArg, 10);

const guard = setTimeout(() => process.exit(0), 120_000);
guard.unref();

const buffers = [];
for (let written = 0; written < megabytes; written += 8) {
  const chunk = Math.min(8, megabytes - written) * 1024 * 1024;
  buffers.push(Buffer.alloc(chunk, 1));
}

const children = [];
const script = fileURLToPath(import.meta.url);
for (let index = 0; index < childCount; index += 1) {
  children.push(
    spawn(process.execPath, [script, mbArg, holdArg, "0"], {
      stdio: ["ignore", "ignore", "ignore"],
    }),
  );
}

process.stdout.write(`ready ${process.pid}\n`);

const keepAlive = setInterval(() => {}, 1_000);
setTimeout(() => {
  clearInterval(keepAlive);
  for (const child of children) {
    child.kill();
  }
  process.exit(0);
}, holdMs);
