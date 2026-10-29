创建匿名脱敏的 JSONL 与巨型工具输出数据，禁止提交用户真实会话。

50,000 条事件的长会话夹具由代码确定性生成，不落盘为 JSONL（体积大且无隐私风险，但没必要入库）：
`apps/desktop/tests/support/longSession.ts`。用法与实测数据见
[长会话虚拟列表与 5 万事件回归](../../docs/development/long-session-virtual-list.md)。
