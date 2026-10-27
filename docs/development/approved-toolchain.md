# SOXU 已批准技术基线 · 2026-10-26

> **决定已批准，不等于已安装/编译验收。** 本工程为全新项目，旧 v1.x ZIP 的原型依赖不构成兼容性约束。直接依赖使用精确版本；`pnpm-lock.yaml` 与 `Cargo.lock` 必须在可联网的正式开发环境生成并提交，才能启用冻结锁文件 CI。

| 类别 | 技术 | 批准版本 |
| --- | --- | --- |
| 产品 | SOXU | 0.1.0（产品起始版本） |
| Node.js | 开发及 CI | `>=24`；开发机 Node 26；CI Node 24/26 |
| pnpm | Workspace 包管理 | `12.15.0` |
| Rust | 编译器 | `1.99.1`（`rust-toolchain.toml`） |
| Rust | Edition | `2024`（各 Crate） |
| Tauri | Rust 核心 | `=2.12.5` |
| tauri-build | Rust 构建 | `=2.7.4` |
| @tauri-apps/cli | JS 构建命令 | `2.12.4` |
| @tauri-apps/api | JS IPC | `2.12.4` |
| Vue | UI | `3.5.44` |
| Vite | 构建工具 | `8.3.5` |
| @vitejs/plugin-vue | SFC 编译 | `6.0.10` |
| TypeScript | 类型检查 | `6.0.3`（暂不切换 TS 7） |
| vue-tsc | SFC 类型检查 | `3.3.13` |
| Pinia | 状态管理 | `4.1.0` |
| Vue Router | 页面路由 | `5.4.0` |
| serde/serde_json | Rust 序列化 | 保留 1.x 范围，由 Cargo.lock 锁定具体解析版本 |

## Windows 第一次生成依赖锁文件

```powershell
cd D:\Projects\SOXU   # 示例目录，替换为你的项目位置
node --version          # 本机预期为 v26.x；最低支持 24
pnpm --version          # 需为 12.15.0
rustc --version         # rustup 应使用 1.99.1
cargo --version
pi --version

# 在可访问 npm/Cargo Registry 的网络中执行一次
pnpm install --lockfile-only
cargo generate-lockfile

# 检查 lock 文件确实已生成，然后可复现安装
Test-Path pnpm-lock.yaml
Test-Path Cargo.lock
pnpm install --frozen-lockfile

# 质量检查：切勿把未经执行的步骤标成通过
node ../soxu-agent-loop/automation/loop/src/cli.mjs models
node ../soxu-agent-loop/automation/loop/src/cli.mjs status
pnpm check
cargo fmt --all -- --check
cargo test --workspace
cargo check --workspace
pnpm tauri:dev
```

确认后同时 `git add pnpm-lock.yaml Cargo.lock`，提交 PR，CI 使用 `pnpm install --frozen-lockfile`；Cargo CI 使用 `cargo test --workspace --locked` 与 `cargo check --workspace --locked`，不允许在 CI 默默更新版本。CI 不使用 `--no-frozen-lockfile` 自动篡改依赖解析结果。

**当前环境局限：** 本轮离线沙盒只有 Node 22，无 pnpm 12/Rust，且 registry 网络查询失败，所以没法合法生成两份锁文件；它们在当前工程包中**不存在**。现有 Node 回归测试可独立运行，但不代表 Node 26/Vue/Tauri 编译成功。

## 依赖更新规则

1. 新增/升级一级依赖，由任务说明写出必要性、许可证、包体积与运行时影响，经所有者审批后修改。
2. 同一 PR 修改 manifest 与 lockfile，并用冻结锁文件模式检查。
3. 禁止使用 `latest`、`*`、`^`、`~` 等漂移范围锁定一级 JS 依赖；Cargo 的宽版本依赖需由 Cargo.lock 控制。
4. Rust/Tauri 3 Alpha、TypeScript 7、其他不稳定工具链不得擅自切换。
5. 任何实际的兼容性问题，应提供复现日志与最小调整建议，而不是静默降级。
