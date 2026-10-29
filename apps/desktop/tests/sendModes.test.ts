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
  SEND_MODE_TEXT,
  isPlainTextDraft,
  sendModeAvailability,
  sendModeLabel,
} from "../src/components/sendMode.ts";
import {
  BUSY_DELIVERY_OPTIONS,
  DEFAULT_BUSY_DELIVERY,
} from "../src/settings/busyDelivery.ts";
import { WorkspaceSession } from "../src/workspace/sessionWorkspace.ts";
import { FakeBridge } from "./support/fakeBridge.ts";

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));
const TAURI_ROOT = fileURLToPath(new URL("../src-tauri", import.meta.url));

async function readSource(relative: string): Promise<string> {
  return readFile(join(SRC_ROOT, relative), "utf8");
}

test("三项顺序与文案照决策文档：加入当前 / 排到下轮 / 并行发送", () => {
  assert.deepEqual(SEND_MODE_ORDER, ["steer", "followUp", "parallel"]);
  assert.equal(SEND_MODE_TEXT.steer.label, "加入当前");
  assert.equal(SEND_MODE_TEXT.followUp.label, "排到下轮");
  assert.equal(SEND_MODE_TEXT.parallel.label, "并行发送");
  assert.equal(
    SEND_MODE_TEXT.parallel.description,
    "独立会话后台处理，不打断当前输出",
    "并行发送的描述必须与决策文档逐字一致",
  );
  assert.equal(sendModeLabel("steer"), "加入当前");
  assert.equal(sendModeLabel("followUp"), "排到下轮");
});

test("加入当前：仅 agent 忙碌时可用，空闲置灰并给出原因", () => {
  const idle = sendModeAvailability({ busy: false, draft: "写个测试" });
  assert.equal(idle.steer.enabled, false, "空闲时不需要插进当前回合");
  assert.ok(idle.steer.reason && idle.steer.reason.length > 0, "置灰必须说明原因");

  const busy = sendModeAvailability({ busy: true, draft: "写个测试" });
  assert.equal(busy.steer.enabled, true);
  assert.equal(busy.steer.reason, null);
});

test("排到下轮：任何状态都可用", () => {
  for (const busy of [true, false]) {
    for (const draft of ["", "  ", "有内容"]) {
      const availability = sendModeAvailability({ busy, draft });
      assert.equal(availability.followUp.enabled, true, `busy=${busy} draft="${draft}"`);
      assert.equal(availability.followUp.reason, null);
    }
  }
});

test("并行发送：草稿非空 + 纯文本 + 有项目，三个条件缺一不可", () => {
  const ready = sendModeAvailability({ busy: false, draft: "帮我查一下", attachments: 0 });
  assert.equal(ready.parallel.enabled, true);

  const emptyDraft = sendModeAvailability({ busy: false, draft: "   " });
  assert.equal(emptyDraft.parallel.enabled, false, "空草稿不能并行发送");
  assert.match(emptyDraft.parallel.reason ?? "", /输入/);

  const withAttachment = sendModeAvailability({ busy: false, draft: "看图", attachments: 1 });
  assert.equal(withAttachment.parallel.enabled, false, "带附件的消息不能并行发送");
  assert.match(withAttachment.parallel.reason ?? "", /附件/);

  const noProject = sendModeAvailability({ busy: false, draft: "看图", hasProject: false });
  assert.equal(noProject.parallel.enabled, false, "没有 projectId 就没有落点");
  assert.match(noProject.parallel.reason ?? "", /项目/);

  // 忙碌时并行发送同样可用：它的语义就是「不打断当前输出」。
  const busy = sendModeAvailability({ busy: true, draft: "另开一路" });
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
    source.includes("item.enabled ? item.description : item.reason"),
    "置灰项要在描述位置写出原因",
  );
  assert.ok(!/\stitle=/.test(source), "提示不走原生 title（统一 AppTooltip）");
});

test("composer：模式横条 + 取消按钮，待发模式按会话隔离且用完即清", async () => {
  const source = await readSource("components/ChatComposer.vue");

  assert.ok(source.includes("下一条消息将"), "横条文案与原型一致");
  assert.ok(source.includes("send-mode-bar"), "横条使用原型的 class 名");
  assert.ok(source.includes("取消发送方式"), "横条必须有取消按钮");
  assert.ok(source.includes("sessionId"), "待发模式要按会话记录");
  assert.ok(source.includes("pendingBySession"), "会话切换不能串味");
  assert.ok(source.includes('emit("send", mode)'), "发送时把模式带出去");
  assert.ok(source.includes("if (mode) clearMode()"), "选择只对下一条消息生效");
  assert.ok(source.includes("ComposerSendMenu"), "caret 钮是独立的发送选项菜单");
  assert.ok(source.includes("defaultDelivery"), "忙碌时的默认投递方式由设置透传");
  assert.ok(source.includes("--ease-spring"), "动效统一引用 --ease-spring");
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
    const availability = sendModeAvailability({ busy: item.busy, draft: item.draft });
    const actual = SEND_MODE_ORDER.map((mode) => availability[mode].enabled);
    assert.deepEqual(
      actual,
      item.expect,
      `busy=${item.busy} draft="${item.draft}" 的可用状态不符`,
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

  const dialog = await readSource("components/SettingsDialog.vue");
  assert.ok(dialog.includes("忙碌时发送"), "设置面板必须有这一项");
  assert.ok(dialog.includes("BUSY_DELIVERY_OPTIONS"), "选项表来自 busyDelivery.ts");
  assert.ok(dialog.includes("soxu-settings-busy-delivery"), "字段要有 aria-labelledby 的 id");
  assert.ok(dialog.includes("role=\"radiogroup\""), "两选一是单选组");
  assert.ok(dialog.includes("emit('update:busyDelivery'"), "选择要向上冒泡");

  const app = await readSource("App.vue");
  assert.ok(app.includes("useBusyDelivery"), "App 持有投递方式状态");
  assert.ok(app.includes(':default-delivery="busyDelivery"'), "透传给会话面板");
  assert.ok(app.includes(':busy-delivery="busyDelivery"'), "透传给设置面板");
  assert.ok(app.includes('@update:busyDelivery="setBusyDelivery"'), "设置改动回写状态");
});

test("参数管道：mode/thinking 走到 bridge，但忙碌时仍然直接返回", async () => {
  const bridge = new FakeBridge();
  const session = new WorkspaceSession(bridge);
  await session.openSession({ sessionId: "ses_a", projectId: "prj_1", title: "会话 A" });
  await session.startRuntime("ses_a");

  await session.sendPrompt("ses_a", "  下一条  ", { mode: "followUp", thinking: "high" });
  const call = bridge.callsOf("sendPrompt")[0];
  assert.deepEqual(
    call?.args,
    ["ses_a", "下一条", { mode: "followUp", thinking: "high" }],
    "mode/thinking 必须原样透传给 bridge",
  );

  // 本切片不做运行时语义：忙碌时仍然不发送，草稿留在 Tab 上（等后续切片实现）。
  await session.sendPrompt("ses_a", "插进当前", { mode: "steer" });
  assert.equal(bridge.count("sendPrompt"), 1, "忙碌时的投递语义不在本切片范围内");

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
  assert.ok(
    commands.includes("let _ = (mode, thinking);"),
    "本切片只做参数管道：显式声明参数被接收但不改变行为",
  );

  const dto = await readFile(join(TAURI_ROOT, "src", "dto", "session.rs"), "utf8");
  assert.ok(dto.includes("pub enum PromptMode"), "投递方式在 DTO 层定义");
  assert.ok(dto.includes("pub enum ThinkingLevel"), "思考强度在 DTO 层定义");
});
