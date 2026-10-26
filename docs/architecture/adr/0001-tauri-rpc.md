# ADR-0001：Tauri 2 + Pi RPC
状态：Accepted（2026-10-26）

背景：面向轻量多 Agent 桌面工作台，参考 PiDeck 但独立实现。Tauri 3/CEF 的资源成本与 Alpha 兼容风险暂不适合。

决策：桌面使用 Tauri 2、Rust、Vue 3、TypeScript；Pi CLI 通过 stdio JSONL RPC 与 Rust 通信。Pi 会话/认证仍归 Pi 所有；Runner 单独使用同一 RPC 协议在应用外迭代开发。

后果：Node Pi 子进程仍消耗内存，须通过会话生命周期与进程预算优化；官方 RPC 不覆盖的 UI 能力需逐项评估 SDK sidecar，不能隐式扩展无权限通道。
