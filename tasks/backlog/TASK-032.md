---
githubIssue: 135
id: TASK-032
milestone: M1
priority: P1
dependencies: []
---

# 国际化框架：可扩展语言包 + 社区翻译导入

## 描述

SOXU 桌面端与 loop 控制台目前全部硬编码中文，没有任何 i18n 基础设施。
多语言不是后期能"补"的东西——一旦文案散落在几百个组件与模板里，
再抽离的成本远高于一开始就分层。

目标不是"支持英文"，而是**让社区能自行翻译并导入语言包**：
语言包是纯数据文件，贡献者不需要改代码，只需复制 `zh-CN.json` 翻译后提交。

## 范围

### 1. 语言包结构

```
apps/desktop/src/locales/
  zh-CN.json     （基准，唯一需要人工保证完整的）
  en-US.json
  index.ts       （加载、回退、切换）
```

扁平 key + 命名空间前缀，便于 diff 与社区比对：

```json
{
  "settings.appearance.theme": "主题",
  "settings.appearance.themeDesc": "切换时有圆形扩散 + 发光涟漪",
  "composer.send.current": "加入当前",
  "composer.send.currentDesc": "追加到本轮对话"
}
```

### 2. 加载与回退

- 启动时读系统语言，匹配失败回退 `zh-CN`
- **缺失 key 回退到 `zh-CN`**，并在开发模式 `console.warn` 列出缺失项
- 语言选择持久化到设置（沿用 `apps/desktop/src/settings/`）
- 运行时切换不重建组件，只换文案（响应式）

### 3. 社区翻译导入

- 设置 → 扩展 页新增「语言包」区：列出内置语言 + 「导入语言包」按钮
- 导入的是 JSON 文件，校验：key 集合是 `zh-CN` 的子集、值非空
- 导入后存到 `%APPDATA%/SOXU/locales/<tag>.json`，不写入仓库
- 提供 `scripts/check-locales.mjs`：CI 校验 `en-US.json` 与 `zh-CN.json` key 一致
  （只校验内置语言；社区语言包不进 CI）

### 4. 首批覆盖范围

不追求一次全覆盖，按用户可见程度排序：

1. 顶栏、侧栏、会话区、输入区（主界面）
2. 设置四页
3. 通知与 Toast
4. 错误提示（`workspace/*.ts` 里的用户可见字符串）

内部日志、注释、开发者面向的 CLI 输出**不翻译**。

### 5. loop 控制台

`automation/loop/web/` 同理，但优先级低于桌面端；可复用同一套 key 命名约定。

## 约束

- 不引入重型 i18n 库；一个约 60 行的 loader 足够（`t(key, params)` + 回退 + 响应式）
- 语言包必须是纯 JSON，不含逻辑，便于社区机器翻译后人工校对
- 日期/数字格式用 `Intl`，不写死

## 验收标准

- [ ] `zh-CN.json` 覆盖主界面 + 设置 + 通知的全部用户可见文案
- [ ] `en-US.json` key 与 `zh-CN.json` 完全一致（CI 校验）
- [ ] 切换语言后无需刷新，所有已渲染文案立即更新
- [ ] 缺失 key 回退中文且开发模式有 warn
- [ ] 设置页可导入外部语言包 JSON，校验不通过时给出具体原因
- [ ] 导入的语言包不写入仓库、不随更新丢失
- [ ] 新增 `scripts/check-locales.mjs` 并接入 CI
- [ ] 文档说明社区翻译流程（复制 → 翻译 → 提交或导入）
