# 首版能力和已知限制（请勿误认已实现）

- 已实现：Tauri + Vue UI 骨架，Rust command 示例，Rust 边界类型原型；Agent Loop 读取 Issues、管理 Worktree、调用 Pi RPC、审查、发 PR；GitHub CI/Release 配置，AtomGit 同步脚本。
- 未实现：SOXU 应用内部的 Git 工具、真实终端与 Pi Extensions UI；内存诊断也还没有 UI 入口
  （`crates/resource-monitor` 的采样/预算/释放指令与 Supervisor 的受管 PID 已实现并有自动化测试，
  口径与限制见 [内存预算文档](memory-budget.md)）。
- 已实现（产品运行时侧）：启动/握手的**有界重试**——网络中断与超时最多自动重试 2 次，
  次数持久化在应用数据目录（重启不重置），429/额度、鉴权失败与用户中止不重试，
  已耗尽的预算优先于剩余次数（失败关闭），退避等待可被「停止」立即打断，
  右侧检查器显示次数与费用提示；仅 Windows 开发环境验证，真实断网与 macOS/Linux 未验证，
  详见[网络超时有界重试](network-retry.md)。
- 临时会话（默认不进入历史）已实现：登记只存在于内存、重启后不残留，可显式转正为普通会话。
  但转正需要显式绑定 Pi 会话文件，而桌面端还没有文件选择入口、Pi 也不回报自己的会话文件路径，
  因此 UI 目前只能显示 `E_TEMPORARY_SESSION_UNPROMOTABLE` 的明确原因，而不是假装保存成功；
  转正与结束还要求**先停止运行时**（`E_TEMPORARY_SESSION_RUNTIME_ACTIVE`），否则旧 Pi 会失去 owner、
  同一 JSONL 可能被双写；
  契约见[会话目录与 JSONL 索引契约](../architecture/session-catalog.md)，集成细节见
  [多会话工作区](multi-session-workspace.md)。
- 长会话（P-04）的前端边界已实现并有 50,000 条离线夹具：首屏只读一页、Tab 最多保留
  240 条历史 / 2,000,000 字符、单条正文 ≤ 20,000 字符、虚拟列表只渲染视口内的行。但分页方向仍是
  「从最早一条往后」，打开长会话先看到最早一页；DOM 与内存数字来自 Chromium 开发服务器与 Node
  夹具，**不是 Tauri WebView 实机验收**，macOS/Linux 与真实 5 万事件会话未验证。见
  [长会话虚拟列表与 5 万事件回归](long-session-virtual-list.md)。
- 系统托盘已实现（Issue #90）：点窗口关闭只隐藏到托盘，进程与运行中的 Pi 会话继续存活；
  托盘左键与菜单「显示窗口」恢复窗口，菜单「退出」才真正结束进程（仍走 `RunEvent::Exit` 回收受管 Pi 进程）。
  隐藏到托盘后托盘 tooltip 会变成「已最小化到托盘 · 单击图标显示窗口」，恢复可见时改回品牌名
  （Issue #101）；**没有加原生通知**，因此窗口消失瞬间界面内没有任何提示，唯一反馈是托盘 tooltip，
  而 Windows 11 默认把新图标收进「隐藏的图标」溢出区，tooltip 文本本身也没有取得截图/UIA 证据
  （见[关闭按钮与隐藏反馈排查](evidence/issue-101-close-feedback/README.md)）。
  只在 Windows 本机做了**消息级**验证（见[托盘实机证据](evidence/issue-90-tray/README.md)），
  真实鼠标点击与「图标是否露在任务栏」未肉眼确认；托盘创建失败时回落到「关闭即退出」，
  Linux 需要运行时存在 `libayatana-appindicator`，macOS 未验证。
- 未集成验证：当前构建环境无 Pi 模型认证；GitHub PR 权限及外部 API 尚需在实际开发机验证。
- Windows 安装包已能在本机产出（MSI/NSIS，见[发布就绪核验](release-readiness.md)），但**安装/卸载冒烟、
  macOS 与 Linux 构建、签名与公证均未验证**；产物当前未签名。
- 桌面图标不入库：`apps/desktop/src-tauri/icons/` 由 `pnpm icons:generate` 从
  `apps/desktop/assets/soxu-master.png` 生成，构建前必须先执行；`pnpm release:readiness` 会核验。
- 发布就绪检查（`scripts/check-release-readiness.mjs`）目前只能本地运行，尚未接入 CI
  （`.github/workflows/` 为受保护路径，需维护者批准后单独改动）。
- 自动化需单机 Coordinator，异常中断不会强制回收全部 agent 子孙进程。AtomGit 自动同步优先交给平台自身配置。
- 治理路径 guard、提示词规范和移除明文 token **不能替代 OS 沙箱**，生产使用请隔离执行账户。
- 越权路径与敏感信息回归（P-08）只在 Windows 本机实机跑过：目录联接、`..` 穿越、越界读写、
  凭据文件不进界面 DTO、提交门禁拦密钥均已验证；**文件符号链接因普通用户无权限而跳过**，
  macOS/Linux 未实机验证。覆盖矩阵与平台差异见[越权与敏感信息回归](security-regression.md)。
- 依赖可复现：`pnpm-lock.yaml`、`Cargo.lock` 已入库，CI 使用 `--frozen-lockfile` / `--locked`；
  `pnpm agent:doctor` 可离线核对它们与批准版本（见 [M0 退出证据与 M1 Windows 冒烟](m0-m1-exit-evidence.md)）。
- Windows 启动与 Pi RPC 冒烟（P-02 协议层）已在实机跑过并留有原始报告，但
  **应用级**会话恢复（Tauri 窗口重启、前端状态还原）与 macOS/Linux 冒烟仍未验证；
  `pnpm smoke:rpc` 会真实调用模型，未接入 CI。
