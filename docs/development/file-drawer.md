# 文件抽屉：目录树与文件操作（Issue #120 / TASK-028）

右侧文件抽屉的后端契约与边界。产品行为一句话：**在项目根目录内浏览、只读预览、受约束地新建/重命名/删除**。
它不是 IDE，也不是通用文件管理器；所有路径都被限制在项目根目录内。

## 1. 分层与文件

| 层 | 文件 | 职责 |
| --- | --- | --- |
| IPC | `apps/desktop/src-tauri/src/commands/files.rs` | 参数映射与错误转字符串，不含业务判断 |
| 装配 | `apps/desktop/src-tauri/src/files/mod.rs` | 项目身份 → 根目录、`spawn_blocking` 调度、上限常量 |
| 路径守卫 | `apps/desktop/src-tauri/src/files/guard.rs` | `FileRoot`：词法校验 + 规范化落点比对 |
| 操作 | `apps/desktop/src-tauri/src/files/ops.rs` | 枚举、预览、写、删除、搜索（全部有界） |
| 契约 | `apps/desktop/src-tauri/src/dto/files.rs` | camelCase DTO，路径一律为项目内相对路径 |
| 前端逻辑 | `apps/desktop/src/workspace/filesWorkspace.ts` | 懒加载目录树、排序、树形/平铺、预览与写操作确认 |
| 组件 | `apps/desktop/src/components/FileDrawer.vue` | 渲染与表单输入 |

## 2. 命令（注册在 `lib.rs` 的 `files` 领域块）

| 命令 | 语义 | 关键约束 |
| --- | --- | --- |
| `list_dir(projectId, path)` | 列出一层目录 | **只读一层**，不递归；单层上限 2000 条，超出标记 `truncated` |
| `read_file(projectId, path)` | 只读预览 | 最多读 256 KiB；含 NUL 的内容按二进制处理且不回正文 |
| `write_file(projectId, path, content)` | 覆盖写入 | **只覆盖已存在的文件**，目标不存在时报错，不会顺手创建 |
| `create_file(projectId, path, content?)` | 新建文件 | 父目录必须存在；目标已存在（含悬空链接）一律拒绝；`create_new` 原子创建 |
| `rename_path(projectId, from, to)` | 重命名/移动 | 源与目标都必须在根内；目标不得已存在；拒绝符号链接 |
| `delete_path(projectId, path, recursive, confirmName)` | 删除 | `confirmName` 必须等于目标名称（后端校验）；非空目录需 `recursive`；根目录与链接永远不可删 |
| `search_files(projectId, query, limit?)` | 项目内文本搜索 | 深度 ≤ 12、文件数 ≤ 20000、命中 ≤ 200、单文件 ≤ 1 MiB；跳过依赖与构建产物目录 |

DTO 字段见 `dto/files.rs` 与 `workspace/types.ts`；两侧改动必须同步。

## 3. 路径守卫（P-08）

所有路径都经 `FileRoot` 解析，顺序是「先词法、后磁盘」：

1. **词法校验**：拒绝绝对路径、UNC/设备前缀、盘符写法、`..` 分量、NUL 字节，
   以及 Windows 上的保留设备名（`NUL`/`COM1`…）和以点/空格结尾的名称。
2. **落点比对**：对已存在目标 `canonicalize` 后与项目根目录**逐段**比较（不是字符串前缀比较），
   因此符号链接/目录联接跳出根目录必然被识别。
3. **待创建目标**：规范化父目录并校验在根内，目标本身用 `symlink_metadata` 判断「已存在」
   （悬空链接也算占用），随后用 `create_new` 原子创建，不留 TOCTOU 窗口。

错误码是契约（文案仅供人读）：

`E_FILES_ROOT_UNKNOWN` · `E_FILES_PATH_ABSOLUTE` · `E_FILES_PATH_TRAVERSAL` · `E_FILES_PATH_INVALID` ·
`E_FILES_PATH_OUTSIDE_ROOT` · `E_FILES_PATH_MISSING` · `E_FILES_PATH_EXISTS` · `E_FILES_PATH_IS_ROOT` ·
`E_FILES_NOT_A_FILE` · `E_FILES_NOT_A_DIR` · `E_FILES_SYMLINK_UNSUPPORTED` · `E_FILES_DIR_NOT_EMPTY` ·
`E_FILES_CONTENT_TOO_LARGE` · `E_FILES_CONFIRM_MISMATCH` · `E_FILES_QUERY_EMPTY` · `E_FILES_IO_FAILURE`

## 4. 懒加载与有界缓存

- 打开抽屉只读**根目录一层**；子目录在用户展开时才发 `list_dir`。
- 前端只缓存**已加载过的层**（`FileBrowserState.directories`），切项目时整棵树重建，
  不会残留上一个项目的条目。
- 平铺视图只展示已加载的条目，不会为了「平铺」而遍历全盘。
- 预览与搜索结果各自带请求序号，迟到响应一律丢弃（切文件/切项目不会串内容）。

## 5. 验证

```powershell
pnpm icons:generate                                   # 桌面端 Rust 测试需要图标
cargo test -p soxu-desktop --test files_bridge        # 7 个集成用例（路径穿越/懒加载/写操作/预览/搜索）
cargo test -p soxu-desktop --lib files::guard         # 词法守卫单测
node --test apps/desktop/tests/fileDrawer.test.ts     # 前端懒加载/排序/预览/删除确认
node scripts/check-command-blocks.mjs                 # files 块落位与字母序
```

界面证据（浅色目录树、shiki 预览、深色平铺、删除确认）在
[`docs/development/evidence/issue-120-file-drawer/`](evidence/issue-120-file-drawer/README.md)，
由 `tests/harness/file-drawer.html` 挂载真实组件、用无头浏览器抓取；夹具只替换后端数据。
复现命令与未验证项写在该目录的 `README.md` 里。

`tests/files_bridge.rs` 覆盖：`..` 穿越、绝对路径、符号链接/目录联接逃出根目录、懒加载只读一层、
新建/写入/重命名/删除的越界拒绝、删除确认名称校验、非空目录与根目录保护、预览截断与二进制标记、
搜索上限与依赖目录跳过、未登记项目拒绝。

平台差异：Windows 普通用户无法创建**文件**符号链接（需要开发者模式或管理员），该子用例会打印
「平台限制…跳过」；**目录**链接会退化为目录联接（junction）真实执行。详见
[越权与敏感信息回归](security-regression.md)。

## 6. 已知边界

- 不是 OS 沙箱：只保证 SOXU 自身不越界读写，不限制 Pi 子进程按自身权限访问文件。
- 预览是只读的，本切片不做编辑器保存；`write_file` 已有契约但界面暂未接线。
- 不支持对符号链接本身做重命名/删除（语义模糊且容易越界），列表里会把它标成 `symlink`。
- 文件系统变化不会自动推送：目录层靠「刷新」重新读取。
