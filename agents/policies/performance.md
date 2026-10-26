# 性能验收

使用同一批项目、Pi 扩展和会话基准比较 PiDeck 及 SOXU。记录操作系统、进程树 Private Bytes / RSS、WebView、Pi Node、峰值和稳态。

- 10+ 历史会话不应创建同数量空闲 Pi 进程。
- 3 个并行 Agent 作为 16GB 机器的初始测试目标，不是承诺。
- JSONL 分页读取，流式 token 合并到 UI 帧，避免无限 DOM/缓存。
- 8 小时稳定性测试无无法回收的单调增长。
