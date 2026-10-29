性能与资源采样的脚本、口径与原始数据都在代码旁边，不集中放在这里。

| 主题 | 脚本 / 文档 | 数据 |
| --- | --- | --- |
| 进程树内存与释放（M2） | [内存预算文档](../../docs/development/memory-budget.md) | `docs/development/evidence/m2-process-tree/` |
| 长会话（50,000 条事件）首屏 / DOM / 缓存边界 | [长会话虚拟列表](../../docs/development/long-session-virtual-list.md)、`apps/desktop/tests/perf/longSessionMemory.mjs`、`apps/desktop/tests/harness/` | `docs/development/evidence/m2-long-session/` |

采样要求（与 `agents/policies/testing.md` 一致）：输出硬件、系统版本、Node/Rust 版本、完整命令与
原始数值；同一份夹具、同一台机器才可比较；离线夹具或开发服务器上的结果**不能**当成实机验收。
