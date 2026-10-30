---
githubIssue: 145
id: TASK-035
milestone: M1
priority: P0
dependencies: [TASK-033]
---

# 产品净化第二刀 + i18n：设置页与命令面板

## 背景

设置页 20 项元数据（settings/catalog.ts）与命令面板全部命令标题（commands/registry.ts）是硬编码中文，且含「见 Issue #117」「等 #112 命令层拆分」开发文案。系统页三个开关（自动更新/通知/托盘）只持久化不生效。本任务把设置页文案迁移 i18n 并接通系统设置真实行为。

## 范围

1. settings/catalog.ts 全部 label/description/keywords 改走语言包（新增 locales settings 模块条目）；SETTINGS_TABS 同理；命令面板标题自动跟随（registry.ts 不复制标题）
2. commands/registry.ts 的 PANEL/SESSION/SYSTEM 命令标题、hint、NEEDS_SESSION/NEEDS_PROJECT 原因文案走语言包
3. 系统开关真接线：
   - minimizeToTray=false 时 tray.rs 不再隐藏到托盘（读前端偏好，经持久化存储传入 Rust；具体通道用 Tauri 事件或启动参数，实现者给出最小方案）
   - notifyOnComplete 并入通知系统事件开关链（notifications/settings.ts 已有模型）
   - 新增「打开数据目录」按钮（后端命令 open_data_directory，用系统文件管理器打开，只读语义）
   - 「检查更新」在发布通道落地前从设置页移除（而非禁用）
4. 自动更新开关在发布通道存在前同样隐藏

## 验收标准

- [ ] settings/catalog.ts 与 commands/registry.ts 无硬编码 CJK（测试断言）；命令面板与设置页切 en-US 全英文
- [ ] minimizeToTray=false 时关闭窗口实测退出进程（Windows 实机证据）；true 时隐藏托盘行为不变
- [ ] notifyOnComplete=false 时任务完成不弹 toast/系统通知（测试+实机）
- [ ] 「打开数据目录」能打开资源管理器并定位目录（Windows 实机）
- [ ] 设置页无「检查更新」「自动更新」入口（发布通道落地后恢复）
- [ ] pnpm check 全绿

## 非目标

- 托盘完整策略（M3）
- 真实更新通道
