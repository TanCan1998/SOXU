# 发布就绪核验（TASK-006）

对应任务：[TASK-006](../../tasks/backlog/TASK-006.md)。里程碑 M4，依赖 TASK-001～TASK-005。

> 本文件只写**实际执行过**的核验与结论。凡是本机没跑到、或缺少凭据的项，都在
> 「未验证与限制」里显式列出，不能读成已通过。SOXU 仍是 0.1.0 预览版本，**不是已发布产品**。

## 1. 依赖前置：TASK-001～005 已合入 main

判据是「已合并到 main 的提交」，不是「PR 已打开」。只要不能确认已合入，就不算完成：

```powershell
git log --oneline --first-parent main
git branch -a --contains <commit>
```

| TASK | 交付内容（代码位置） | 合入依据 |
| --- | --- | --- |
| TASK-001 | Pi RPC Supervisor：`crates/agent-runtime` | `main` 上的 `e39ddb2`（`feat(agent-runtime)`） |
| TASK-002 | 项目与会话目录：`crates/session-index` | `main` 上的 `62f3c79`（`feat(session-index)`） |
| TASK-003 | 多会话 Vue 工作区：`apps/desktop` | `main` 上的 `bc2bb67`（`feat(desktop)`） |
| TASK-004 | 进程内存预算：`crates/resource-monitor` | `main` 上的 `6fb3c27`（`feat(runtime)`） |
| TASK-005 | Git Worktree 集成：`crates/git-worktree` | `main` 上的 `9518827`（#66，已归档 `tasks/done/TASK-005.md`） |

代码存在的旁证：上述目录都在根 `Cargo.toml` 的 workspace 成员里，且
`cargo test --workspace` 会编译并测试它们（见第 3 节实测结果）。

## 2. 一键核验：`pnpm release:readiness`

```powershell
pnpm icons:generate     # bundle.icon 是按需生成的，见第 5 节
pnpm release:readiness  # 只读、离线；退出码 0=可核验项通过，1=有阻断项，2=用法/读取错误
node scripts/check-release-readiness.mjs --json   # 机器可读报告
```

实现：`scripts/lib/release-manifest.mjs`（解析）、`scripts/lib/release-readiness.mjs`
（评估与渲染）、`scripts/check-release-readiness.mjs`（CLI）。单元测试在
`scripts/tests/release-readiness.test.mjs`，随 `pnpm check` 一起跑。

等级含义：

| 等级 | 含义 | 是否阻断发布 |
| --- | --- | --- |
| 通过 | 本机已读到证据并符合规则 | 否 |
| 注意 | 需要人工判断，本身不算失败 | 否 |
| 阻断 | 硬性不一致（版本、锁文件、图标、标识、通道） | 是 |
| 未验证 | 本机缺少凭据或平台，**不能写成通过** | 否，但必须在发布说明里披露 |

覆盖的规则：

1. `package.json` / `apps/desktop/package.json` / `tauri.conf.json` /
   `src-tauri/Cargo.toml` 的 `version` 完全一致，且匹配 `scripts/release.mjs` 与
   `scripts/check-release-context.mjs` 使用的 Tag 规则 `0.x.y[-rc.N]`。
2. `Cargo.lock` 中每个 workspace crate 的版本与其 `[package] version` 一致。
3. `pnpm-lock.yaml` 的 `importers` 覆盖 `apps/desktop`，且 `apps/desktop/package.json`
   每个直接依赖的 specifier 与锁文件一致（防 `--frozen-lockfile` 漂移）。
4. `identifier` 不是 Tauri 默认 `com.tauri.dev`，`productName` 已声明，
   `bundle.active` 与 `targets` 允许出包。
5. `bundle.icon` 声明的每个文件真实存在且格式正确（PNG 校验签名与像素尺寸，含
   `128x128@2x.png` 的 256×256；ICO 校验子图数；ICNS 校验魔数），并要求 1024×1024 源图存在。
6. `automation/policy.json` 仍是 `releaseChannel=prerelease`；`autoRelease=false` 时
   记录「必须人工显式授权」；发布相关受保护路径仍登记在 `protectedPaths`。
7. 从 `.github/workflows/release.yml` 解析平台矩阵（只读），并按当前宿主平台把其它平台
   标成「未验证」。
8. 签名/公证只看**是否配置**（环境变量是否存在、`bundle.windows.certificateThumbprint`
   是否存在），只输出布尔结论，绝不读取或回显凭据值。

## 3. 版本、锁文件、测试与 CI 的核验证据

| 项 | 命令 | 实测结果 |
| --- | --- | --- |
| 前端类型检查与前端测试 | `pnpm check` | 见第 8 节 |
| 脚本单元测试（含本任务新增用例） | `pnpm test:scripts` | 16 passed / 0 failed |
| Rust 全 workspace 测试 | `cargo test --workspace` | 184 passed / 0 failed（28 个 test target 全 `ok`，含 doctest） |
| Rust 格式 | `cargo fmt --all -- --check` | 见第 8 节 |
| 空白/冲突残留 | `git diff --check` | 见第 8 节 |
| 版本与锁文件一致性 | `pnpm release:readiness` | 4 处版本声明均为 `0.1.0`；`Cargo.lock` 6 个 crate 一致；`pnpm-lock.yaml` 19 个直接依赖一致 |

锁文件策略：CI 用 `pnpm install --frozen-lockfile` 与 `cargo test --workspace --locked`，
锁文件不匹配会直接失败，而不是悄悄升级依赖。这只证明「可复现」，不等于功能或性能验收
（P-01～P-08 各自另有验收记录）。

## 4. 跨平台构建与安装/卸载

`.github/workflows/release.yml` 声明矩阵 `ubuntu-24.04` / `windows-latest` /
`macos-latest`，但本任务**不能修改 workflow（受保护路径），也没有在 CI 上实跑过该矩阵**。

本机（Windows 11）实跑记录：

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 前端构建（`vue-tsc --noEmit` + `vite build`） | `pnpm --filter @soxu/desktop build` | 见第 8 节 |
| 图标生成 | `pnpm icons:generate` | 成功，`src-tauri/icons/` 生成 17 个文件 |
| Tauri 打包（MSI/NSIS） | `pnpm tauri:build` | **成功**，1m46s 完成 release 编译，产出 2 个安装包（下方明细） |
| 产物可启动性（非安装） | 直接运行 `target/release/soxu-desktop.exe` | 启动 8s 后仍在运行，主窗口标题为「SOXU · 索序」，随后人工终止，无残留 `soxu-desktop` 进程 |
| 安装包签名状态 | `Get-AuthenticodeSignature` | `Status=NotSigned`（与第 6 节一致，未签名） |

产出明细（本机 Windows 11，release profile）：

| 产物 | 大小 | SHA256 |
| --- | --- | --- |
| `target/release/bundle/msi/SOXU_0.1.0_x64_en-US.msi` | 3.71 MiB | `9F9286A6ECED014570DC56493150F830AC502F9E14C0918FE64E55079235056D` |
| `target/release/bundle/nsis/SOXU_0.1.0_x64-setup.exe` | 2.47 MiB | `BB21BA9BD88A45E20C8126722760F3D5125BD1F80F02501CA8A2C1B603F09518` |

产物在 `target/`（已被 `.gitignore` 忽略），不入库；哈希只对应当次本地构建，不同机器/不同
提交不可复现比较。**安装与卸载未执行**：安装 MSI/NSIS 会写注册表与系统目录，属于需要所有者
显式授权的破坏性操作，本任务没有执行，因此「安装/卸载通过」不能宣称。

安装/卸载冒烟测试（人工步骤，尚未执行，执行完才有资格写「通过」）：

1. 运行 `target/release/bundle/nsis/SOXU_0.1.0_x64-setup.exe` 安装，确认快捷方式、应用图标、
   应用名一致，首次启动能打开主窗口。
2. 启动后确认窗口标题为「SOXU · 索序」，能进入主界面（不要求连接真实 Pi 才算安装成功）。
3. 关闭应用，从「设置 → 应用」卸载，确认安装目录与快捷方式被清理，用户数据目录未被误删。
4. macOS：`*.dmg` 拖入 Applications，首次打开确认 Gatekeeper 行为与签名状态一致；
   拖到废纸篓卸载。
5. Linux：`*.deb` / `*.AppImage` 安装与 `apt remove` / 删除 AppImage，
   确认桌面入口被清理。

## 5. 图标与品牌标识

- 品牌源图：`apps/desktop/assets/soxu-master.png`（1024×1024 PNG，已提交）。
- 各平台变体由 `pnpm icons:generate`（即 `tauri icon assets/soxu-master.png`）生成到
  `apps/desktop/src-tauri/icons/`，该目录被 `.gitignore` 忽略，所以仓库不存二进制，
  构建前必须先执行生成。
- 生成入口统一：`tauri.conf.json` 的 `beforeDevCommand` / `beforeBuildCommand`、
  `ci.yml` 的「Generate approved SOXU desktop icons」步骤、`release.yml` 的同名步骤。
- `bundle.icon` 声明的 5 个文件实测校验通过：`32x32.png`(32×32)、
  `128x128.png`(128×128)、`128x128@2x.png`(256×256)、`icon.ico`(6 个子图)、
  `icon.icns`(1.8 MB)。
- 风险：图标不入库意味着构建结果依赖本机 `@tauri-apps/cli` 版本。若升级导致生成文件名或
  尺寸变化，`pnpm release:readiness` 会以「图标缺失/尺寸不符」阻断，而不是静默产出坏图标。

## 6. 签名与公证能力边界

| 项 | 当前状态 | 影响 | 谁可以提供 |
| --- | --- | --- | --- |
| Windows Authenticode | 未配置（无 `bundle.windows.certificateThumbprint`，无证书环境变量） | 安装包未签名，SmartScreen 提示未知发布者 | 所有者提供代码签名证书，审核后写入 CI secret |
| macOS 代码签名 | 未配置 | 无法签名，用户需手动允许打开 | 所有者提供 Apple Developer ID 证书 |
| macOS 公证 | 未配置 | 分发时 Gatekeeper 拦截风险 | Apple Developer 账号与 App Store Connect 凭据 |
| 更新签名（`TAURI_SIGNING_PRIVATE_KEY`） | 未配置 | 自动更新不可启用 | 单独生成并保管的签名密钥 |

边界说明：

- 本任务**不生成、不读取、不提交任何证书或密钥**。签名凭据只能由所有者通过 GitHub Actions
  secret 注入，且不得注入给 Pi 开发 Agent（见 `agents/policies/security.md`）。
- 「已配置」只代表检测到凭据存在，**不代表**验证过签名/公证结果；这两项必须在有凭据的 CI 上
  复核，当前属未验证。

## 7. 发布门禁与显式授权

现状（来自受保护配置，本任务只核对不修改）：

- `automation/policy.json`：`releaseChannel=prerelease`、`autoRelease=false`、
  `autoMerge=false`，即没有自动发布通道，发布必须由维护者显式触发。
- `scripts/release.mjs`（受保护）：要求当前分支 `main`、工作区干净、本地 HEAD 与
  `origin/main` 完全一致、`ci.yml` 对该 SHA 有成功运行、Tag 尚不存在，才创建并推送
  `v0.x.y[-rc.N]` Tag。
- `scripts/check-release-context.mjs`：发布 workflow 里独立复核「Tag 指向的 commit 属于
  `origin/main`」且该 commit 有成功 CI，再核对三处版本；不信任 Tag 名字。
- `.github/workflows/release.yml`：`prerelease: true`，权限最小化（校验作业
  `contents: read` + `actions: read`，构建作业 `contents: write`），非法 Tag 直接失败。

因此本任务**没有**执行任何 Tag、Release 或推送操作；发布通道的显式授权仍归维护者。

## 8. 本次执行记录（原样摘要）

环境：Windows 11，Node 26.10.0，pnpm 12.15.0，Rust 1.99.1，MSVC Build Tools 18。

```text
cargo test --workspace           -> 28 个 test target 全部 test result: ok，184 passed / 0 failed（含 doctest）
pnpm icons:generate              -> 退出码 0，src-tauri/icons/ 生成 17 个文件
pnpm check                       -> 退出码 0（vue-tsc --noEmit + apps/desktop 5 个测试文件 + 16 个脚本测试）
pnpm test:scripts                -> 16 passed / 0 failed
cargo fmt --all -- --check       -> 退出码 0，无差异
git diff --check                 -> 退出码 0，无空白问题
pnpm tauri:build                 -> 退出码 0，产出 msi 3.71 MiB + nsis setup 2.47 MiB
node scripts/check-release-readiness.mjs
  -> 通过 13 / 未验证 4 / 注意 0 / 阻断 0，退出码 0
     块级：版本一致(0.1.0)、Tag 规则可接受、Cargo.lock 6 crate 一致、
           pnpm-lock 19 个直接依赖一致、identifier=dev.soxu.desktop、productName=SOXU、
           bundle targets=all、5 个 bundle.icon 字节校验通过、源图 1024x1024、
           releaseChannel=prerelease、autoRelease=false、8 条受保护路径、平台矩阵 linux/windows/macos
     未验证：macOS/Linux 构建与安装卸载、Windows Authenticode、macOS 签名、macOS 公证
```

`Get-AuthenticodeSignature` 对 msi 返回 `NotSigned`，是「未签名」这一限制的直接证据，
不是推断。

## 9. 未验证与限制（不得读成通过）

- macOS / Linux 的构建、安装、卸载**未在本机验证**，只有 workflow 里的矩阵声明。
- Windows 安装/卸载冒烟是人工步骤，本次只到「产出安装包」，见第 4 节与第 8 节。
- 签名、公证、更新签名全部未配置，产物未签名。
- `pnpm release:readiness` 目前**没有接进 CI**：`.github/workflows/` 是受保护路径，
  接入需要维护者批准后单独改动（建议在 `ci.yml` 的 quality 作业里、图标生成之后加一步）。
- 该检查只覆盖静态一致性，不替代 P-01～P-08 的功能/资源验收，也不验证安装包能否启动。
- 「更新说明」目前不可按版本生成：`release.yml` 的 `releaseBody` 是固定字符串
  （「SOXU prerelease. Unsigned/not-notarized builds may require OS trust prompts.」）。
  若需要逐版本变更说明，必须由维护者改受保护 workflow，或改用带变更内容的 annotated Tag；
  本任务不能改该文件，故按限制记录而非宣称已具备。
