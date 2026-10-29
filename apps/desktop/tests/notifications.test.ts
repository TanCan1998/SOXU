/**
 * 回归测试：通知系统（V4-S2b，Issue #117）。
 *
 * 覆盖 Issue 验收里可确定性验证的部分：
 * - 事件分类：三类事件各自的判定依据，以及「不该提醒」的情形；
 * - 时长策略：全局时长覆盖调用方，错误类不受全局影响，常驻返回 null；
 * - 历史上限：内存数组有界、时间倒序、重启清空（不落 localStorage）；
 * - Toast 队列：最多 4 条可见、超出排队、关一条补一条、交互请求去重；
 * - 声音：6 个预设、音量夹紧、无音频通道时静默失败、dispose 关闭上下文；
 * - 焦点：有焦点 / 失焦 / 隐藏到托盘 三种情形的判定与订阅清理。
 *
 * store 状态机与事件流接线在 `notificationStore.test.ts`（同一套夹具，分开是为了单文件不失控）。
 *
 * 真实浏览器里的弹窗动效、悬停暂停与试听由
 * apps/desktop/tests/harness/shoot-issue-117-toast.mjs 采集，见
 * docs/development/evidence/issue-117-v4-s2b-toast/README.md。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyRuntimeEvent,
  type NotificationEvent,
} from "../src/notifications/events.ts";
import { isWindowFocused, watchWindowFocus } from "../src/notifications/focus.ts";
import { createFocusTargetForTests } from "./support/focusTarget.ts";
import {
  MAX_NOTIFICATION_HISTORY,
  appendNotification,
  formatNotificationClock,
  type NotificationRecord,
} from "../src/notifications/history.ts";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  DURATION_OPTIONS,
  ERROR_TOAST_DURATION_MS,
  NOTIFICATION_EVENT_META,
  NOTIFICATIONS_STORAGE_KEY,
  SOUND_PRESETS,
  clampVolume,
  isSoundId,
  normalizeNotificationSettings,
  persistNotificationSettings,
  readNotificationSettings,
  resolveToastDuration,
  shouldPlaySound,
  type NotificationSettings,
} from "../src/notifications/settings.ts";
import {
  createSoundPlayer,
  SOUND_TONES,
  type AudioContextLike,
  type AudioParamLike,
  type GainNodeLike,
  type OscillatorNodeLike,
} from "../src/notifications/sounds.ts";
import {
  MAX_VISIBLE_TOASTS,
  createToast,
  findActiveByDedupeKey,
  queuedCount,
  remainingMs,
  visibleToasts,
  type ToastItem,
} from "../src/notifications/toast.ts";
import type { RuntimeEvent, RuntimeEventBody } from "../src/workspace/types.ts";
import type { KeyValueStorage } from "../src/settings/busyDelivery.ts";

class FakeStorage implements KeyValueStorage {
  readonly entries = new Map<string, string>();
  failOnSet = false;

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failOnSet) throw new Error("QuotaExceededError");
    this.entries.set(key, value);
  }
}

function event(body: RuntimeEventBody): RuntimeEvent {
  return { sessionId: "ses_a", runtimeId: "ses_a#1", generation: 3, ...body };
}

function notification(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    kind: "sessionCompleted",
    severity: "success",
    title: "会话完成",
    body: "「重构通知」已完成这一轮回答",
    sessionId: "ses_a",
    actionLabel: "查看会话",
    dedupeKey: null,
    ...overrides,
  };
}

function record(id: string, atMs = 0): NotificationRecord {
  return {
    id,
    kind: "sessionCompleted",
    severity: "success",
    title: "会话完成",
    body: "正文",
    sessionId: "ses_a",
    atMs,
    actionLabel: "查看会话",
  };
}

// ─────────────────────────── 事件分类 ───────────────────────────

test("事件分类：settled 是会话完成，不依赖 agent_end", () => {
  const completed = classifyRuntimeEvent(event({ type: "settled" }), { title: "重构通知" });
  assert.ok(completed);
  assert.equal(completed.kind, "sessionCompleted");
  assert.equal(completed.severity, "success");
  assert.equal(completed.sessionId, "ses_a");
  assert.equal(completed.dedupeKey, null, "一轮回答只提醒一次，不需要合并");
  assert.ok(completed.body.includes("重构通知"), "正文必须能认出是哪个会话");

  // 没有标题时退回「会话」，不能出现空引号。
  const untitled = classifyRuntimeEvent(event({ type: "settled" }), { title: "  " });
  assert.equal(untitled?.body, "「会话」已完成这一轮回答");
});

test("事件分类：用户主动取消后到达的 settled 不算「完成」", () => {
  assert.equal(
    classifyRuntimeEvent(event({ type: "settled" }), { title: "构建", previousStatus: "cancelling" }),
    null,
    "取消后 Pi 仍可能发 agent_settled：这一轮不是成功结束",
  );
  // 其余处理前状态照常提醒。
  for (const previousStatus of ["running", "ready", "idle", "error"] as const) {
    assert.ok(
      classifyRuntimeEvent(event({ type: "settled" }), { title: "构建", previousStatus }),
      `previousStatus=${previousStatus} 应照常提醒`,
    );
  }
});

test("事件分类：state=error 与异常退出算出错，主动停止不算", () => {
  const stateError = classifyRuntimeEvent(event({ type: "state", state: "error" }), {
    title: "构建",
  });
  assert.equal(stateError?.kind, "sessionError");
  assert.equal(stateError?.severity, "error");

  // 现有状态机只有 starting/idle/running/stopping/exited：其余状态一律不提醒。
  for (const state of ["starting", "idle", "running", "stopping", "exited"]) {
    assert.equal(
      classifyRuntimeEvent(event({ type: "state", state }), { title: "构建" }),
      null,
      `state=${state} 不该触发通知`,
    );
  }

  const crashed = classifyRuntimeEvent(event({ type: "exit", code: 3, reason: "crashed" }), {
    title: "构建",
  });
  assert.equal(crashed?.kind, "sessionError");
  assert.ok(crashed?.body.includes("crashed"), "正文要带退出原因，便于判断严重性");

  // 用户主动停止与正常退出都不打扰。
  assert.equal(
    classifyRuntimeEvent(event({ type: "exit", code: 0, reason: "requested_abort" }), {
      title: "构建",
    }),
    null,
  );
  assert.equal(
    classifyRuntimeEvent(event({ type: "exit", code: 0, reason: "exited" }), { title: "构建" }),
    null,
  );
});

test("事件分类：扩展 UI 交互请求 = 等待输入，且合并成一条", () => {
  const byEventName = classifyRuntimeEvent(
    event({ type: "stream", event: "extension_ui_request", data: { method: "confirm" } }),
    { title: "发布" },
  );
  assert.equal(byEventName?.kind, "awaitingInput");
  assert.equal(byEventName?.severity, "info");
  assert.equal(byEventName?.dedupeKey, "awaitingInput:ses_a", "同一次请求的多条记录要合并");

  for (const method of ["select", "confirm", "input", "editor"]) {
    const byMethod = classifyRuntimeEvent(
      event({ type: "stream", event: "message_update", data: { method } }),
      { title: "发布" },
    );
    assert.equal(byMethod?.kind, "awaitingInput", `method=${method} 应识别为等待输入`);
  }

  // 后端当前把该记录降级成 warning：两种文案都要认。
  for (const detail of [
    "extension ui request is not implemented; treated as denied",
    "未处理的记录类型：extension_ui_request",
  ]) {
    const byWarning = classifyRuntimeEvent(event({ type: "warning", detail }), { title: "发布" });
    assert.equal(byWarning?.kind, "awaitingInput", detail);
    assert.equal(byWarning?.dedupeKey, "awaitingInput:ses_a");
  }
});

test("事件分类：普通消息增量与普通警告不得误判成等待输入", () => {
  const cases: RuntimeEventBody[] = [
    { type: "stream", event: "message_update", data: { delta: "hi" } },
    { type: "stream", event: "message_update", data: { type: "text" } },
    { type: "stream", event: "tool_call", data: null },
    { type: "warning", detail: "未处理的记录类型：session_info" },
    { type: "stderr", line: "boom" },
  ];
  for (const body of cases) {
    assert.equal(classifyRuntimeEvent(event(body), { title: "发布" }), null, JSON.stringify(body));
  }
});

// ─────────────────────────── 时长策略 ───────────────────────────

test("时长策略：全局时长覆盖调用方，错误类除外", () => {
  const settings: NotificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS, duration: 5000 };

  // 普通事件：调用方给什么都不算数，以全局设置为准。
  assert.equal(resolveToastDuration("sessionCompleted", settings, 30000), 5000);
  assert.equal(resolveToastDuration("awaitingInput", settings, null), 5000);

  // 错误类：不受全局时长影响。
  assert.equal(resolveToastDuration("sessionError", settings, 30000), 30000);
  assert.equal(resolveToastDuration("sessionError", settings, null), ERROR_TOAST_DURATION_MS);
  assert.equal(resolveToastDuration("sessionError", settings, 0), ERROR_TOAST_DURATION_MS);

  // 常驻：普通事件返回 null（不自动关闭）；错误类仍然会自己消失。
  const persistent: NotificationSettings = { ...settings, duration: "persistent" };
  assert.equal(resolveToastDuration("sessionCompleted", persistent), null);
  assert.equal(resolveToastDuration("sessionError", persistent), ERROR_TOAST_DURATION_MS);
});

test("时长选项与事件默认值：与 Issue #117 的事件表一致", () => {
  assert.deepEqual(
    DURATION_OPTIONS.map((option) => option.value),
    [5000, 10000, 30000, "persistent"],
  );
  assert.deepEqual(
    NOTIFICATION_EVENT_META.map((meta) => [meta.kind, meta.defaultEnabled]),
    [
      ["sessionCompleted", true],
      ["sessionError", true],
      ["awaitingInput", false],
    ],
  );
  // 默认值必须与元数据同源，不能各写一份。
  for (const meta of NOTIFICATION_EVENT_META) {
    assert.equal(DEFAULT_NOTIFICATION_SETTINGS.events[meta.kind].enabled, meta.defaultEnabled);
    assert.equal(DEFAULT_NOTIFICATION_SETTINGS.events[meta.kind].sound, meta.defaultSound);
  }
});

test("声音策略：总开关 / 事件开关 / 仅失焦三者独立", () => {
  const base = DEFAULT_NOTIFICATION_SETTINGS;

  assert.equal(shouldPlaySound("sessionCompleted", base, false), true, "失焦时应出声");
  assert.equal(shouldPlaySound("sessionCompleted", base, true), false, "默认仅失焦提醒");

  const alwaysSound = { ...base, onlyWhenUnfocused: false };
  assert.equal(shouldPlaySound("sessionCompleted", alwaysSound, true), true);

  const muted = { ...base, soundEnabled: false };
  assert.equal(shouldPlaySound("sessionCompleted", muted, false), false);

  const silentVolume = { ...base, volume: 0 };
  assert.equal(shouldPlaySound("sessionCompleted", silentVolume, false), false, "音量 0 等于静音");

  const awaiting = { ...base, onlyWhenUnfocused: false };
  assert.equal(
    shouldPlaySound("awaitingInput", awaiting, false),
    false,
    "默认关闭的事件即使手动放开仅失焦也不该出声",
  );
});

// ─────────────────────────── 设置持久化 ───────────────────────────

test("设置读写：脏值逐字段回退，坏 JSON 不清空其它字段", () => {
  const normalized = normalizeNotificationSettings({
    duration: 1234,
    onlyWhenUnfocused: "yes",
    soundEnabled: false,
    volume: 3,
    events: { sessionError: { enabled: "no", sound: "trumpet" } },
  });
  assert.equal(normalized.duration, DEFAULT_NOTIFICATION_SETTINGS.duration);
  assert.equal(normalized.onlyWhenUnfocused, DEFAULT_NOTIFICATION_SETTINGS.onlyWhenUnfocused);
  assert.equal(normalized.soundEnabled, false, "认识的字段必须保留");
  assert.equal(normalized.volume, 1, "音量夹紧到 0～1");
  assert.deepEqual(normalized.events.sessionError, DEFAULT_NOTIFICATION_SETTINGS.events.sessionError);
  assert.deepEqual(
    normalized.events.sessionCompleted,
    DEFAULT_NOTIFICATION_SETTINGS.events.sessionCompleted,
  );

  assert.equal(clampVolume(-2), 0);
  assert.equal(clampVolume(0.333), 0.33);
  assert.equal(clampVolume(Number.NaN), DEFAULT_NOTIFICATION_SETTINGS.volume);
});

test("设置读写：存储往返、坏 JSON 与写入失败都不抛错", () => {
  const storage = new FakeStorage();
  const custom: NotificationSettings = {
    ...DEFAULT_NOTIFICATION_SETTINGS,
    duration: 30000,
    onlyWhenUnfocused: false,
    volume: 0.25,
    events: {
      ...DEFAULT_NOTIFICATION_SETTINGS.events,
      awaitingInput: { enabled: true, sound: "bell" },
    },
  };
  assert.equal(persistNotificationSettings(custom, storage), true);
  assert.deepEqual(readNotificationSettings(storage), custom);
  assert.ok(storage.entries.get(NOTIFICATIONS_STORAGE_KEY)?.includes('"volume":0.25'));

  const broken = new FakeStorage();
  broken.entries.set(NOTIFICATIONS_STORAGE_KEY, "{not json");
  assert.deepEqual(readNotificationSettings(broken), DEFAULT_NOTIFICATION_SETTINGS);

  const full = new FakeStorage();
  full.failOnSet = true;
  assert.equal(persistNotificationSettings(custom, full), false);
  assert.equal(persistNotificationSettings(custom, null), false);
  assert.deepEqual(readNotificationSettings(null), DEFAULT_NOTIFICATION_SETTINGS);
});

// ─────────────────────────── 历史上限 ───────────────────────────

test("通知历史：时间倒序、有硬上限、越界丢弃最旧的", () => {
  let list: NotificationRecord[] = [];
  for (let index = 0; index < MAX_NOTIFICATION_HISTORY + 5; index += 1) {
    list = appendNotification(list, record(`r${index}`, index));
  }
  assert.equal(list.length, MAX_NOTIFICATION_HISTORY);
  assert.equal(list[0]?.id, `r${MAX_NOTIFICATION_HISTORY + 4}`, "最新的一条在最前");
  assert.equal(list.at(-1)?.id, "r5", "被裁掉的是最旧的 5 条");

  // 不修改入参（store 里是 ref 数组，原地改会漏掉一次响应式更新）。
  const frozen = [record("only", 1)];
  const next = appendNotification(frozen, record("new", 2), 1);
  assert.deepEqual(next.map((item) => item.id), ["new"]);
  assert.deepEqual(frozen.map((item) => item.id), ["only"]);

  assert.deepEqual(appendNotification(frozen, record("new"), 0), [], "上限为 0 时不保留任何条目");
});

test("通知历史：时间格式固定为 HH:MM:SS，不受语言环境影响", () => {
  const at = new Date(2026, 0, 2, 3, 4, 5).getTime();
  assert.equal(formatNotificationClock(at), "03:04:05");
  const late = new Date(2026, 11, 31, 23, 59, 59).getTime();
  assert.equal(formatNotificationClock(late), "23:59:59");
});

// ─────────────────────────── Toast 队列 ───────────────────────────

test("Toast 队列：最多 4 条可见，超出的排队，关一条补一条", () => {
  let list: ToastItem[] = [];
  for (let index = 0; index < 6; index += 1) {
    list = [...list, createToast(notification({ sessionId: `ses_${index}` }), 10000, `t${index}`)];
  }
  assert.equal(MAX_VISIBLE_TOASTS, 4);
  assert.deepEqual(visibleToasts(list).map((item) => item.id), ["t0", "t1", "t2", "t3"]);
  assert.equal(queuedCount(list), 2);

  const afterDismiss = list.filter((item) => item.id !== "t0");
  assert.deepEqual(visibleToasts(afterDismiss).map((item) => item.id), ["t1", "t2", "t3", "t4"]);
  assert.equal(queuedCount(afterDismiss), 1);

  assert.deepEqual(visibleToasts(list, 0), []);
  assert.equal(queuedCount(list, 10), 0);
});

test("Toast 队列：dedupeKey 相同且未消失时合并，消失后可以再次提醒", () => {
  const first = createToast(
    notification({ kind: "awaitingInput", dedupeKey: "awaitingInput:ses_a" }),
    10000,
    "t1",
  );
  const list = [first];
  assert.equal(findActiveByDedupeKey(list, "awaitingInput:ses_a")?.id, "t1");
  assert.equal(findActiveByDedupeKey(list, "awaitingInput:ses_b"), undefined);
  assert.equal(findActiveByDedupeKey([], "awaitingInput:ses_a"), undefined);
});

test("Toast 倒计时：剩余时长不会出现负数", () => {
  assert.equal(remainingMs(10000, 0), 10000);
  assert.equal(remainingMs(10000, 4000), 6000);
  assert.equal(remainingMs(10000, 12000), 0);
  assert.equal(remainingMs(Number.NaN, 1), 0);
});

// ─────────────────────────── 声音 ───────────────────────────

class FakeParam implements AudioParamLike {
  value = 1;
  readonly calls: Array<{ kind: string; value: number; time: number }> = [];

  setValueAtTime(value: number, time: number): void {
    this.calls.push({ kind: "set", value, time });
  }

  linearRampToValueAtTime(value: number, time: number): void {
    this.calls.push({ kind: "linear", value, time });
  }

  exponentialRampToValueAtTime(value: number, time: number): void {
    this.calls.push({ kind: "exp", value, time });
  }
}

class FakeOscillator implements OscillatorNodeLike {
  type = "sine";
  readonly frequency = new FakeParam();
  onended: (() => void) | null = null;
  connected = 0;
  disconnected = 0;
  started: number | null = null;
  stopped: number | null = null;

  connect(): void {
    this.connected += 1;
  }

  disconnect(): void {
    this.disconnected += 1;
  }

  start(when: number): void {
    this.started = when;
  }

  stop(when: number): void {
    this.stopped = when;
  }
}

class FakeGain implements GainNodeLike {
  readonly gain = new FakeParam();
  disconnected = 0;

  connect(): void {}

  disconnect(): void {
    this.disconnected += 1;
  }
}

class FakeAudioContext implements AudioContextLike {
  currentTime = 10;
  state = "running";
  readonly destination = {};
  readonly oscillators: FakeOscillator[] = [];
  readonly gains: FakeGain[] = [];
  closed = 0;
  resumed = 0;

  resume(): void {
    this.resumed += 1;
  }

  close(): void {
    this.closed += 1;
  }

  createOscillator(): OscillatorNodeLike {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createGain(): GainNodeLike {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }
}

test("音效预设：6 个且都有音符表，单次播放不超过 1.5 秒", () => {
  assert.equal(SOUND_PRESETS.length, 6);
  for (const preset of SOUND_PRESETS) {
    assert.equal(isSoundId(preset.id), true, preset.id);
    const steps = SOUND_TONES[preset.id];
    assert.ok(steps.length > 0, `${preset.id} 必须有音符`);
    for (const step of steps) {
      const end = step.startMs + step.durationMs;
      assert.ok(end <= 1500, `${preset.id} 的音符总长必须 <= 1.5s，实际 ${end}ms`);
      assert.ok(step.gain > 0 && step.gain <= 1, `${preset.id} 的增益必须在 (0,1]`);
      assert.ok(step.frequency >= 100 && step.frequency <= 4000, `${preset.id} 的频率要落在可听范围`);
    }
  }
});

test("播放器：按音符表调度，音量夹紧到 0～1，dispose 关闭上下文", () => {
  const context = new FakeAudioContext();
  const player = createSoundPlayer(() => context);
  assert.equal(player.hasContext, false, "AudioContext 延迟到第一次播放才创建");

  assert.equal(player.play("chime", 0.6), true);
  assert.equal(player.hasContext, true);
  assert.equal(context.oscillators.length, SOUND_TONES.chime.length);
  for (const oscillator of context.oscillators) {
    assert.ok(oscillator.started !== null && oscillator.stopped !== null, "每个音都要 start/stop");
    assert.ok((oscillator.stopped ?? 0) > (oscillator.started ?? 0));
  }
  // 峰值 = 音符增益 × 音量：0.5 × 0.6 = 0.3（保留浮点比较）。
  const peaks = context.gains.map((gain) =>
    Math.max(...gain.gain.calls.filter((call) => call.kind === "exp").map((call) => call.value)),
  );
  assert.ok(Math.abs((peaks[0] ?? 0) - 0.3) < 1e-6, `第一个音的峰值应约为 0.3，实际 ${peaks[0]}`);

  // 音量超过 1 会被夹紧，0 则直接不播（不产生节点）。
  const before = context.oscillators.length;
  assert.equal(player.play("pop", 5), true);
  const loud = context.gains.at(-1)?.gain.calls ?? [];
  const loudPeak = Math.max(...loud.filter((call) => call.kind === "exp").map((call) => call.value));
  assert.ok(loudPeak <= 0.5 + 1e-9, "音量夹紧到 1 后峰值不能超过音符增益");

  const afterLoud = context.oscillators.length;
  assert.equal(player.play("pop", 0), false);
  assert.equal(context.oscillators.length, afterLoud, "音量 0 不产生振荡器");
  assert.ok(afterLoud > before);

  player.dispose();
  assert.equal(context.closed, 1);
  assert.equal(player.hasContext, false);
  assert.equal(player.play("bell", 0.5), false, "dispose 之后不再创建上下文");

  player.dispose();
  assert.equal(context.closed, 1, "重复 dispose 只关一次");
});

test("播放器：没有音频通道时静默失败，不抛错", () => {
  const player = createSoundPlayer(() => null);
  assert.equal(player.play("chime", 1), false);
  assert.equal(player.play("chime", 0), false);
  assert.equal(player.hasContext, false);
  player.dispose();
});

test("播放器：createOscillator 抛错时不影响调用方", () => {
  const context = new FakeAudioContext();
  context.createOscillator = () => {
    throw new Error("audio device removed");
  };
  const player = createSoundPlayer(() => context);
  assert.equal(player.play("alert", 0.8), false);
  player.dispose();
});

// ─────────────────────────── 焦点 ───────────────────────────

test("焦点判定：隐藏到托盘算失焦，可见但切到后台也算失焦", () => {
  const target = createFocusTargetForTests({ focused: true, visibility: "visible" });
  assert.equal(isWindowFocused(target), true);

  target.setVisibility("hidden");
  assert.equal(isWindowFocused(target), false, "隐藏到托盘必须算失焦，否则托盘时不响");

  target.setVisibility("visible");
  target.setFocused(false);
  assert.equal(isWindowFocused(target), false, "窗口可见但不在前台也算失焦");

  assert.equal(isWindowFocused(null), true, "没有宿主时按有焦点处理（静默）");
});

test("焦点订阅：三个事件都听，状态变化才回调，stop 移除全部监听", () => {
  const target = createFocusTargetForTests({ focused: true, visibility: "visible" });
  const seen: boolean[] = [];
  const watcher = watchWindowFocus((focused) => seen.push(focused), target);

  target.setFocused(true);
  target.emit("focus");
  assert.deepEqual(seen, [], "状态没变不回调");

  target.setFocused(false);
  target.emit("blur");
  assert.deepEqual(seen, [false]);

  target.setFocused(true);
  target.emit("focus");
  assert.deepEqual(seen, [false, true]);

  target.setVisibility("hidden");
  target.emit("visibilitychange");
  assert.deepEqual(seen, [false, true, false]);

  watcher.stop();
  target.setFocused(false);
  target.emit("blur");
  assert.deepEqual(seen, [false, true, false], "stop 之后不再回调");
  assert.equal(target.listenerCount(), 0, "stop 必须移除全部监听器");
  watcher.stop();
  assert.equal(target.listenerCount(), 0, "重复 stop 安全");
});
