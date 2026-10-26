# 架构规则

1. Rust Supervisor、Pi Protocol、Session Index、Git、PTY 分层隔离；业务不能写到 Vue 根组件或 Tauri lib.rs。
2. Session-first，`runtimeGeneration` 过滤旧事件。
3. 日志/文件处理有大小上限；跨层调用类型集中定义。
4. 不通过运行时 shell 拼接文本命令；Rust 进程启动用结构化 argv。
5. 新的原生能力先做 capability 与威胁评估。
