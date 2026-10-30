<!--
  终端抽屉（Issue #122 · TASK-030）：右侧面板里的真实 shell。

  分工：
  - 本组件只做「挂 xterm + 转发事件」；尺寸口径、去重闸门、状态文案在
    src/terminal/terminalPanel.ts（Node 测试可覆盖），IPC 在 src/terminal/ptyClient.ts。
  - 后端（soxu-pty-service）已经按 16ms 合并输出，这里收到的事件是成块的；
    组件不再做二次节流，否则会与后端窗口叠加成可见延迟。

  生命周期（资源有单一 owner，都在本组件里收口）：
  - 挂载：**先订阅输出**，再建 PTY，再打开 xterm，最后装 ResizeObserver；
  - 卸载：取消订阅 → 断开观察器 → 释放 xterm → close_pty（后端负责杀子进程）。

  为什么切换会话就重建终端：一个 PTY 就是一个常驻 shell 进程。若按会话保留，
  用户切走的会话会留下后台 shell（内存与进程树都不可控）。这里选择「一次只活一个」，
  代价是切换会话后终端历史清空——与「不增加后台常驻进程」的约束一致。

  为什么不绑定 Escape 关闭：Escape 在 vim / less / 菜单里是真实按键，
  抽屉抢走它就等于把终端弄坏。关闭只走标题栏按钮与顶栏快捷键。
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { SquareTerminal, X } from "@lucide/vue";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XtermTerminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import AppTooltip from "./AppTooltip.vue";
import { createPtyClient, type PtyClient } from "../terminal/ptyClient.ts";
import {
  TERMINAL_SCROLLBACK,
  closeSummary,
  createOutputBuffer,
  createResizeGate,
  resolveInitialSize,
  shouldAcceptOutput,
  terminalStatusText,
  type TerminalSize,
  type TerminalStatus,
} from "../terminal/terminalPanel.ts";
import type { ThemeName } from "../theme/theme.ts";

const props = defineProps<{
  /** 终端绑定的会话；null 表示没有打开的会话（抽屉仍显示，但只给提示）。 */
  sessionId: string | null;
  /** 会话所属项目名，仅用于标题栏。 */
  projectName: string;
  bridgeAvailable: boolean;
  theme: ThemeName;
  /**
   * 注入点：默认按运行环境创建真实 IPC 客户端。
   * 只有本地夹具（tests/harness/terminal.ts）会传假客户端——生产代码永远不传。
   */
  client?: PtyClient;
}>();

const emit = defineEmits<{
  (event: "close"): void;
}>();

const host = ref<HTMLDivElement | null>(null);
const status = ref<TerminalStatus>("starting");
const errorMessage = ref<string | null>(null);
/** 关闭结论：`exited: false` 时必须如实提示可能有残留进程。 */
const notice = ref<string | null>(null);
const shellName = ref<string | null>(null);

const client: PtyClient = props.client ?? createPtyClient();
let term: XtermTerminal | null = null;
let fitAddon: FitAddon | null = null;
let observer: ResizeObserver | null = null;
let unsubscribe: (() => void) | null = null;
let ptyId: string | null = null;
let lastSeq = 0;
let disposed = false;
/**
 * 创建返回前的输出缓冲：订阅必须早于创建，但 ptyId 要等创建返回才知道。
 * 这段窗口里的输出先缓冲，拿到 ptyId 后按序补写（有界，见 createOutputBuffer）。
 */
const outputBuffer = createOutputBuffer();
let resizeFrame = 0;
let pendingSize: TerminalSize | null = null;

const statusText = computed(() => terminalStatusText(status.value));
const canStart = computed(() => props.bridgeAvailable && props.sessionId !== null);
const title = computed(() => (props.projectName ? props.projectName + " · 终端" : "终端"));

/** 从计算样式里取 token 值：xterm 只认具体颜色/字体，不认 var() 引用。 */
function tokenValue(element: HTMLElement, name: string, fallback: string): string {
  return getComputedStyle(element).getPropertyValue(name).trim() || fallback;
}

/**
 * 终端字号（px 数值，xterm 的 API 只收数字）。
 * 取 --fs-caption（12.5px）作为基准，并跟随 --soxu-font-scale 的字号档位。
 */
function terminalFontSize(element: HTMLElement): number {
  const base = Number.parseFloat(tokenValue(element, "--fs-caption", "12.5"));
  const scale = Number.parseFloat(tokenValue(element, "--soxu-font-scale", "1"));
  const size = base * (Number.isFinite(scale) && scale > 0 ? scale : 1);
  return Number.isFinite(size) && size > 0 ? size : 12.5;
}

/**
 * xterm 的配色取自 V4 token（不写死颜色）：`--code-bg` 是终端底色，
 * `--fg` 是正文，`--accent` 是光标。深浅色切换时重算一次即可。
 */
function tokenTheme(element: HTMLElement): ITheme {
  return {
    background: tokenValue(element, "--code-bg", "#111111"),
    foreground: tokenValue(element, "--fg", "#e6e6e6"),
    cursor: tokenValue(element, "--accent", "#3a83f7"),
    cursorAccent: tokenValue(element, "--code-bg", "#111111"),
    selectionBackground: tokenValue(element, "--bg-active", "#3a3a3a"),
    selectionForeground: tokenValue(element, "--fg", "#e6e6e6"),
  };
}

/** 把当前尺寸发给后端；同一尺寸不重复发（见 createResizeGate）。 */
const resizeGate = createResizeGate((size) => {
  if (!ptyId) return;
  void client.resize(ptyId, size.cols, size.rows).catch((error: unknown) => {
    // resize 失败不致命：终端仍可用，只是全屏程序排版可能不准。
    console.warn("SOXU: 调整终端大小失败", error);
  });
});

/** 把每帧触发的 onResize 合并成一次 IPC（requestAnimationFrame 天然按帧合并）。 */
function scheduleResize(size: TerminalSize) {
  pendingSize = size;
  if (resizeFrame) return;
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0;
    const next = pendingSize;
    pendingSize = null;
    if (!next) return;
    resizeGate.request(next);
  });
}

function fit() {
  if (!term || !fitAddon || !host.value) return;
  // 容器不可见（抽屉刚打开、尺寸还是 0）时 proposeDimensions 返回 undefined：
  // 此时不 fit，否则 xterm 会被压成最小列数并在恢复显示后留下错误排版。
  const proposal = fitAddon.proposeDimensions();
  if (!proposal) return;
  fitAddon.fit();
  scheduleResize({ cols: term.cols, rows: term.rows });
}

async function start() {
  if (!canStart.value || !props.sessionId) {
    status.value = "closed";
    return;
  }
  await nextTick();
  const element = host.value;
  if (!element) return;

  const terminal = new XtermTerminal({
    scrollback: TERMINAL_SCROLLBACK,
    // 字体必须是具体栈：xterm 用 canvas 量字宽，var() 它解析不了。
    // 取 --soxu-font-family-mono，终端因此跟随「设置 → 代码字体」档位（Issue #116）。
    fontFamily: tokenValue(element, "--soxu-font-family-mono", "monospace"),
    fontSize: terminalFontSize(element),
    cursorBlink: true,
    convertEol: false,
    theme: tokenTheme(element),
    allowProposedApi: false,
  });
  const addon = new FitAddon();
  terminal.loadAddon(addon);
  terminal.open(element);
  term = terminal;
  fitAddon = addon;

  // 输入：xterm 已经处理了按键、粘贴与 IME 组合，这里原样转发。
  terminal.onData((data) => {
    if (!ptyId) return;
    void client.write(ptyId, data).catch((error: unknown) => {
      console.warn("SOXU: 写入终端失败", error);
    });
  });
  terminal.onResize(({ cols, rows }) => scheduleResize({ cols, rows }));

  // 先订阅再创建：PTY 一存在就可能开始输出（ConPTY 先发光标查询），
  // 订阅晚一步就会丢掉首屏内容，表现为「终端里什么都没有」。
  const off = await client.onOutput((event) => {
    if (ptyId === null) {
      // 创建还没返回：先缓冲，别把首屏（提示符、ConPTY 的光标查询）丢掉。
      outputBuffer.push(event);
      return;
    }
    if (event.ptyId !== ptyId) return;
    if (!shouldAcceptOutput(lastSeq, event.seq)) return;
    lastSeq = event.seq;
    term?.write(event.data);
  });
  if (disposed) {
    off();
    return;
  }
  unsubscribe = off;

  try {
    const view = await client.create(props.sessionId, resolveInitialSize(addon.proposeDimensions()));
    if (disposed) {
      // 创建过程中用户已经关掉抽屉：立刻回收，别把 shell 留在后台。
      void client.close(view.ptyId);
      return;
    }
    ptyId = view.ptyId;
    shellName.value = view.shell;
    lastSeq = 0;
    // 补写缓冲里属于这个终端的输出（按到达顺序，seq 单调）。
    for (const event of outputBuffer.take(view.ptyId)) {
      if (!shouldAcceptOutput(lastSeq, event.seq)) continue;
      lastSeq = event.seq;
      terminal.write(event.data);
    }
    status.value = "ready";
    resizeGate.reset();
    fit();
    terminal.focus();
  } catch (error) {
    status.value = "error";
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

async function stop() {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (resizeFrame) {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = 0;
  }
  pendingSize = null;
  outputBuffer.clear();
  if (term) {
    term.dispose();
    term = null;
  }
  fitAddon = null;
  if (!ptyId) return;
  const closing = ptyId;
  ptyId = null;
  try {
    const closed = await client.close(closing);
    notice.value = closeSummary(closed);
    if (!closed.exited) console.warn("SOXU: 终端进程可能残留", closed);
  } catch (error) {
    notice.value = "终端已关闭";
    console.warn("SOXU: 关闭终端失败", error);
  }
}

/** 打开抽屉时由 App.vue 调用：快捷键之后用户的第一动作就是敲命令。 */
function focus() {
  term?.focus();
}

defineExpose({ focus });

function close() {
  emit("close");
}

/** 主题切换：只换配色，不重建终端（重建会丢掉滚动缓冲）。 */
watch(
  () => props.theme,
  () => {
    if (term && host.value) term.options.theme = tokenTheme(host.value);
  },
);

onMounted(async () => {
  await start();
  if (host.value) {
    observer = new ResizeObserver(() => fit());
    observer.observe(host.value);
  }
  // 抽屉是从 0 高度展开的：首帧测量必然偏小，等一帧再对齐一次。
  requestAnimationFrame(() => fit());
});

onBeforeUnmount(() => {
  disposed = true;
  void stop();
});
</script>

<template>
  <aside class="terminal-drawer" aria-label="终端">
    <header class="tm-head">
      <div class="tm-title">
        <SquareTerminal :size="15" :stroke-width="1.9" aria-hidden="true" />
        <strong>{{ title }}</strong>
        <span class="tm-shortcut" aria-hidden="true"><kbd>Ctrl</kbd><kbd>`</kbd></span>
      </div>
      <AppTooltip text="关闭终端">
        <button class="icon-button" type="button" aria-label="关闭终端" @click="close">
          <X :size="17" :stroke-width="1.75" aria-hidden="true" />
        </button>
      </AppTooltip>
    </header>

    <div class="tm-meta" role="status">
      <span class="tm-status" :data-tone="status === 'error' ? 'danger' : undefined">
        {{ statusText }}
      </span>
      <span v-if="shellName" class="tm-shell">{{ shellName }}</span>
    </div>

    <p v-if="errorMessage" class="tm-error" role="alert">{{ errorMessage }}</p>
    <p v-else-if="!bridgeAvailable" class="tm-hint">
      终端需要本机运行时。浏览器预览下无法启动 shell。
    </p>
    <p v-else-if="!sessionId" class="tm-hint">打开一个会话后即可在这里执行命令。</p>
    <p v-if="notice" class="tm-hint">{{ notice }}</p>

    <div ref="host" class="tm-host" :data-hidden="!canStart ? 'true' : undefined"></div>
  </aside>
</template>

<style scoped>
.terminal-drawer {
  width: var(--insp-w);
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg-panel);
  border-left: 1px solid var(--border);
  color: var(--fg);
}

.tm-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}

.tm-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: var(--fs-caption);
  color: var(--fg);
}

.tm-title strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.tm-shortcut {
  display: inline-flex;
  gap: 2px;
  color: var(--fg-subtle);
}

.tm-shortcut kbd {
  padding: 1px 4px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  font-family: var(--soxu-font-family-mono);
  font-size: var(--fs-micro);
}

.tm-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  font-size: var(--fs-micro);
  color: var(--fg-subtle);
}

.tm-status[data-tone="danger"] {
  color: var(--danger);
}

.tm-shell {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--soxu-font-family-mono);
}

.tm-error,
.tm-hint {
  margin: 0;
  padding: 0 12px 6px;
  font-size: var(--fs-micro);
  line-height: 1.7;
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}

.tm-error {
  color: var(--danger);
}

.tm-host {
  flex: 1;
  min-height: 0;
  padding: 6px 8px 10px;
  background: var(--code-bg);
  overflow: hidden;
}

/* 没有会话时把 xterm 容器让出来，提示文案占据面板主体。 */
.tm-host[data-hidden="true"] {
  flex: 0 0 auto;
  height: 0;
  padding: 0;
}
</style>
