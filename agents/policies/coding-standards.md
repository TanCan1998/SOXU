# 编码规范

- TypeScript strict；不新增无理由 `any`，Vue 组件使用 `<script setup lang="ts">`，Pinia 按域拆分。
- Rust `cargo fmt`、`clippy`、`Result` 错误处理，不在主线程做长 IO。
- 单个源码文件尽量 <=400 行，>600 行说明拆分理由。
- 单元测试、边界测试与跨平台兼容用例伴随改动；UI 有基本无障碍语义。
- 代码注释解释原因和边界，不复述代码。
