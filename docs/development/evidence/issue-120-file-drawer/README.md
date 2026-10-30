# Issue #120（TASK-028）文件抽屉：界面证据

日期：2026-02-10 · 平台：Windows（Edge 内核，Moli 无头抓取）· 视图端口径：默认 1280×720

夹具：`apps/desktop/tests/harness/file-drawer.html` + `file-drawer.ts`，挂载**真实的**
`components/FileDrawer.vue` 与 `workspace/filesWorkspace.ts`，只把后端换成内存假数据
（`tests/support/fakeBridge.ts`）。因此截图反映的是生产组件的渲染与交互，不是另写的一套界面。

## 截图

| 文件 | 内容 |
| --- | --- |
| `01-light-tree.png` | 浅色主题 · 打开抽屉只读根目录一层（树形、名称升序、隐藏项默认隐藏） |
| `02-light-preview.png` | 展开 `src` 后点击 `src/main.ts`：只读预览 + shiki 语法高亮 |
| `03-dark-flat.png` | 深色主题 · 平铺视图（标签为完整相对路径，只含已加载层） |
| `04-light-delete-confirm.png` | 删除二次确认：必须输入文件名，未输入时「删除」按钮禁用 |

## 量到的数据（同一次抓取）

`metrics.json` 由夹具的 `window.__fileDrawer` 钩子直接读生产状态得到：

- 只展开 `src` 时，实际加载的目录层 = 2（根 + `src`）：懒加载生效，未读 `docs` 与 `src/components`；
- 树形行数 7；`role=treeitem` 节点 7，与行数一致（不是用 div 拼的假树）；
- 预览正文 176 字符，来自 `read_file` 的返回；
- `aria-expanded` 3 处、`aria-pressed` 6 处、`aria-label` 23 处：键盘与读屏语义随组件一起渲染。

## 复现

```powershell
# 1. 启动开发服务器（--force 避免复用其他工作区的依赖缓存）
pnpm --filter @soxu/desktop exec vite --port 1433 --strictPort --force
# 2. 抓图（无头，无需 Playwright）
$env:MOLI_LAYOUT = 'true'
moli fetch 'http://127.0.0.1:1433/tests/harness/file-drawer.html' -l --dump screenshot --wait domstable > 01-light-tree.png
# 3. 展开并预览（交互由夹具钩子驱动，逻辑仍是生产代码）
moli fetch 'http://127.0.0.1:1433/tests/harness/file-drawer.html' -l --dump screenshot --wait domstable --delay-ms 2000 --eval '(async () => { await window.__fileDrawer.expand("src"); await window.__fileDrawer.openFile("src/main.ts"); return "ok"; })()' > 02-light-preview.png
```

## 未验证（不要当成已通过）

- **没有**在真实 Tauri 窗口里跑过：截图来自同一套组件的浏览器渲染，WebView2 实机渲染与 IPC 往返仍需人工确认；
- macOS / Linux 未运行；
- 真实磁盘上的新建/重命名/删除只有 Rust 集成测试（`tests/files_bridge.rs`）覆盖，界面侧通过假后端验证调用参数；
- 预览不做编辑器保存（本切片只读）。
