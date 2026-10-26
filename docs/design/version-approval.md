> **历史草案已被新项目选型讨论取代**：新项目 Node.js 最低 >=24，本地 Node 26；Rust Edition 2024 候选；pnpm / TypeScript / Pinia / Router 等版本需重新批准。本表其余推荐版本为旧草案，**不应直接执行**。

# SOXU 根目录及主要依赖版本审批提案（未生效）

> 2026-10-26；**此表是审批草案，不代表已修改版本锁定或安装成功。** 架构已确定：Rust + Tauri + Vue 3 + TypeScript + Vite，pnpm Monorepo。

| 范围 | 旧工程（ZIP 源码声明） | 建议 | 说明 |
|---|---|---|---|
| SOXU 应用版本 | 0.1.0 | **0.1.0** | 保留开发预览阶段语义化版本 |
| Node.js | >=22.19.0 | **24.x LTS**（以已装 24.21.0 作为本机候选） | 优先选择 LTS；26.10.0 作为单独兼容性测试路线 |
| pnpm | 10.18.0 | **11.28.8** | 与现有开发机一致；先评估 lockfile/工作区迁移影响 |
| Rust | stable | **stable + 生成可审计锁定文件** | 实际 rustc 版本及 target 需要开发机确认，不在此猜测 |
| Tauri（Rust crate） | 2（浮动） | **2.12.x 稳定线** | 3.0 仍处 Alpha，不作为正式基础 |
| @tauri-apps/cli | ^2.0.0 | **2.12.4** | 与 Rust Tauri 2 同主版本 |
| @tauri-apps/api | ^2.0.0 | **2.12.x** | 与 Tauri 2 同主版本，锁定准确补丁版本前需要安装测试 |
| @tauri-apps/build | 无（Rust `tauri-build` v2） | **tauri-build 2.x 匹配 Tauri** | Rust 依赖与 CLI 版本不必数字完全一致 |
| Vue | ^3.5.0 | **3.5.44** | 稳定版本；不引入 3.6 RC |
| Vite | ^7.0.0 | **8.3.5** | 已确认使用 Vite；具体版本待本表批准 |
| @vitejs/plugin-vue | ^6.0.0 | **6.0.10** | 与 Vite 8 组合待构建验证 |
| TypeScript | ~5.9.0 | **5.9.x 暂保留** | 7.0.2 虽已发布，但整套 vue-tsc/插件兼容性先验证再升级 |
| vue-tsc | ^3.1.0 | **3.3.13** | 待与选定 TS 版本组合验证 |
| Pinia | ^3.0.0 | **3.0.x 暂保留** | 4.1.0 是新主版本；升级需确认状态管理迁移风险 |
| Vue Router | ^4.5.0 | **4.x 暂保留** | 5.4.0 是新主版本；升级需确认路由 API 兼容性 |
| serde / serde_json | ^1 | **1.x** | 按 cargo.lock 冻结具体补丁 |
| Pi Agent Runtime | 未锁定 | **待开发机实测后再锁定** | 先核查 CLI 版本、RPC 协议和 Provider 兼容性 |

## 建议的版本治理策略

1. **审批前不修改** `package.json`、`Cargo.toml`、`rust-toolchain.toml`、`tauri.conf.json` 的版本声明。本轮只写提案、优化恢复代码与新增测试。
2. 批准后统一修改根目录及子包，使用 `pnpm-lock.yaml` 和 `Cargo.lock` 锁定解析结果；安装 CI 用 `pnpm install --frozen-lockfile`；可执行工具链通过固定的版本文件及 CI 一致性检查。
3. 过渡期先运行 Node 24 LTS / 26 Current 两组兼容性测试；Windows 与 Linux 原生 Tauri 构建通过后才升级 CI/发布门禁。
4. 生产发布避免 `tauri 3 alpha`、`Vue 3.6 RC`、`TypeScript 7.1 beta` 等预发布版本。
5. 目标是最少依赖和低内存，不因为“更新”引入 Pinia 4、Vue Router 5 或额外 UI 全家桶；引入任一运行时库都需要记录包体及内存基线。

## 当前本轮验证边界

在当前工作容器运行了 Node.js 脚本测试，**未执行 pnpm install、vue-tsc、vite build、cargo test、Tauri 打包**（当前容器缺少 pnpm 与 Rust 环境）。因此无法声称提案中的新版依赖已经通过构建。

## 用户审批点

- 根目录：`SOXU 0.1.0`、`Node 24.x LTS`、`pnpm 11.28.8`、`Rust 稳定固定版本`；
- 主要依赖：`Tauri 2.x`、`Vue 3.5.x`、`Vite 8.3.x`、`TypeScript 5.9.x`，以及保留 Pinia 3 / Router 4 的迁移策略；
- Pi Runtime 的**确切**版本只能在开发机实际检查之后补齐，再做最终锁定。

查询记录（2026-10-26）：Vite npm: https://www.npmjs.com/package/vite；Vue npm: https://www.npmjs.com/package/vue；Tauri releases: https://github.com/tauri-apps/tauri/releases；Node 维护计划: https://github.com/nodejs/Release；pnpm npm: https://www.npmjs.com/package/pnpm。
