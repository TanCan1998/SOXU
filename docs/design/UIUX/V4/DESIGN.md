# SOXU V4 设计规范（原型阶段）

> 目标：简约高级 · 动效流畅 · 以资源占用和速度为优势
> 参考：PiDeck v0.9.8（骨架与中性灰层级）、pi-gui（会话组织）、ChatGPT（配色调性）、Cursor/Claude Code（键盘优先）

## 1. 设计原则

1. **色差分层，不用边框堆叠**：面板之间靠背景明度差 2–4% 区分，1px 边框只用于输入框和分割线。
2. **动效短促、有目的**：150–240ms，`cubic-bezier(.2,0,0,1)`。只做三件事——出现、位移、状态切换。不做装饰性循环动画。
3. **虚拟化优先**：任何列表都假设可能有一万条。DOM 节点数必须有上界。
4. **键盘可达**：所有主要动作有快捷键，命令面板是入口而非装饰。
5. **信息密度高于留白**：桌面端一屏要看到更多，行高 20–22px，不用移动端的 48px 触摸目标。
6. **无衬线单字体**：界面与正文同一字体栈，只有代码/终端用等宽。

## 2. 颜色

### 2.1 中性灰阶（GPT 调性）

浅色
```
--bg          #ffffff   应用底
--bg-sidebar  #f7f7f8   侧栏
--bg-panel    #ffffff   主面板
--bg-raised   #f2f2f3   悬浮/次级面板
--bg-hover    #ececed   悬停
--bg-active   #e3e3e5   按下/选中底
--border      #e5e5e7   分割线
--border-strong #d4d4d8 输入框
--fg          #1a1a1a   主文本
--fg-muted    #6b6b70   次文本
--fg-subtle   #9a9aa0   弱提示
```

深色（GPT 深色：中性、无蓝调）
```
--bg          #212121
--bg-sidebar  #191919
--bg-panel    #212121
--bg-raised   #2f2f2f
--bg-hover    #2a2a2a
--bg-active   #333333
--border      #383838
--border-strong #4a4a4a
--fg          #ececec
--fg-muted    #a0a0a5
--fg-subtle   #6e6e73
```

### 2.2 强调色（两套，可切换）

| 方案 | 值 | 用途 |
|---|---|---|
| **GPT 绿**（默认） | `#10a37f` | 活跃/成功/主按钮；hover `#0d8a6c` |
| SOXU 蓝（既有品牌） | `#3a83f7` | 选中/链接；hover `#2f70d8` |

语义色
```
--ok    #10a37f    --warn  #d97706    --danger #dc2626    --info #3a83f7
```
全部以 `color-mix(in srgb, <color> 12%, transparent)` 派生 12% 透明度作背景。

## 3. 字体与字号

```
font-family: "Inter", "Segoe UI", "Microsoft YaHei", system-ui, sans-serif
mono:       "JetBrains Mono", "Cascadia Code", ui-monospace, monospace
```

| token | size / line-height | 用途 |
|---|---|---|
| `--fs-micro` | 11 / 16 | 徽标、计数、快捷键提示 |
| `--fs-caption` | 12 / 18 | 次要说明、时间戳 |
| `--fs-control` | 13 / 20 | 按钮、菜单、列表行 |
| `--fs-body` | 14 / 22 | 界面正文 |
| `--fs-chat` | 15 / 24 | 会话消息（比界面正文大一档，长文可读） |
| `--fs-title` | 16 / 24 | 面板标题 |
| `--fs-heading` | 20 / 28 | 页面级标题 |

字重只用 400 / 500 / 600。

## 4. 间距 · 圆角 · 阴影

```
间距基数 4：4 8 12 16 20 24 32
圆角：sm 6 · md 8 · lg 12 · full 999
阴影（只给浮层）：
  --shadow-pop 0 8px 24px rgba(0,0,0,.12), 0 1px 2px rgba(0,0,0,.06)
  --shadow-modal 0 24px 64px rgba(0,0,0,.24)
内描边代替外阴影：inset 0 1px 0 rgba(255,255,255,.04)（深色）
```

## 5. 动效

```
--ease-out   cubic-bezier(.2, 0, 0, 1)
--dur-fast   150ms   hover、focus、图标切换
--dur-base   200ms   面板展开、列表位移、弹层出现
--dur-slow   240ms   模态、视图切换
```

规则：
- 只动 `transform` 与 `opacity`（GPU 合成），不动 `width/height/top/left`
- 高度变化用 `grid-template-rows: 0fr → 1fr` 或 `max-height` + `will-change`
- 弹层：`opacity 0→1` + `translateY(4px)→0` + `scale(.98)→1`
- 列表插入：`opacity` + 8px 上移，不逐项 stagger（超过 5 项时不 stagger）
- `prefers-reduced-motion: reduce` → 全部降为 0.01ms

## 6. 布局栅格

```
┌──────────────────────────────────────────────┐
│ topbar 44px（可拖拽区，含导航与全局搜索）        │
├────────┬──────────────────────┬──────────────┤
│ sidebar│ 会话区                 │ 检查器        │
│ 240–320│ flex:1 min 480        │ 280–360      │
│ 可折叠  │                      │ 可折叠        │
└────────┴──────────────────────┴──────────────┘
```
- 侧栏与检查器宽度可拖拽，双击恢复默认
- 窗口 < 1100px 时检查器自动折叠；< 860px 时侧栏浮层化
- 会话区最小宽度 480px，低于此只保留侧栏 + 会话

## 7. 组件规范

**按钮**
```
默认：透明底，hover --bg-hover，active --bg-active
主按钮：--accent 底 + 白字，hover 加深 8%
尺寸：sm 24px · md 28px · lg 32px（桌面端偏紧凑）
图标按钮：28×28，圆角 8，图标 16px stroke 1.75
```

**列表行**
```
高 28–32px，左内边距 8，hover 圆角 6 背景 --bg-hover
选中：--bg-active + 左侧 2px 强调色条（不用整行变色）
```

**输入框**
```
高 28–32，圆角 8，1px --border-strong
focus：边框变 --accent + 2px 外发光 color-mix(accent 20%)
```

**标签页**
```
高 32，等宽（min 96 / max 220），活动页 --bg-panel + 底部 2px accent
```

**消息流**
```
用户消息：右对齐气泡，--bg-raised，最大宽 78%
助手消息：左对齐无气泡，直接排版（GPT 风格）
工具调用：折叠块，默认 1 行摘要，展开 200ms
代码块：等宽 13px，左上角语言标签，右上角复制
```

## 8. 性能预算（与设计强相关）

| 项 | 预算 |
|---|---|
| 首屏 DOM 节点 | < 1500 |
| 会话列表同时渲染 | 视口 + 10 行 |
| 单条消息正文上限 | 20,000 字符（超出折叠） |
| 动画并发 | ≤ 3 个属性同时变化 |
| 面板展开/收起 | 不触发布局抖动（用 transform/grid-rows） |

## 9. 待验证

- GPT 绿 vs SOXU 蓝：原型提供切换，待用户选定
- 会话区正文 15px 是否偏小（PiDeck 用 16px）
- 深色底 #212121 与 #191919 的侧栏对比是否足够
