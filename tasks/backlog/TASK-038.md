---
githubIssue: 148
id: TASK-038
milestone: M1
priority: P2
dependencies: [TASK-033, TASK-034]
---

# 通知设置 UI + 临时会话转正文件入口

## 背景

两个遗留交互缺口：1) 通知系统有自己的设置模型（notifications/settings.ts：三类事件开关/时长/音效/音量）但没有设置页 UI，系统页 notifyOnComplete 与之重复；2) 临时会话转正被 E_TEMPORARY_SESSION_UNPROMOTABLE 卡住：桌面端没有文件选择入口，Pi 不回报会话文件路径。

## 范围

1. 设置页新增「通知」页签或并入系统页：渲染 NOTIFICATION_EVENT_META 三类事件开关+音效选择、时长、仅失焦、音量；读写 soxu.notifications 存储键；替代系统页 notifyOnComplete（TASK-035 已并入事件开关链则衔接）
2. 转正文件入口：转正对话框增加「选择 Pi 会话文件」按钮，用 tauri-plugin-dialog（capability 已批 dialog:allow-open）选择 .jsonl；read-only 校验（存在、可读、非当前运行时持有）后调 promote_session 完成绑定
3. 转正失败路径细化：文件不存在/已被运行时持有/校验失败各自的明确错误文案
4. 通知设置改动即时生效（通知 store 响应式读取，无需重启）

## 验收标准

- [ ] 通知设置页完整可用：改音效立即听到、改时长立即影响下一个 toast（实机验证）
- [ ] 转正全流程实机走通：临时会话→停止运行时→选择文件→转正成功→侧栏出现→重启后仍在
- [ ] 三种失败路径各有明确文案与恢复建议（测试覆盖）
- [ ] pnpm check 全绿

## 非目标

- 系统级通知（Windows 通知中心集成）
