/**
 * 终端 IPC 客户端：把 `commands/pty.rs` 的四个命令与 `soxu://pty-output` 事件
 * 包成一个小接口，组件不直接拼 invoke 名字。
 *
 * 浏览器预览（无 Tauri）时返回显式失败的实现：界面必须显示「终端不可用」，
 * 不能用假数据冒充真实 shell。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { isTauriRuntime } from "../workspace/bridge.ts";

/** 与 `apps/desktop/src-tauri/src/pty.rs` 的常量保持一致。 */
export const PTY_OUTPUT_EVENT_NAME = "soxu://pty-output";

export interface PtySessionView {
  ptyId: string;
  pid: number | null;
  cols: number;
  rows: number;
  shell: string;
}

export interface PtyClosedView {
  ptyId: string;
  existed: boolean;
  exited: boolean;
  exitCode: number | null;
}

export interface PtyOutputEvent {
  ptyId: string;
  seq: number;
  data: string;
}

export interface CreatePtyOptions {
  cols?: number;
  rows?: number;
  /** 不传即用平台默认 shell；后端只接受白名单内的程序名。 */
  shell?: string;
}

export interface PtyClient {
  create(sessionId: string, options?: CreatePtyOptions): Promise<PtySessionView>;
  write(ptyId: string, data: string): Promise<void>;
  resize(ptyId: string, cols: number, rows: number): Promise<void>;
  close(ptyId: string): Promise<PtyClosedView>;
  /**
   * 订阅合并后的输出。返回的 Promise 解析成取消订阅函数。
   *
   * 是 Promise 而不是同步返回：listen 是异步注册的。调用方**必须先 await 订阅、
   * 再创建 PTY**，否则 shell 最早的那段输出（ConPTY 的光标查询与首屏提示）会丢。
   */
  onOutput(handler: (event: PtyOutputEvent) => void): Promise<() => void>;
}

export function createTauriPtyClient(): PtyClient {
  return {
    create: (sessionId, options) =>
      invoke<PtySessionView>("create_pty", {
        sessionId,
        cols: options?.cols ?? null,
        rows: options?.rows ?? null,
        shell: options?.shell ?? null,
      }),
    write: (ptyId, data) => invoke<void>("write_pty", { ptyId, data }),
    resize: (ptyId, cols, rows) => invoke<void>("resize_pty", { ptyId, cols, rows }),
    close: (ptyId) => invoke<PtyClosedView>("close_pty", { ptyId }),
    async onOutput(handler) {
      const unlisten: UnlistenFn = await listen<PtyOutputEvent>(
        PTY_OUTPUT_EVENT_NAME,
        (event) => handler(event.payload),
      );
      return () => {
        unlisten();
      };
    },
  };
}

/** 浏览器预览：所有调用都显式失败，界面据此显示「终端不可用」。 */
export function createUnavailablePtyClient(reason: string): PtyClient {
  const fail = async (): Promise<never> => {
    throw new Error(reason);
  };
  return {
    create: fail,
    write: fail,
    resize: fail,
    close: fail,
    onOutput: async () => () => undefined,
  };
}

/** 运行环境选择：桌面端走真实 IPC，浏览器预览显式不可用。 */
export function createPtyClient(): PtyClient {
  return isTauriRuntime()
    ? createTauriPtyClient()
    : createUnavailablePtyClient("当前是浏览器预览，终端需要本机运行时；请用 pnpm tauri:dev 启动桌面端");
}
