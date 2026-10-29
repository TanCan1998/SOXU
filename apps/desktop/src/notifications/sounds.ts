/**
 * 提示音（V4-S2b，Issue #117）。
 *
 * 全部用 Web Audio API 现场合成，不放 wav/mp3：
 * 1. 6 个预设的体积是 0 字节（`assets/sounds/` 目录不必存在，仓库不会被二进制撑大）；
 * 2. 合成参数就是可读的音符表，改音色不需要重新导出音频；
 * 3. 不依赖任何系统通知/系统音效通道——窗口隐藏到托盘时 Web Audio 仍在播，
 *    这正是 Issue #117 要求「托盘状态下也要响」的实现方式。
 *
 * 所有权：一个 player 只持有一个 AudioContext，由 `dispose()` 关闭。
 * 每次播放创建振荡器与增益节点，播完在 `onended` 里断开，不累积节点。
 */

import { clampVolume, type SoundId } from "./settings.ts";

export type ToneWave = "sine" | "square" | "triangle" | "sawtooth";

export interface ToneStep {
  wave: ToneWave;
  frequency: number;
  /** 相对整段起点的延迟（毫秒）。 */
  startMs: number;
  /** 单音时长（毫秒）。 */
  durationMs: number;
  /** 该音的峰值增益（0～1），最终还会乘以用户音量。 */
  gain: number;
}

/**
 * 六个预设。所有音频都控制在 1 秒上下：提示音是提醒，不是铃声。
 * 数值直接写成音符表，方便将来按用户反馈微调。
 */
export const SOUND_TONES: Readonly<Record<SoundId, readonly ToneStep[]>> = Object.freeze({
  chime: [
    { wave: "sine", frequency: 880, startMs: 0, durationMs: 240, gain: 0.5 },
    { wave: "sine", frequency: 1318.51, startMs: 110, durationMs: 320, gain: 0.42 },
  ],
  pop: [{ wave: "triangle", frequency: 620, startMs: 0, durationMs: 90, gain: 0.5 }],
  bell: [
    { wave: "sine", frequency: 1046.5, startMs: 0, durationMs: 520, gain: 0.46 },
    { wave: "sine", frequency: 2093, startMs: 0, durationMs: 300, gain: 0.16 },
  ],
  drop: [
    { wave: "sine", frequency: 740, startMs: 0, durationMs: 130, gain: 0.44 },
    { wave: "sine", frequency: 440, startMs: 85, durationMs: 210, gain: 0.44 },
  ],
  alert: [
    { wave: "square", frequency: 523.25, startMs: 0, durationMs: 105, gain: 0.26 },
    { wave: "square", frequency: 523.25, startMs: 155, durationMs: 105, gain: 0.26 },
    { wave: "square", frequency: 392, startMs: 310, durationMs: 180, gain: 0.28 },
  ],
  soft: [
    { wave: "sine", frequency: 523.25, startMs: 0, durationMs: 300, gain: 0.34 },
    { wave: "sine", frequency: 659.25, startMs: 140, durationMs: 320, gain: 0.28 },
  ],
});

/** 最小 Web Audio 表面：只声明真正用到的成员，测试可注入假实现。 */
export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, startTime: number): void;
  linearRampToValueAtTime(value: number, endTime: number): void;
  exponentialRampToValueAtTime(value: number, endTime: number): void;
}

export interface GainNodeLike {
  gain: AudioParamLike;
  connect(destination: unknown): void;
  disconnect(): void;
}

export interface OscillatorNodeLike {
  type: string;
  frequency: AudioParamLike;
  connect(destination: unknown): void;
  disconnect(): void;
  start(when: number): void;
  stop(when: number): void;
  onended: (() => void) | null;
}

export interface AudioContextLike {
  currentTime: number;
  state: string;
  destination: unknown;
  resume(): Promise<void> | void;
  close(): Promise<void> | void;
  createOscillator(): OscillatorNodeLike;
  createGain(): GainNodeLike;
}

export type AudioContextFactory = () => AudioContextLike | null;

export interface SoundPlayer {
  /** 播放一个预设；返回 false 表示没有音频通道或参数非法（不抛错）。 */
  play(sound: SoundId, volume: number): boolean;
  /** 关闭 AudioContext 并释放引用；重复调用安全。 */
  dispose(): void;
  /** 当前是否已经创建了 AudioContext（诊断/测试用）。 */
  readonly hasContext: boolean;
}

/** 峰值包络的起音时间（秒）：太陡会有咔哒声。 */
const ATTACK_SECONDS = 0.012;
/** 指数包络不能到 0：Web Audio 要求非零目标值。 */
const SILENCE = 0.0001;

function defaultContextFactory(): AudioContextLike | null {
  const scope = globalThis as {
    AudioContext?: new () => AudioContextLike;
    webkitAudioContext?: new () => AudioContextLike;
  };
  const Ctor = scope.AudioContext ?? scope.webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

/**
 * 创建播放器。
 *
 * AudioContext 延迟到第一次播放才创建：启动时没有任何音频需求，
 * 提前建上下文会在部分平台上多占一个音频线程。
 */
export function createSoundPlayer(
  contextFactory: AudioContextFactory = defaultContextFactory,
): SoundPlayer {
  let context: AudioContextLike | null = null;
  let disposed = false;

  function ensureContext(): AudioContextLike | null {
    if (disposed) return null;
    if (context) return context;
    context = contextFactory();
    return context;
  }

  function play(sound: SoundId, volume: number): boolean {
    const steps = SOUND_TONES[sound];
    if (!steps || steps.length === 0) return false;
    const level = clampVolume(volume);
    if (level <= 0) return false;
    const audio = ensureContext();
    if (!audio) return false;
    try {
      // 自动播放策略：上下文可能处于 suspended，播放前请求恢复。
      if (audio.state === "suspended") void audio.resume();
      const base = audio.currentTime + 0.01;
      for (const step of steps) {
        const oscillator = audio.createOscillator();
        const gainNode = audio.createGain();
        const start = base + step.startMs / 1000;
        const end = start + step.durationMs / 1000;
        const peak = Math.max(SILENCE, Math.min(1, step.gain * level));
        oscillator.type = step.wave;
        oscillator.frequency.setValueAtTime(step.frequency, start);
        gainNode.gain.setValueAtTime(SILENCE, start);
        gainNode.gain.exponentialRampToValueAtTime(peak, start + ATTACK_SECONDS);
        gainNode.gain.exponentialRampToValueAtTime(SILENCE, end);
        oscillator.connect(gainNode);
        gainNode.connect(audio.destination);
        oscillator.onended = () => {
          // 播完就断开：不 disconnect 会让节点留在图里，长时间运行会累积。
          try {
            oscillator.disconnect();
            gainNode.disconnect();
          } catch {
            // 某些实现重复 disconnect 会抛错，忽略即可。
          }
        };
        oscillator.start(start);
        oscillator.stop(end + 0.02);
      }
      return true;
    } catch {
      // 音频不可用（被策略禁用 / 设备被移除）时静默失败，绝不影响通知本身。
      return false;
    }
  }

  function dispose(): void {
    disposed = true;
    const audio = context;
    context = null;
    if (!audio) return;
    try {
      void audio.close();
    } catch {
      // 关闭失败没有补救手段，忽略。
    }
  }

  return {
    play,
    dispose,
    get hasContext() {
      return context !== null;
    },
  };
}
