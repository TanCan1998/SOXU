/**
 * 回归测试：composer 发送三选（Issue #111 · V4-S1）。
 *
 * 判定逻辑是纯函数，可用 mock 的忙碌/草稿状态直接驱动——不需要真实运行时；
 * 组件侧只断言结构（reka DropdownMenu 的方向/对齐、三项顺序、置灰绑定、模式横条），
 * 因为 Node 里没有浏览器渲染器，交互的视觉结果由证据文档里的截图佐证。
 *
 * 参数管道单独验证：`send_prompt` 的 mode/thinking 必须真的走到 bridge 与 Rust 命令，
 * 但本切片不改变投递行为（忙碌时仍然直接返回，草稿保留）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SEND_MODE_ORDER,
  SEND_MODES_PENDING_KEY,
  SEND_MODES_READY,
  SEND_MODE_TEXT,
  isPlainTextDraft,
  resolveSendMode,
  sendModeAvailability,
  sendModeDescription,
  sendModeLabel,
  sendModePendingReason,
} from "../src/components/sendMode.ts";
import { BASE_MESSAGES } from "../src/locales/index.ts";
import {
  BUSY_DELIVERY_OPTIONS,
  DEFAULT_BUSY_DELIVERY,
} from "../src/settings/busyDelivery.ts";
import { WorkspaceSession } from "../src/workspace/sessionWorkspace.ts";
import type { RuntimeEvent } from "../src/workspace/types.ts";
import { FakeBridge } from "./support/fakeBridge.ts";

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));
const TAURI_ROOT = fileURLToPath(new URL("../src-tauri", import.meta.url));

async function readSource(relative: string): Promise<string> {
  return readFile(join(SRC_ROOT, relative), "utf8");
}

test("三项顺序与文案照决策文档：加入当前 / 排到下轮 / 并行发送", () => {
  assert.deepEqual(SEND_MODE_ORDER, ["steer", "followUp", "parallel"]);
  // Issue #144：文案搬进 session.json，这里断言「key 指向基准包」+「基准包文案未变」。
  assert.equal(SEND_MODE_TEXT.steer.labelKey, "session.mode.steer.label");
  assert.equal(SEND_MODE_TEXT.followUp.labelKey, "session.mode.follow.up.label");
  assert.equal(SEND_MODE_TEXT.parallel.labelKey, "session.mode.parallel.label");
  assert.equal(BASE_MESSAGES["session.mode.steer.label"], "加入当前");
  assert.equal(BASE_MESSAGES["session.mode.follow.up.label"], "排到下轮");
  assert.equal(BASE_MESSAGES["session.mode.parallel.label"], "并行发送");
  assert.equal(
    BASE_MESSAGES["session.mode.parallel.description"],
    "独立会话后台处理，不打断当前输出",
    "并行发送的描述必须与决策文档逐字一致",
  );
  assert.equal(sendModeLabel("steer"), "加入当前");
  assert.equal(sendModeLabel("followUp"), "排到下轮");
  assert.equal(sendModeDescription("parallel"), "独立会话后台处理，不打断当前输出");
});

test("投递语义已接入：默认开关打开，回滚时才整体置灰", () => {
  assert.equal(SEND_MODES_READY, true, "Issue #146 已完成协议落地，菜单里不该再有假入口");
  assert.equal(SEND_MODES_PENDING_KEY, "session.mode.pending", "置灰原因走语言包的 key");
  assert.match(sendModePendingReason(), /即将支持/, "回滚文案仍是「即将支持」类，不假装能用");

  // 回滚/旧协议版本：任何状态组合下都不许出现「看起来能点、点了没反应」的入口。
  for (const busy of [true, false]) {
    for (const draft of ["", "  ", "有内容"]) {
      for (const hasProject of [true, false]) {
        const availability = sendModeAvailability({ busy, draft, hasProject }, { ready: false });
        for (const mode of SEND_MODE_ORDER) {
          assert.equal(
            availability[mode].enabled,
            false,
            `busy=${busy} draft="${draft}" 时 ${mode} 不得可点`,
          );
          assert.equal(availability[mode].reason, sendModePendingReason());
        }
      }
    }
  }

  // 接入之后：排到下轮永远可用，是三种方式里唯一的无条件选项。
  const idle = sendModeAvailability({ busy: false, draft: "" });
  assert.equal(idle.followUp.enabled, true);
});

test("三项文案与顺序不变：可见但不可点，不是藏起来", () => {
  assert.deepEqual(SEND_MODE_ORDER, ["steer", "followUp", "parallel"]);
  for (const mode of SEND_MODE_ORDER) {
    assert.ok(sendModeLabel(mode).length > 0, mode + " 必须有名称");
    assert.ok(sendModeDescription(mode).length > 0, mode + " 必须有说明");
  }
});

test("加入当前（协议接入后）：仅 agent 忙碌时可用，空闲置灰并给出原因", () => {
  const idle = sendModeAvailability({ busy: false, draft: "写个测试" }, { ready: true });
  assert.equal(idle.steer.enabled, false, "空闲时不需要插进当前回合");
  assert.ok(idle.steer.reason && idle.steer.reason.length > 0, "置灰必须说明原因");

  const busy = sendModeAvailability({ busy: true, draft: "写个测试" }, { ready: true });
  assert.equal(busy.steer.enabled, true);
  assert.equal(busy.steer.reason, null);
});

test("排到下轮（协议接入后）：任何状态都可用", () => {
  for (const busy of [true, false]) {
    for (const draft of ["", "  ", "有内容"]) {
      const availability = sendModeAvailability({ busy, draft }, { ready: true });
      assert.equal(availability.followUp.enabled, true, `busy=${busy} draft="${draft}"`);
      assert.equal(availability.followUp.reason, null);
    }
  }
});

test("并行发送（协议接入后）：草稿非空 + 纯文本 + 有项目，三个条件缺一不可", () => {
  const ready = sendModeAvailability({ busy: false, draft: "帮我查一下", attachments: 0 }, {
    ready: true,
  });
  assert.equal(ready.parallel.enabled, true);

  const emptyDraft = sendModeAvailability({ busy: false, draft: "   " }, { ready: true });
  assert.equal(emptyDraft.parallel.enabled, false, "空草稿不能并行发送");
  assert.match(emptyDraft.parallel.reason ?? "", /输入/);

  const withAttachment = sendModeAvailability({ busy: false, draft: "看图", attachments: 1 }, {
    ready: true,
  });
  assert.equal(withAttachment.parallel.enabled, false, "带附件的消息不能并行发送");
  assert.match(withAttachment.parallel.reason ?? "", /附件/);

  const noProject = sendModeAvailability({ busy: false, draft: "看图", hasProject: false }, {
    ready: true,
  });
  assert.equal(noProject.parallel.enabled, false, "没有 projectId 就没有落点");
  assert.match(noProject.parallel.reason ?? "", /项目/);

  // 忙碌时并行发送同样可用：它的语义就是「不打断当前输出」。
  const busy = sendModeAvailability({ busy: true, draft: "另开一路" }, { ready: true });
  assert.equal(busy.parallel.enabled, true);
});

test("纯文本判定只看附件：首版没有附件通道，恒为纯文本", () => {
  assert.equal(isPlainTextDraft({ busy: false, draft: "任意内容" }), true);
  assert.equal(isPlainTextDraft({ busy: false, draft: "", attachments: 2 }), false);
});

test("菜单结构：reka DropdownMenu 向上右对齐，三项都绑定可用条件", async () => {
  const source = await readSource("components/ComposerSendMenu.vue");

  assert.ok(source.includes("DropdownMenuRoot"), "必须用 reka-ui 的 DropdownMenu");
  assert.ok(source.includes('side="top"'), "菜单从发送钮向上弹出");
  assert.ok(source.includes('align="end"'), "菜单与发送钮右对齐");
  assert.ok(source.includes(':side-offset="6"'), "与触发器的间距是 6px（原型 send-menu）");
  assert.ok(source.includes("DropdownMenuItem"), "三项是菜单项");
  assert.ok(source.includes(':disabled="!item.enabled"'), "不可用的项必须置灰");
  assert.ok(source.includes("SEND_MODE_ORDER"), "顺序来自 sendMode.ts，不在组件里另写一份");
  assert.ok(source.includes("sendModeAvailability"), "可用条件必须走纯函数");
  assert.ok(source.includes('@select="choose(item.mode)"'), "选中后把模式交给 composer");
  assert.ok(
    source.includes("{{ item.description }}<template v-if=\"!item.enabled\"> · {{ item.reason }}"),
    "置灰项保留描述并把原因接在后面（只用原因会让三项看起来一样）",
  );
  assert.ok(!/\stitle=/.test(source), "提示不走原生 title（统一 AppTooltip）");
});

test("composer：模式横条 + 取消按钮，待发模式按会话隔离且用完即清", async () => {
  const source = await readSource("components/ChatComposer.vue");

  // Issue #144：横条文案走 composer.json，源码里只留 key。
  assert.ok(source.includes('t("composer.bar.lead")'), "横条文案与原型一致");
  assert.ok(source.includes("send-mode-bar"), "横条使用原型的 class 名");
  assert.ok(source.includes("composer.bar.cancel"), "横条必须有取消按钮");
  assert.ok(source.includes("sessionId"), "待发模式要按会话记录");
  assert.ok(source.includes("pendingBySession"), "会话切换不能串味");
  assert.ok(source.includes('emit("send", mode)'), "发送时把模式带出去");
  assert.ok(source.includes("if (pendingMode.value) clearMode()"), "选择只对下一条消息生效");
  assert.ok(source.includes("ComposerSendMenu"), "caret 钮是独立的发送选项菜单");
  assert.ok(source.includes("defaultDelivery"), "忙碌时的默认投递方式由设置透传");
  assert.ok(source.includes("--ease-spring"), "动效统一引用 --ease-spring");

  // Issue #146：忙碌时主发送钮不再禁用，没选过投递方式就按设置里的默认值走。
  assert.ok(source.includes("resolveSendMode("), "投递方式的决策走纯函数（可测）");
  assert.ok(
    !source.includes("!running.value && !props.busy"),
    "忙碌不再是禁用的理由（否则默认投递无从生效）",
  );
  assert.ok(source.includes('props.status !== "cancelling"'), "正在取消时仍然禁用发送");
  assert.ok(source.includes("pendingCount"), "排队条数由上层透传");
  assert.ok(source.includes('t("composer.queued.note"'), "排队回执走语言包");
});

test("发送三选的判定用 mock 状态即可验证：置灰项与可用项一一对应", () => {
  // 用一小组典型状态把「忙碌置灰」这件事钉住，避免以后有人把条件改成只看草稿。
  const cases: Array<{ busy: boolean; draft: string; expect: [boolean, boolean, boolean] }> = [
    { busy: false, draft: "", expect: [false, true, false] },
    { busy: false, draft: "hi", expect: [false, true, true] },
    { busy: true, draft: "", expect: [true, true, false] },
    { busy: true, draft: "hi", expect: [true, true, true] },
  ];

  for (const item of cases) {
    const availability = sendModeAvailability({ busy: item.busy, draft: item.draft }, {
      ready: true,
    });
    const actual = SEND_MODE_ORDER.map((mode) => availability[mode].enabled);
    assert.deepEqual(
      actual,
      item.expect,
      `busy=${item.busy} draft="${item.draft}" 的可用状态不符`,
    );
  }

  // 回滚（ready=false）时同一组状态全部置灰：条件判定不会被绕过。
  for (const item of cases) {
    const availability = sendModeAvailability(
      { busy: item.busy, draft: item.draft },
      { ready: false },
    );
    assert.deepEqual(
      SEND_MODE_ORDER.map((mode) => availability[mode].enabled),
      [false, false, false],
      "回滚时不得出现可点的投递方式",
    );
  }
});

test("设置 → 会话：忙碌时发送两选一，默认「加入当前」", async () => {
  assert.deepEqual(
    BUSY_DELIVERY_OPTIONS.map((option) => option.value),
    ["steer", "followUp"],
  );
  assert.deepEqual(
    BUSY_DELIVERY_OPTIONS.map((option) => option.label),
    ["加入当前", "排到下轮"],
  );
  assert.equal(DEFAULT_BUSY_DELIVERY, "steer", "决策文档的默认值是加入当前");

  // Issue #116 起会话页单独成组件：这一项从 SettingsDialog.vue 搬到了 SettingsSession.vue。
  const session = await readSource("components/settings/SettingsSession.vue");
  assert.ok(session.includes("忙碌时发送"), "设置面板必须有这一项");
  assert.ok(session.includes("BUSY_DELIVERY_OPTIONS"), "选项表来自 busyDelivery.ts");
  assert.ok(session.includes("SettingsChoice"), "两选一用共用的单选组组件");
  const choice = await readSource("components/settings/SettingsChoice.vue");
  assert.ok(choice.includes("RadioGroupRoot"), "单选组用 reka（自带 role=radiogroup）");
  assert.ok(session.includes(":labelledby="), "单选组绑定行标题，读屏名字与可见标题一致");
  assert.ok(session.includes('emit("update:busyDelivery"'), "选择要向上冒泡");
  assert.ok(session.includes("isBusySendDelivery"), "冒泡前用守卫收窄，脏值不会写进状态");

  // 外壳只负责把它透传给会话页，不再自己实现这一项
  const dialog = await readSource("components/SettingsDialog.vue");
  assert.ok(dialog.includes("SettingsSession"), "四页之一：会话页");
  assert.ok(dialog.includes("@update:busyDelivery"), "外壳把改动继续向上冒泡");

  const app = await readSource("App.vue");
  assert.ok(app.includes("useBusyDelivery"), "App 持有投递方式状态");
  assert.ok(app.includes(':default-delivery="busyDelivery"'), "透传给会话面板");
  assert.ok(app.includes(':busy-delivery="busyDelivery"'), "透传给设置面板");
  assert.ok(app.includes('@update:busyDelivery="setBusyDelivery"'), "设置改动回写状态");
});

test("空闲发送：mode 不上线（Pi 只在流式期间接受 streamingBehavior）", async () => {
  const bridge = new FakeBridge();
  const session = new WorkspaceSession(bridge);
  await session.openSession({ sessionId: "ses_a", projectId: "prj_1", title: "会话 A" });
  await session.startRuntime("ses_a");

  await session.sendPrompt("ses_a", "  下一条  ", { mode: "followUp", thinking: "high" });
  const call = bridge.callsOf("sendPrompt")[0];
  assert.deepEqual(
    call?.args,
    ["ses_a", "下一条", { thinking: "high" }],
    "空闲时去掉 mode：带上 streamingBehavior 对空闲投递没有意义",
  );

  // 空闲时选「排到下轮」等于现在发：没有正在跑的轮次可以排。
  assert.equal(session.tab("ses_a")?.status, "running");
  assert.equal(session.tab("ses_a")?.pending.length, 0);

  await session.dispose();
});

test("参数管道：bridge 调用 send_prompt 时带 mode/thinking，Rust 命令按 Option 接收", async () => {
  const bridge = await readSource("workspace/bridge.ts");
  assert.ok(bridge.includes('invoke<void>("send_prompt"'), "命令名不变");
  assert.ok(bridge.includes("mode: options?.mode"), "mode 走 camelCase 参数名");
  assert.ok(bridge.includes("thinking: options?.thinking"), "thinking 走 camelCase 参数名");

  // Issue #112 把命令层拆成 commands/ 子模块，send_prompt 落在 session 领域。
  const commands = await readFile(join(TAURI_ROOT, "src", "commands", "session.rs"), "utf8");
  assert.ok(commands.includes("mode: Option<PromptMode>"), "Rust 侧按可选参数接收");
  assert.ok(commands.includes("thinking: Option<ThinkingLevel>"), "thinking 同样是可选参数");
  // Issue #146：mode 不再是「接收但不改变行为」，而是真的映射到 Pi 的排队方式。
  assert.ok(
    commands.includes("Some(PromptMode::Steer) => Some(StreamingBehavior::Steer)"),
    "steer 必须映射到 Pi 的 streamingBehavior=steer",
  );
  assert.ok(
    commands.includes("Some(PromptMode::FollowUp) => Some(StreamingBehavior::FollowUp)"),
    "followUp 必须映射到 Pi 的 streamingBehavior=followUp",
  );
  assert.ok(
    commands.includes("Some(PromptMode::Parallel) | None => None"),
    "parallel 由前端另开会话，后端不得静默丢弃",
  );
  assert.ok(
    commands.includes("pub async fn clear_queued_prompts("),
    "停止前清队列需要一个独立命令",
  );

  const dto = await readFile(join(TAURI_ROOT, "src", "dto", "session.rs"), "utf8");
  assert.ok(dto.includes("pub enum PromptMode"), "投递方式在 DTO 层定义");
  assert.ok(dto.includes("pub enum ThinkingLevel"), "思考强度在 DTO 层定义");

  // 新命令必须登记在 lib.rs 的 session 块内（scripts/check-command-blocks.mjs 会再校验一次）。
  const lib = await readFile(join(TAURI_ROOT, "src", "lib.rs"), "utf8");
  assert.ok(lib.includes("commands::clear_queued_prompts,"), "新命令必须注册到 invoke_handler");
});
/* ── Issue #146：三种投递方式的运行时语义（FakeBridge 驱动，零外网） ── */

/** 把 Tab 推进到 running：先发一条普通消息，再返回同一个 Tab。 */
async function startBusyRun(bridge: FakeBridge, session: WorkspaceSession) {
  await session.openSession({ sessionId: "ses_a", projectId: "prj_1", title: "会话 A" });
  await session.startRuntime("ses_a");
  await session.sendPrompt("ses_a", "第一轮", {});
  const tab = session.tab("ses_a");
  assert.ok(tab);
  assert.equal(tab.status, "running");
  return tab;
}

function settled(): RuntimeEvent {
  return { type: "settled", sessionId: "ses_a", runtimeId: "ses_a#1", generation: 1 };
}

test("忙碌时排到下轮：进 Pi 队列、本地登记 pending，settled 后登记结束", async () => {
  const bridge = new FakeBridge();
  const session = new WorkspaceSession(bridge);
  const tab = await startBusyRun(bridge, session);

  await session.sendPrompt("ses_a", "排到下轮", { mode: "followUp" });
  const call = bridge.callsOf("sendPrompt").at(-1);
  assert.deepEqual(
    call?.args,
    ["ses_a", "排到下轮", { mode: "followUp" }],
    "忙碌时必须把 followUp 交给后端（后端映射到 streamingBehavior）",
  );
  assert.equal(tab.pending.length, 1, "排队消息必须有本地登记，否则无法撤回");
  assert.equal(tab.pending[0]?.mode, "followUp");
  assert.equal(tab.messages.at(-1)?.role, "user", "排队消息要立刻回显");
  assert.equal(tab.messages.at(-1)?.text, "排到下轮");
  assert.equal(tab.status, "running", "排队不改变本轮状态");

  // Pi 在本轮结束时投递并消费排队消息：本地登记到此结束。
  bridge.deliver(settled());
  assert.equal(tab.pending.length, 0);
  assert.equal(tab.status, "ready");
  await session.dispose();
});

test("忙碌时加入当前：带 streamingBehavior=steer，不打断本轮", async () => {
  const bridge = new FakeBridge();
  const session = new WorkspaceSession(bridge);
  const tab = await startBusyRun(bridge, session);

  await session.sendPrompt("ses_a", "插进当前", { mode: "steer" });
  const call = bridge.callsOf("sendPrompt").at(-1);
  assert.deepEqual(call?.args, ["ses_a", "插进当前", { mode: "steer" }]);
  assert.equal(tab.status, "running", "注入不结束当前轮次");
  assert.equal(tab.pending.length, 1, "steer 同样要能撤回");
  assert.equal(tab.pending[0]?.mode, "steer");
  await session.dispose();
});

test("忙碌但没给投递方式：按 followUp 排队，绝不丢消息", async () => {
  const bridge = new FakeBridge();
  const session = new WorkspaceSession(bridge);
  await startBusyRun(bridge, session);

  await session.sendPrompt("ses_a", "没说方式");
  const call = bridge.callsOf("sendPrompt").at(-1);
  assert.deepEqual(call?.args, ["ses_a", "没说方式", { mode: "followUp" }]);
  await session.dispose();
});

test("投递被拒：撤回回显与登记，草稿还给用户", async () => {
  const bridge = new FakeBridge();
  const session = new WorkspaceSession(bridge);
  const tab = await startBusyRun(bridge, session);
  const before = tab.messages.length;
  bridge.sendPromptError = "E_RUNTIME_EXITED: 运行时已结束";

  await session.sendPrompt("ses_a", "会被拒的消息", { mode: "followUp" });
  assert.equal(tab.pending.length, 0, "没进队列就不能留着 pending");
  assert.equal(tab.messages.length, before, "回显必须撤掉");
  assert.equal(tab.draft, "会被拒的消息", "草稿不能丢");
  assert.match(tab.error ?? "", /E_RUNTIME_EXITED/);
  await session.dispose();
});

test("停止：先清 Pi 的队列再 abort，并把排队文本还回输入框", async () => {
  const bridge = new FakeBridge();
  const session = new WorkspaceSession(bridge);
  const tab = await startBusyRun(bridge, session);
  await session.sendPrompt("ses_a", "排到下轮", { mode: "followUp" });

  await session.cancel("ses_a");
  const methods = bridge.calls.map((call) => call.method);
  const clearAt = methods.indexOf("clearQueuedPrompts");
  const cancelAt = methods.indexOf("cancelRuntime");
  assert.ok(clearAt >= 0, "停止必须清队列：abort 会继续执行排队消息");
  assert.ok(clearAt < cancelAt, "顺序不能反：先 clear_queue 再 abort");
  assert.equal(tab.pending.length, 0);
  assert.equal(tab.draft, "排到下轮", "撤回的文本必须回到输入框");
  assert.equal(
    tab.messages.some((message) => message.text === "排到下轮"),
    false,
    "撤回后不能留下一条没发出去的回显",
  );
  await session.dispose();
});

test("清队列失败：保留排队登记，不假装已撤回", async () => {
  const bridge = new FakeBridge();
  const session = new WorkspaceSession(bridge);
  const tab = await startBusyRun(bridge, session);
  await session.sendPrompt("ses_a", "排到下轮", { mode: "followUp" });
  bridge.clearQueueError = "E_RUNTIME_GONE";

  await session.cancel("ses_a");
  assert.equal(tab.pending.length, 1, "Pi 可能仍会执行它，登记不能提前清掉");
  assert.equal(tab.draft, "", "没确认撤回就不该把文本还给输入框");
  assert.ok(tab.diagnostics.some((line) => line.includes("撤回排队消息失败")));
  await session.dispose();
});

test("并行发送：同项目下另开临时会话再发出，不打断当前会话", async () => {
  const bridge = new FakeBridge();
  const session = new WorkspaceSession(bridge);
  const tab = await startBusyRun(bridge, session);

  await session.sendPrompt("ses_a", "另开一路", { mode: "parallel" });
  const opened = bridge.callsOf("openTemporarySession");
  assert.equal(opened.length, 1, "并行发送必须新开会话");
  assert.deepEqual(opened[0]?.args, ["prj_1"], "新会话落在同一个项目下");
  assert.equal(tab.status, "running", "当前会话的输出不受影响");
  assert.equal(tab.draft, "", "草稿已经交给新会话");
  assert.equal(
    tab.messages.some((message) => message.text === "另开一路"),
    false,
    "并行消息不出现在当前会话里",
  );
  assert.equal(session.workspace.activeSessionId, "ses_tmp_1", "切到新会话，用户能看到它已创建");
  const sent = bridge.callsOf("sendPrompt").at(-1);
  assert.deepEqual(sent?.args, ["ses_tmp_1", "另开一路", undefined], "在新会话里发普通 prompt");
  await session.dispose();
});

test("并行发送：新临时会话也订阅运行时事件（否则它永远停在 running）", async () => {
  const bridge = new FakeBridge();
  const session = new WorkspaceSession(bridge);
  const created = await session.openTemporary("prj_1");
  assert.ok(created);
  // 后端只在 fanout 计数 > 0 时 emit：临时会话漏掉 retainSession 就等于一条事件都收不到，
  // 「并行发送」新建的会话会一直停在 running（实机复现过，见 evidence README）。
  assert.deepEqual(
    bridge.callsOf("retainSession").map((call) => call.args[0]),
    [created],
    "临时会话必须挂上事件订阅",
  );

  await session.sendPrompt(created, "只回复 OK", {});
  const tab = session.tab(created);
  assert.equal(tab?.status, "running", "发出后进入 running");
  bridge.deliver({ type: "settled", sessionId: created, runtimeId: `${created}#1`, generation: 1 });
  assert.equal(tab?.status, "ready", "收到 settled 必须回到 ready，而不是永远转圈");
  await session.dispose();
  assert.deepEqual(
    bridge.callsOf("releaseSession").map((call) => call.args[0]),
    [created],
    "关闭时释放同一个订阅，计数不会泄漏",
  );
});

test("并行发送没有落点：直接报错，草稿不丢", async () => {
  const bridge = new FakeBridge();
  const session = new WorkspaceSession(bridge);
  const tab = await startBusyRun(bridge, session);
  tab.projectId = "";
  tab.draft = "另开一路";

  await session.sendPrompt("ses_a", "另开一路", { mode: "parallel" });
  assert.equal(bridge.count("openTemporarySession"), 0, "没有项目就不该去分配临时会话");
  assert.match(tab.error ?? "", /项目/);
  assert.equal(tab.draft, "另开一路", "草稿必须还在");
  await session.dispose();
});
test("忙碌时发送的默认值真的参与决策（三选与设置是同一套语义）", () => {
  // 没选过投递方式：忙碌时用设置里的默认值，空闲时普通投递。
  assert.equal(resolveSendMode(null, false, "steer"), null);
  assert.equal(resolveSendMode(null, true, "steer"), "steer");
  assert.equal(resolveSendMode(null, true, "followUp"), "followUp");

  // 三选里选过的优先：设置里的默认值不能盖掉用户的显式选择。
  for (const busy of [true, false]) {
    for (const delivery of ["steer", "followUp"] as const) {
      assert.equal(resolveSendMode("followUp", busy, delivery), "followUp");
      assert.equal(resolveSendMode("steer", busy, delivery), "steer");
      assert.equal(resolveSendMode("parallel", busy, delivery), "parallel");
    }
  }
});
