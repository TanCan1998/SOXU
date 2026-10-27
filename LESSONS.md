# SOXU · Lessons from merged work

本文件是 SOXU 开发/审查/合并后进行**证据驱动复盘**的记录，不是对 Agent 的自我授权。
参考 [Magpie 的经验复盘机制](https://github.com/yetone/magpie/blob/main/LESSONS.md)，但规则和证据必须来自 SOXU 自己的真实开发记录。

## 工作方式

1. 质量 Loop 读取最近 Commit、GitHub PR/CI 和已有 LESSONS，输出 `.soxu/advisory/quality/` 下的**候选建议**；不会直接修改本文件。
2. 维护者核实问题、证据、时间及实际影响后，手工加入一条 observation。不能将同一天的多次相似失败算作多个独立日期。
3. `pnpm agent:lessons` 统计每条规则发生在几个**不同日期**；满 3 天时仅提示可以提议升级。
4. 正式晋升必须由维护者审查后单独修改 `agents/policies/coding-standards.md` 或相应治理文件；受保护路径绝不能由普通 Developer 或产品/质量 Loop 自动修改。
5. 每条证据须指向真实的 Issue/PR 编号、Commit SHA 或公开的准确链接；无实际证据不要新增条目。

## 记录格式

每次验证后追加独立的单行 HTML 注释：前缀为 `soxu-lesson`，后跟一个 JSON 对象，包含 `id`、`date`（YYYY-MM-DD）、`evidence`（真实 #Issue / SHA / URL）和 `rule`（简洁可执行的纠正规则）。同一 id 的 `rule` 必须完全一致。尚未核实的内容写在质量 Loop 的本地建议报告中，而非这里。

目前**没有已核实的复盘条目**，因此也没有具备晋升条件的规范建议。这不是检测失败。
