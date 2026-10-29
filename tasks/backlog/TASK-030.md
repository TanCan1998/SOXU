---
id: TASK-030
milestone: M1
priority: P1
dependencies: [TASK-009]
---

# 终端抽屉：PTY 集成

## 描述

右侧抽屉的终端面板。使用 portable-pty（决策已定），跨平台且 Windows 自动走 ConPTY。

## 范围

- 新增依赖 portable-pty，新增 commands/pty.rs：create_pty / write_pty / resize_pty / close_pty
- 在 lib.rs 的「pty」占位块内注册
- 前端集成 @xterm/xterm 渲染
- PTY 输出节流：后端 16ms 合并一次再推事件，不逐字节发送
- 会话关闭时确保 PTY 子进程被回收（不得留孤儿进程）
- 尺寸变化时 resize

## 验收标准

- [ ] cargo clippy 无新增 warning
- [ ] 终端可交互，输出不乱码
- [ ] 关闭会话后无残留 pwsh 进程
- [ ] 输出节流生效（大输出不卡 UI）
