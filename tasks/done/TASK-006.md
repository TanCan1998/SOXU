---
githubIssue: 6
id: TASK-006
milestone: M4
priority: P2
dependencies: [TASK-001, TASK-002, TASK-003, TASK-004, TASK-005]
---

# Release readiness hardening

## 描述
在核心功能已合入受保护 main、M1/M2 验收满足后，完成安装包、图标/标识、版本一致性、跨平台构建与发布文档核验；不得把 PR 创建视为代码已完成合并。

## 范围
- Windows/macOS/Linux 构建与安装/卸载冒烟测试（依据实际可用 Runner）。
- app/package/Cargo/Tauri 版本一致性与图标核验、更新说明。
- 预发布制品、签名/公证能力边界及人工授权规则核验。

## 验收标准
- [ ] TASK-001～005 的对应 Issue 均已完成且代码已合入 main，不能仅凭 PR 打开。
- [ ] 版本、依赖锁文件、测试/CI、安装/卸载等有可核验证据。
- [ ] 缺少签名、macOS 公证或平台 Runner 时如实报告限制，不宣称已验证。
- [ ] 不跳过安全/发布门禁；预发布仅按既定 policy 和显式授权执行。

## 归档记录

- 实现：PR #69（squash 合入 main，45dd650）
- 归档：2026-10-28
