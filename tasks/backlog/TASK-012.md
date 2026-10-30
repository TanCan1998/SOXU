---
githubIssue: 110
id: TASK-012
milestone: M1
priority: P1
dependencies: []
---

# 设计 token 落地：原型 CSS 变量迁移到 Tailwind @theme

## 描述

把原型 soxu-prototype 的设计变量（105 个）落地到 SOXU 桌面端的 Tailwind 4 @theme，建立深浅色双主题基础。

## 范围

- 新建 apps/desktop/src/styles/tokens.css，覆盖色彩/圆角/字号/阴影/缓动
- Tailwind 4 CSS-first 的 @theme 注册
- data-theme 属性切换深浅色，配合 startViewTransition 圆形扩散
- 不改现有组件样式

## 验收标准

- [ ] pnpm check 通过
- [ ] 深浅色切换无布局跳动
- [ ] 所有 token 有浅色对应值
- [ ] 不引入新依赖
