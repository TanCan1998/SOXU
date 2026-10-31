---
githubIssue: 143
id: TASK-033
milestone: M1
priority: P0
dependencies: []
---

# 产品净化：移除假交互与开发术语

## 背景

preview 实机反馈：扩展页存在只改内存不写配置的假开关；界面上出现「本切片」「Issue #NNN」「后续切片」等开发术语；侧栏临时会话按钮标注 Ctrl K 但该键实际打开命令面板。这些违反「未实现的能力不得渲染可操作控件」与 V3 设计规范。

## 范围

1. 扩展页（apps/desktop/src/components/settings/SettingsExtensions.vue + settings/extensions.ts）：移除假开关与「已启用/未启用」状态徽章；技能/MCP 列表改为纯只读展示并删除虚假的 fileCount/toolCount/connected 假数据（等 TASK-037 真数据接入后恢复）；删除「本切片的静态占位」banner，语言包区保留
2. 快捷键标注修正（components/ProjectSidebar.vue）：临时会话按钮 kbd 改为命令面板真实入口说明，或移除 kbd
3. 开发术语清理：SettingsSystem.vue、SettingsSession.vue、RuntimeInspector.vue、ChatComposer.vue、ComposerSendMenu.vue、MessageList.vue 中所有「切片/Issue #/V4-S*/后续接入/等 #NNN 的命令层」字样，改为面向用户的功能说明或删除
4. 发送菜单降级（components/ComposerSendMenu.vue + sendMode.ts）：在 TASK-036 协议调查结论落地前，「加入当前/排到下轮/并行发送」三选项保持可见但不可用状态需如实（置灰原因改为「即将支持」类文案），不得假装可点
5. 「数据目录可安全删除重建」等未限定建议改为中性描述

## 验收标准

- [ ] 新增 scripts/check-ui-wording.mjs（或扩展 tests/uiWording.test.ts）：扫描 apps/desktop/src 的 .vue/.ts 用户可见字符串（模板插值、aria-label、tooltip text、placeholder），命中禁用词表（切片、Issue #、占位、演示、V4-S、后续切片、TODO(）即失败
- [ ] settings/extensions.ts 不再有 enabled 字段与假 fileCount/toolCount/connected
- [ ] 扩展页无任何可点击开关；桌面端截图走查（浅色+深色）无开发术语
- [ ] ProjectSidebar 的 kbd 标注与 App.vue keydown 实际绑定一致
- [ ] pnpm check 全绿

## 非目标

- 不实现 list_extensions 真数据（TASK-037）
- 不改 Pi RPC 协议层
