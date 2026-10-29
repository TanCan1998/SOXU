#!/usr/bin/env node
// 夹具的「孙进程」：模拟 Pi 自己拉起的工具子进程，用于 P-03 进程树清理冒烟。
//
// 用法：node fake-pi-leaf.mjs <index> <mode> <logPath> <releasePath>
//   follow      stdin 关闭（父进程退出或关闭管道）后立即退出——行为良好的后代；
//   stubborn    完全不读 stdin，只有 releasePath 出现或兜底 TTL 到期才退出——模拟不跟随的后代。
//
// 兜底 TTL 保证测试异常中断时不会留下真实孤儿进程，本夹具最多存活 20 秒。
import { appendFileSync, existsSync } from "node:fs";
import process from "node:process";

const [index = "0", mode = "follow", logPath, releasePath] = process.argv.slice(2);

// 与 fake-pi.mjs 共用同一个日志文件：结构化行让测试还原完整进程树。
if (logPath) {
  appendFileSync(
    logPath,
    JSON.stringify({ event: "leaf-start", index: Number(index), mode, pid: process.pid, ppid: process.ppid }) +
      String.fromCharCode(10),
  );
}

const TTL_MS = 20_000;
const finish = () => process.exit(0);

if (mode === "stubborn") {
  const ttl = setTimeout(finish, TTL_MS);
  ttl.unref();
  // 每 50ms 只看一次开关文件：测试据此确定性回收，不依赖计时竞猜。
  const poll = setInterval(() => {
    if (releasePath && existsSync(releasePath)) {
      clearInterval(poll);
      finish();
    }
  }, 50);
} else {
  // follow：父进程退出即管道 EOF；显式 resume 让 stdin 保持活跃。
  process.stdin.on("end", finish);
  process.stdin.on("close", finish);
  process.stdin.resume();
}
