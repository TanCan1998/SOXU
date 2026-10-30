/**
 * Issue #122 的 DOM 夹具：把真正的 TerminalDrawer 挂进浏览器（真实 xterm.js），
 * 用确定性假后端验证「输出不乱码 + 大输出不卡 UI + 尺寸变化触发 resize + 关闭回收」。
 *
 * 只在 pnpm dev 的本地开发服务器里使用，不参与生产构建，也不连接 Pi：
 * - 后端是 FakePty：实现与 src/terminal/ptyClient.ts 相同的接口；
 * - 输出按后端的口径成块投递（一次事件 = 一批行），用来观察合并后的渲染开销；
 * - 组件本身一行不改（只通过 client 注入点换成假后端）。
 */

import { createApp, h, ref } from "vue";
import { TooltipProvider } from "reka-ui";

import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import TerminalDrawer from "../../src/components/TerminalDrawer.vue";
import { TOOLTIP_DELAY_MS, TOOLTIP_SKIP_DELAY_MS } from "../../src/components/tooltipConfig.ts";
import type {
  CreatePtyOptions,
  PtyClient,
  PtyClosedView,
  PtyOutputEvent,
  PtySessionView,
} from "../../src/terminal/ptyClient.ts";
import type { ThemeName } from "../../src/theme/theme.ts";

const PTY_ID = "pty_harness";

/** 首屏：带 ANSI 颜色、CJK、对齐列与长行，用来检查「不乱码 + 不串行」。 */
const BANNER = [
  "\u001b[38;5;114mSOXU 索序终端夹具\u001b[0m",
  "PowerShell 7.6.0 · 工作目录 F:\\workplace\\pi\\soxu",
  "",
  "\u001b[36m序号\u001b[0m  \u001b[36m模块\u001b[0m        \u001b[36m状态\u001b[0m",
  "1     pty-service   已连接",
  "2     终端抽屉      输出合并 16ms",
  "",
].join("\r\n");

interface FakeCounters {
  writes: number;
  resizes: Array<{ cols: number; rows: number }>;
  closes: number;
  emitted: number;
}

class FakePty implements PtyClient {
  readonly counters: FakeCounters = { writes: 0, resizes: [], closes: 0, emitted: 0 };
  private handlers = new Set<(event: PtyOutputEvent) => void>();
  private seq = 0;
  private cols = 80;
  private rows = 24;
  /** 一次事件包含多少行：等价于后端 16ms 合并后的一批。 */
  private readonly linesPerEvent = 50;

  async create(_sessionId: string, options?: CreatePtyOptions): Promise<PtySessionView> {
    this.cols = options?.cols ?? 80;
    this.rows = options?.rows ?? 24;
    // 首屏输出在 create 之后立刻投递：组件必须先订阅再创建才不会丢。
    queueMicrotask(() => this.emit(BANNER));
    return { ptyId: PTY_ID, pid: 4242, cols: this.cols, rows: this.rows, shell: "harness-shell" };
  }

  async write(_ptyId: string, data: string): Promise<void> {
    this.counters.writes += 1;
    // 回显：真实 shell 会把输入回显一遍。
    this.emit(data.replaceAll("\r", "\r\n"));
  }

  async resize(_ptyId: string, cols: number, rows: number): Promise<void> {
    this.cols = cols;
    this.rows = rows;
    this.counters.resizes.push({ cols, rows });
  }

  async close(ptyId: string): Promise<PtyClosedView> {
    this.counters.closes += 1;
    this.handlers.clear();
    return { ptyId, existed: true, exited: true, exitCode: 0 };
  }

  async onOutput(handler: (event: PtyOutputEvent) => void): Promise<() => void> {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** 投递 total 行，按 linesPerEvent 分批（模拟后端合并后的推送节奏）。 */
  burst(total: number): void {
    let index = 0;
    const tick = () => {
      if (index >= total) return;
      const end = Math.min(index + this.linesPerEvent, total);
      const lines: string[] = [];
      for (let line = index; line < end; line += 1) {
        lines.push("第 " + String(line + 1).padStart(4, "0") + " 行 · 输出合并检查 · 索序");
      }
      this.emit(lines.join("\r\n") + "\r\n");
      index = end;
      // 16ms 一次：与 soxu-pty-service 的 FLUSH_INTERVAL 一致。
      setTimeout(tick, 16);
    };
    tick();
  }

  private emit(data: string): void {
    this.seq += 1;
    this.counters.emitted += 1;
    const event: PtyOutputEvent = { ptyId: PTY_ID, seq: this.seq, data };
    for (const handler of this.handlers) handler(event);
  }
}

const pty = new FakePty();
const theme = ref<ThemeName>("light");
const width = ref(320);
/** 面板是否挂载：关闭按钮等价于 App.vue 里的 terminalOpen = false（卸载即回收）。 */
const visible = ref(true);
let closeClicks = 0;

document.documentElement.dataset.theme = "light";

/** 外层壳与生产一致：.app-shell 提供 flex 高度约束，否则终端会随内容无限长。 */
const Harness = {
  render: () =>
    h(
      TooltipProvider,
      { delayDuration: TOOLTIP_DELAY_MS, skipDelayDuration: TOOLTIP_SKIP_DELAY_MS },
      {
        default: () =>
          h("div", { class: "app-shell", "data-theme": theme.value }, [
            h(
              "div",
              {
                class: "main-column",
                style: { flex: "1", minWidth: "0", padding: "18px 22px" },
              },
              [
                h("strong", { style: { fontSize: "var(--fs-title)" } }, "会话正文（夹具占位）"),
                h(
                  "p",
                  { style: { fontSize: "var(--fs-body)", color: "var(--fg-muted)" } },
                  "右侧是真实的 TerminalDrawer 与真实 xterm.js；后端换成页面内的 FakePty。",
                ),
              ],
            ),
            visible.value
              ? h("div", { style: { width: width.value + "px", display: "flex", minHeight: "0" } }, [
                  h(TerminalDrawer, {
                    sessionId: "harness_ses_pty",
                    projectName: "soxu",
                    bridgeAvailable: true,
                    theme: theme.value,
                    client: pty,
                    // 与 App.vue 一致：关闭 = 卸载组件 = stop() 里的 close_pty。
                    onClose: () => {
                      closeClicks += 1;
                      visible.value = false;
                    },
                  }),
                ])
              : h("div", { style: { width: width.value + "px" } }),
          ]),
      },
    ),
};

createApp(Harness).mount("#app");

/** 探针：只读 DOM 与 FakePty 的计数，不重写被测逻辑。 */
function readState() {
  const text = document.querySelector(".xterm-rows")?.textContent ?? "";
  return {
    rows: document.querySelectorAll(".xterm-rows > div").length,
    text,
    status: document.querySelector(".tm-status")?.textContent?.trim() ?? "",
    shell: document.querySelector(".tm-shell")?.textContent?.trim() ?? "",
    writes: pty.counters.writes,
    emitted: pty.counters.emitted,
    resizes: pty.counters.resizes.length,
    lastSize: pty.counters.resizes.at(-1) ?? null,
    closes: pty.counters.closes,
    closeClicks,
  };
}

declare global {
  interface Window {
    __soxuTerminal: {
      state: () => ReturnType<typeof readState>;
      burst: (total: number) => void;
      hasLine: (line: number) => boolean;
      setTheme: (next: ThemeName) => void;
      setWidth: (next: number) => void;
      drawerBackground: () => string;
    };
  }
}

window.__soxuTerminal = {
  state: readState,
  burst: (total: number) => pty.burst(total),
  hasLine: (line: number) => {
    const text = document.querySelector(".xterm-rows")?.textContent ?? "";
    return text.includes("第 " + String(line).padStart(4, "0") + " 行");
  },
  setTheme: (next: ThemeName) => {
    theme.value = next;
    document.documentElement.dataset.theme = next;
  },
  setWidth: (next: number) => {
    // 抽屉宽度是 var(--insp-w)（320px）：外层容器与抽屉自身都要改，
    // 否则抽屉会溢出容器，点击坐标落到视口外。等价于用户拖动分隔条。
    width.value = next;
    const drawer = document.querySelector<HTMLElement>(".terminal-drawer");
    if (drawer) drawer.style.width = next + "px";
  },
  drawerBackground: () => {
    const drawer = document.querySelector(".terminal-drawer");
    return drawer ? getComputedStyle(drawer).backgroundColor : "";
  },
};
