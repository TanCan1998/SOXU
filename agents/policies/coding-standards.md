# 编码规范

- TypeScript strict；不新增无理由 `any`，Vue 组件使用 `<script setup lang="ts">`，Pinia 按域拆分。
- Rust `cargo fmt`、`clippy`、`Result` 错误处理，不在主线程做长 IO。
- 单个源码文件尽量 <=400 行，>600 行说明拆分理由。
- 单元测试、边界测试与跨平台兼容用例伴随改动；UI 有基本无障碍语义。
- 代码注释解释原因和边界，不复述代码。

## 国际化

新增或修改界面文案时：

1. **必须走 `t('module.key')`**，不得在模板或脚本里直接写中文字符串。
2. key 按模块前缀划分（`common.*` / `settings.*` / …），**一个切片只改自己模块的 locale 文件**，避免多人并行时把语言包变成新的冲突热点。
3. 新增 key 必须同时补 `zh-CN` 与 `en-US`，否则 `scripts/check-locales.mjs` 会让 CI 失败。
4. 跨模块要复用的文案放 `common.*`，不要在各自的 json 里重复定义同名 key。
5. 内部日志、代码注释、CLI 输出**不翻译**——它们服务于开发者，不是界面文案。
6. 日期、数字、货币用 `Intl` 格式化，不手工拼接。
