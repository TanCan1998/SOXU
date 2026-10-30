---
githubIssue: 146
id: TASK-036
milestone: M1
priority: P1
dependencies: [TASK-033]
---

# 发送模式协议调查与落地

## 背景

ComposerSendMenu 的三选（加入当前/排到下轮/并行发送）已进 UI，但 Pi RPC 协议层 PiCommand::Prompt 只有 message 字段（crates/pi-protocol/src/lib.rs），无 mode；sessionWorkspace.ts sendPrompt 在 running/cancelling/loading 时直接 return。忙碌时发送假可用。

## 范围

**第一阶段（只读调查，不写代码）**：
1. 用本机 pi --mode rpc 实测：忙碌时再发 prompt 的真实行为（排队？报错？丢弃？）；abort 后续发的语义
2. 检查 pi CLI 帮助与 pi-protocol 现有帧定义，确认是否存在 steering/queue 相关命令
3. 产出 docs/development/send-modes.md：协议事实、SOXU 侧可行映射（steer=Pi 原生支持/followUp=客户端排队重发/parallel=新会话）与不可行结论

**第二阶段（依据调查结论实现）**：
4. followUp（排到下轮）：若 Pi 不原生支持，在 sessionWorkspace 增加客户端侧待发队列：agent_settled 后自动重发，取消按钮语义扩展
5. parallel（并行发送）：草稿克隆到当前项目下新临时会话并自动发送，UI 提示新会话已创建（复用 openTemporary + sendPrompt）
6. steer（加入当前）：仅当协议调查确认 Pi 支持 steering 才实现；否则 UI 移除该项（不得保留假菜单项）
7. 「忙碌时发送」默认投递设置与三选真实联动

## 验收标准

- [ ] docs/development/send-modes.md 存在且引用真实协议帧/实测记录
- [ ] followUp：忙碌时选择「排到下轮」，agent_settled 后消息自动发出（单测用 FakeBridge 模拟 + 实机演示）
- [ ] parallel：忙碌或空闲时「并行发送」创建新临时会话并发出，不打断当前会话（测试+实机）
- [ ] steer：要么真实生效（实测证据），要么从 UI 移除
- [ ] 发送菜单不再有任何「可见但无效果」的选项
- [ ] pnpm check 全绿

## 非目标

- 附件、多模态输入
