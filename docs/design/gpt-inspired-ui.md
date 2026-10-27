## 当前 UI/UX 实施基线：V3

状态：已由项目所有者确认，作为后续 UI 开发基准。

### 必读文件

1. `docs/design/UIUX/V3/AGENT-IMPLEMENTATION.md`
2. `docs/design/UIUX/V3/SOXU-UIUX-V3.html`
3. `docs/design/UIUX/V3/reference/tokens.css`
4. `docs/design/UIUX/V3/README.md`

### 视觉要求

- 浅色主背景：#FCFCFC
- 深色主背景：#191717
- 统一强调色：#3A83F7
- 复用正式 SOXU S/X 图标
- 统一使用 Lucide 图标，避免手绘歪斜图标
- 遵循 V3 设计规范中的布局和交互要求

### 功能要求

- 支持普通会话和临时会话
- 临时会话默认不进入持久化历史
- 支持将临时会话转为普通会话
- 支持会话内搜索与快捷跳转
- 支持项目与会话管理
- 右侧检查器按需展示
- 保持低内存占用和按需加载

### 开发约束

- Developer 必须遵循 V3 的组件结构和 Design Tokens
- Reviewer 必须检查实现与 V3 的一致性
- 不得擅自更换已确定的配色与交互
- 使用现有 Vue 3、Tailwind 4、Reka UI、Pinia、
  @lucide/vue、@tanstack/vue-virtual
- HTML 和 reference/ 是设计参考，不是已集成的生产代码
- 未接入 Pi RPC 时，不得展示虚假的真实运行状态

### 优先级

当历史 UI 提案与 V3 冲突时，以 V3 为准。
历史设计文件仅供参考，不作为当前实施依据。



## 下一个里程碑 (M1)

1. 为真实 Pi RPC 编写 Rust/TS 类型化事件桥接，明确取消/关闭语义。
2. 会话从 Pi 的来源增量装载；不能把 Vue 本地演示消息当真实历史。
3. 项目与任务数据分别采用稳定 ID；工作树隔离，详情展示真实检查点。
4. 对话滚动采用虚拟列表，增加无障碍用例、颜色对比度/焦点/键盘回归。
5. Windows Node 26 + Rust + Tauri 实机渲染、低内存与关闭进程树的可复现验证。

## 验收和边界

本轮验收范围只覆盖源代码结构、离线状态逻辑及现有 Node 测试。Vue 编译、真实 Tauri/WebView 显示、Playwright/屏幕阅读器测试、不同 DPI/缩放比例仍需实机验证。UI 参考方向获批，并不代表上述实现已完成验收。
