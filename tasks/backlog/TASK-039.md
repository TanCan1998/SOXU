---
githubIssue: 149
id: TASK-039
milestone: M1
priority: P2
dependencies: [TASK-034, TASK-035, TASK-036, TASK-037, TASK-038]
---

# i18n 收尾：抽屉/通知/侧栏/欢迎页 + 安装版回归

## 背景

i18n 四个迁移任务的最后一个 + 下一版 preview 的准入门禁。依赖前置任务全部合并后执行。

## 范围

1. 剩余组件 i18n：FileDrawer、GitDrawer、GitDiffPanel、TerminalDrawer、SearchDrawer、WorktreeDialog、NotificationToasts、NotificationHistoryDrawer、ProjectSidebar、App.vue 欢迎页、SessionTabs、MessageList 加载条、commands/registry.ts 剩余部分（如 TASK-035 未覆盖）、notifications/settings.ts 的 NOTIFICATION_EVENT_META/DURATION_OPTIONS/SOUND_PRESETS 标签
2. 新建 drawer.json、notify.json 模块（zh-CN+en-US），sidebar/欢迎页进 common.json
3. check-locales 扩展：扫描全部 .vue 模板与 settings/notifications 元数据文件的硬编码 CJK，存在即 CI 失败（彻底关闭 i18n 回潮）
4. 安装版回归清单（下一版 preview 准入）：
   - 安装→首次启动→添加项目→开会话→发送→取消→搜索→Git 提交→文件操作→终端→通知→临时会话转正→重启恢复→卸载
   - en-US 全流程走查
   - 对照 TASK-033~038 全部验收标准逐项复核
4b. 回归发现的问题按严重度分流：阻塞项修复后才可出 preview

## 验收标准

- [ ] 全部 .vue 模板与元数据文件无硬编码 CJK 用户可见字符串（check-locales 新门禁通过）
- [ ] 桌面端 en-US 走完「添加项目→发送→搜索→Git 提交」主流程无中文残留（截图/录屏证据）
- [ ] 安装版回归清单全项通过或记录已知问题清单
- [ ] pnpm check 全绿

## 非目标

- 新功能开发；loop 控制台 i18n
