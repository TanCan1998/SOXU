---
githubIssue: 147
id: TASK-037
milestone: M1
priority: P1
dependencies: [TASK-033]
---

# 扩展页真数据：list_extensions 只读接入

## 背景

扩展页现为静态常量假数据（settings/extensions.ts）。后端 extension 领域块（commands/extension.rs）已预留。目标是只读列出本机 Pi 真实 extensions/skills/MCP 服务。

## 范围

1. Rust：commands/extension.rs 新增 list_extensions 命令（只读）：扫描 Pi 用户目录（~/.pi/agent 的 extensions/skills 目录与 settings 中 MCP 配置），返回名称、描述、启用状态、来源（内置/用户安装）
2. 路径与安全：只扫描固定白名单目录（PI_HOME 或默认 ~/.pi/agent），不接收前端传路径；不读取任何凭据文件；MCP 连接状态若无法只读获取则显示未知而非伪造
3. 前端：SettingsExtensions.vue 改调 list_extensions；加载中/失败/空态三态；失败如实显示错误原因
4. 不放任何开关：Pi 的 extension/skill 启停属 Pi 配置所有权，SOXU 不写回（AGENTS.md：不重新实现 Pi 内核）
5. 技能列表按需展开详情（fileCount 等真实数据），MCP toolCount 如实或省略

## 验收标准

- [ ] list_extensions 命令注册进 lib.rs extension 领域块（check-command-blocks 通过）
- [ ] 桌面端扩展页内容与本机 ~/.pi/agent 实际内容一致（人工比对截图证据）
- [ ] 无任何写入 Pi 配置的调用（代码审查确认，无 set_/save_ 类命令）
- [ ] 失败态：Pi 目录不存在/不可读时显示明确错误而非空列表假装成功
- [ ] pnpm check 全绿

## 非目标

- 扩展启停开关、MCP 服务管理 UI
