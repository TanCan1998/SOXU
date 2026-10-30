# 后端命令层的领域块约定（Issue #112）

本文件规定 Tauri 命令层的模块划分，以及新增 command 时必须遵守的落位规则。
规则不是口头约定：`scripts/check-command-blocks.mjs` 会机器校验，`pnpm check` 会跑它。

## 1. 为什么需要领域块

V4 要在后端新增约 27 个 command。拆分前所有 command 都写在同一个 `commands.rs`、
所有 DTO 都写在同一个 `dto.rs`，并且每个新 command 都追加在
`generate_handler![...]` 的同一个锚点（最后一条注册之后）。
结果是任何两个后端切片都必然在同样的三行上冲突，并行度实际被压到 1。

现在：

- 命令与 DTO 按领域拆成模块目录，切片只碰自己领域的文件；
- `lib.rs` 预先切出领域注释块，插入点物理分开，三方合并不再撞同一行。

## 2. 目录布局

```
apps/desktop/src-tauri/src/
    lib.rs                  run() + generate_handler![...]（只做领域块登记）
    commands/
        mod.rs              只做 pub use 再导出，保持 commands::<name> 路径
        session.rs          启动/发送/取消/停止、运行时状态、事件订阅计数
        workspace.rs        应用信息、项目枚举/登记/刷新
        worktree.rs         工作树枚举/创建/差异/删除/清理
        history.rs          历史分页、正文按需读取、会话内搜索、临时会话生命周期
        files.rs            文件抽屉：目录枚举、只读预览、新建/重命名/删除、文件内搜索（Issue #120）
        stats.rs            会话统计（上下文环 / 统计浮窗 / 底部统计行）
    dto/
        mod.rs              只做 pub use 再导出，保持 crate::dto::<Type> 路径
        session.rs          会话/历史/运行时 DTO
        workspace.rs        项目/工作区 DTO
        worktree.rs         工作树 DTO
        files.rs            文件抽屉 DTO（相对路径、条目、预览、写结果、搜索命中）
        stats.rs            会话统计 DTO（Issue #119）
```

`mod.rs` 只允许 `mod x;` + `pub use x::*;`。不要在这里写业务代码或结构体：
一旦有人在 `mod.rs` 里加东西，它又会变成所有切片的共同锚点。

## 3. 新增 command 的落位规则（强制）

> 新增 Tauri command 时，只能追加到 `lib.rs` 中对应领域的占位块内；
> 不得在其他领域块内插入。同一领域一次只允许一个并行切片。

配套细节：

1. 先在本领域的 `commands/<domain>.rs` 中定义 `#[tauri::command]` 函数；
2. 再在 `lib.rs` 里 `// ── <domain> ──` 注释下方追加 `commands::<name>,`；
3. 块内条目按字母序排列（减少无意义 diff，也让插入位置唯一）；
4. 不得删除、重命名或重排预置的领域块。

## 4. 占位块不够时的扩块规则

| 情形 | 处理 | 是否串行 |
|---|---|---|
| 同领域加 command | 直接加在自己块内 | 否，可并行 |
| 需要全新领域块 | 该 PR 独占 `lib.rs`，期间不放其他后端切片 | 是 |
| 单领域块超 10 行 | 拆子领域块（如 files-read / files-write） | 是（一次性） |

新增领域块时，同时更新 `scripts/check-command-blocks.mjs` 的 `DOMAIN_ORDER`
和本文件的第 6 节，否则门禁会拒绝未知块。

## 5. 机器校验

```
node scripts/check-command-blocks.mjs     # 仓库根目录，或用 -- 传入其它根目录
pnpm check                                # 门禁里已经包含这一步
```

脚本做五件事：

1. 解析 `generate_handler![...]`，按 `// ── 领域名 ──` 切块；
2. 断言每条 `模块::command` 落在与其所属模块名一致的块内
   （`commands::search_session` 的定义在 `commands/history.rs`，所以必须在 history 块）；
3. 断言领域块顺序与固定列表一致；
4. 断言块内条目按字母序排列；
5. 断言 `src/commands/*.rs` 中每个 `#[tauri::command]` 都已注册，且没有重复注册。

失败信息会指出行号、所在块和应属块，例如：

```
❌ lib.rs:23 第 23 行的 commands::search_session 在块「files」内，应属于「history」块
```

回归测试：`node --test scripts/tests/command-blocks.test.mjs`（含真实仓库与临时目录夹具）。

`.github/workflows/` 属于受保护路径，本切片未修改它；校验已通过 `pnpm check`
进入 CI 的 `quality` 作业，因此 PR 上依然会被拦。

## 6. 领域块的固定顺序

```
session → workspace → worktree → history
        → files → git → pty → model → stats → outline → extension → notify → search
```

前四个是拆分时已有内容的领域块；后九个是 V4 预置的占位块
（`files` 已由 Issue #120 填入 7 个文件抽屉命令，其余仍为空）。
顺序固定，任何重排都会让后续所有切片的 diff 失效。

## 7. 边界

本约定只约束「命令登记在哪一行」，不约束业务逻辑：命令层仍然只做参数映射与错误转字符串，
业务留在 `workspace` / `session_runtime` / `worktree`。
