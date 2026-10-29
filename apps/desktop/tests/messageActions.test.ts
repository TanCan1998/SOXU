/**
 * 回归测试：消息操作与剪贴板（Issue #111 · V4-S1）。
 *
 * 复制必须是真实现（clipboard API + execCommand 兜底），重试/回退在后端命令落地前
 * 只能置灰并提示「即将支持」——这里同时钉住「不假装成功」这条底线。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { copyText } from "../src/services/clipboard.ts";

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));

async function readSource(relative: string): Promise<string> {
  return readFile(join(SRC_ROOT, relative), "utf8");
}

test("复制：优先 clipboard API", async () => {
  const written: string[] = [];
  const ok = await copyText("消息原文", {
    clipboard: { writeText: async (text) => void written.push(text) },
    fallback: () => assert.fail("clipboard 可用时不应走兜底"),
  });

  assert.equal(ok, true);
  assert.deepEqual(written, ["消息原文"]);
});

test("复制：clipboard 抛错（权限/非安全上下文）时退回兜底实现", async () => {
  const fallbackCalls: string[] = [];
  const ok = await copyText("回退内容", {
    clipboard: {
      writeText: async () => {
        throw new Error("NotAllowedError");
      },
    },
    fallback: (text) => {
      fallbackCalls.push(text);
      return true;
    },
  });

  assert.equal(ok, true);
  assert.deepEqual(fallbackCalls, ["回退内容"]);
});

test("复制：环境里没有 clipboard 时直接走兜底；两者都失败返回 false", async () => {
  let called = 0;
  const ok = await copyText("x", {
    clipboard: null,
    fallback: () => {
      called += 1;
      return false;
    },
  });

  assert.equal(ok, false);
  assert.equal(called, 1, "没有 clipboard 时兜底必须被调用");

  // 没有 document 的 Node 环境：默认兜底返回 false，不抛错。
  assert.equal(await copyText("x", { clipboard: null }), false);

  // 兜底自己抛错也要被吞掉，调用方只看到 false。
  const thrown = await copyText("x", {
    clipboard: null,
    fallback: () => {
      throw new Error("boom");
    },
  });
  assert.equal(thrown, false);
});

test("消息操作：复制是真按钮，重试/回退置灰并提示即将支持", async () => {
  const source = await readSource("components/MessageActions.vue");

  assert.ok(source.includes("copyText"), "复制必须调用统一的剪贴板实现");
  assert.ok(source.includes('aria-label="重试（即将支持）"'), "重试按钮必须说明尚未支持");
  assert.ok(source.includes('aria-label="回退到这里（即将支持）"'), "回退按钮同样说明尚未支持");
  assert.ok(source.includes("即将支持"), "tooltip 文案包含「即将支持」");

  // 两个后端未实现的按钮必须 disabled：不能出现「点了没反应」的假交互。
  const disabledCount = source.match(/disabled/g)?.length ?? 0;
  assert.ok(disabledCount >= 2, "重试与回退都必须处于 disabled 状态");
  assert.ok(
    source.includes("onBeforeUnmount"),
    "复制反馈的计时器必须在卸载时释放（资源单一 owner）",
  );
  assert.ok(!/\stitle=/.test(source), "提示统一走 AppTooltip，不用原生 title");
  assert.ok(source.includes("auto"), "操作按钮贴着右侧，提示方向按位置自动选择");
});

test("会话列表：用户与 agent 消息走 markdown，工具输出折叠保持原样", async () => {
  const source = await readSource("components/MessageList.vue");

  assert.ok(source.includes("MarkdownContent"), "消息正文必须走 markdown 渲染");
  assert.ok(source.includes('message?.role === "user" || message?.role === "assistant"'));
  assert.ok(source.includes("TOOL_FOLD_CHARS = 360"), "工具输出折叠阈值保持 360 字符");
  assert.ok(source.includes("展开工具输出"), "工具调用折叠块保留现有实现");
  assert.ok(source.includes("MessageActions"), "agent 消息要有 hover 操作");
  assert.ok(source.includes('message?.role === "assistant"'), "只有 agent 消息显示操作");
  assert.ok(
    source.includes(".message:hover :deep(.message-actions)"),
    "操作默认隐藏，hover 才出现",
  );
});

test("markdown 渲染层：v-html 的内容只来自渲染器，链接点击被接管", async () => {
  const source = await readSource("components/MarkdownContent.vue");

  assert.ok(source.includes("v-html=\"html\""), "渲染结果通过 v-html 挂载");
  assert.ok(source.includes("renderMarkdown"), "HTML 必须由 markdownRenderer 生成");
  assert.ok(source.includes("highlightWithin"), "挂载后异步升级高亮");
  assert.ok(source.includes("event.preventDefault()"), "链接点击不能把应用导航走");
  assert.ok(source.includes("onBeforeUnmount"), "异步批次与提示计时器要在卸载时收口");

  // 流式输出期间不排队高亮：每个 delta 都会整体重渲染，逐帧着色等于白烧 CPU。
  assert.ok(source.includes("props.streaming"), "流式期间必须跳过高亮");
  const list = await readSource("components/MessageList.vue");
  assert.ok(
    list.includes(':streaming="messages[item.index]?.streaming ?? false"'),
    "MessageList 必须把流式状态透传给渲染层",
  );
});
