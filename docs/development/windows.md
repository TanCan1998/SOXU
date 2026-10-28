# Windows 开发说明

使用 PowerShell 7、Visual Studio C++ Build Tools、WebView2 Runtime、Node >=24（本机 26）、
pnpm 12.15.0、Rust 1.99.1（见 `rust-toolchain.toml`）；完整基线见
[approved-toolchain.md](approved-toolchain.md)。运行 `pnpm tauri:dev` 时应在 SOXU 根目录。`git`, `gh`, `cargo`, `pnpm`, `pi` 均应在 PATH。Windows `pi` CLI 是 npm `.cmd` 包装时，Loop 使用固定 `cmd.exe /d /s /c pi --mode rpc --no-session` 命令启动。不要将 Issue 内容作为 shell 命令行参数。

部分原生模块与 Windows 安全软件可能影响测试、子进程退出；必须记录完整进程树并避免强行结束其他程序的 Node 进程。

## 环境自检与 RPC 冒烟

```powershell
pnpm agent:doctor   # 只读：版本、锁文件、rust-toolchain.toml
pnpm smoke:rpc      # 真实调用模型 1~2 次，会产生费用；退出码 0=全部通过
```

`agent:doctor` 失败时退出码为 1，报告里会写明实际值与要求值；它不会自动改版本或补锁文件。
`smoke:rpc` 只覆盖 Pi RPC 协议层（握手、流式、中止、同会话重启恢复），不覆盖 Tauri 窗口重启与前端状态恢复。
实测记录与原始报告见 [M0 退出证据与 M1 Windows 冒烟](m0-m1-exit-evidence.md)。
