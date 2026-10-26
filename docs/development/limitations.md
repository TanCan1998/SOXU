# 首版能力和已知限制（请勿误认已实现）

- 已实现：Tauri + Vue UI 骨架，Rust command 示例，Rust 边界类型原型；Agent Loop 读取 Issues、管理 Worktree、调用 Pi RPC、审查、发 PR；GitHub CI/Release 配置，AtomGit 同步脚本。
- 未实现：SOXU 应用内部的 Pi Runtime Supervisor、工作会话持久化、Git 工具、真实终端与 Pi Extensions UI。任务列在 backlog。
- 未集成验证：当前构建环境无 Rust/pnpm/GitHub CLI/Pi 模型认证；完整 Tauri 安装包、GitHub PR 权限及外部 API 尚需在实际开发机验证。
- 自动化需单机 Coordinator，异常中断不会强制回收全部 agent 子孙进程。AtomGit 自动同步优先交给平台自身配置。
- 治理路径 guard、提示词规范和移除明文 token **不能替代 OS 沙箱**，生产使用请隔离执行账户。
- 初期没有确定上游依赖锁文件；首次安装需要生成并提交 pnpm-lock.yaml、Cargo.lock，CI 后续切换 frozen/locked 以保证可复现。
