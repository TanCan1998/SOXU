# Windows 开发说明

使用 PowerShell、Visual Studio C++ Build Tools、WebView2 Runtime、Rust stable、Node >=22.19、pnpm 10。运行 `pnpm tauri:dev` 时应在 SOXU 根目录。`git`, `gh`, `cargo`, `pnpm`, `pi` 均应在 PATH。Windows `pi` CLI 是 npm `.cmd` 包装时，Loop 使用固定 `cmd.exe /d /s /c pi --mode rpc --no-session` 命令启动。不要将 Issue 内容作为 shell 命令行参数。

部分原生模块与 Windows 安全软件可能影响测试、子进程退出；必须记录完整进程树并避免强行结束其他程序的 Node 进程。
