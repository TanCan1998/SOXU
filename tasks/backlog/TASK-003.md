---
id: TASK-003
priority: P0
dependencies: [TASK-001, TASK-002]
---

# Build multi-session Vue workspace

## 描述
在已批准的 SOXU UI/UX 规范内构建 Vue 多项目、多会话工作区；连接 Rust Supervisor 与 Session Catalog，支持聊天流式更新及输入控制。不把开发监控用 PiDeck 当成 SOXU 产品界面。

## 范围
- 项目导航、会话 Tab、历史加载与消息流式追加、输入框/取消操作。
- Rust ↔ Vue 消息协议、重连恢复、错误/空状态、组件卸载时订阅释放。
- 多会话切换时稳定标识及资源清理，遵守已批准视觉基线。

## 验收标准
- [ ] 与 TASK-001、TASK-002 实际 API 集成，不使用伪数据作为完成依据。
- [ ] 自动测试覆盖多 Tab 并发事件、历史恢复、取消、卸载监听器。
- [ ] 核对可访问性、布局与已批准 UI/UX；关键交互有可复现证据。
- [ ] 构建/测试和失败恢复路径符合 AGENTS.md 与质量门禁。
