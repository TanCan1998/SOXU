/**
 * 回归测试：位置感知的悬浮提示方向（Issue #111 · V4-S1）。
 *
 * 纯函数映射：左元素右侧弹、右元素左侧弹、底部向上弹；没有视口尺寸时退回向上。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BOTTOM_EDGE_RATIO,
  HORIZONTAL_EDGE_RATIO,
  resolveTooltipSide,
} from "../src/components/tooltipPlacement.ts";

const VIEWPORT = { width: 1200, height: 800 };
const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));

function rect(left: number, top: number, width = 26, height = 26) {
  return { left, top, width, height };
}

test("右侧元素：提示弹在左边", () => {
  const right = rect(VIEWPORT.width - 60, 200);
  assert.equal(resolveTooltipSide(right, VIEWPORT), "left");
});

test("左侧元素：提示弹在右边", () => {
  assert.equal(resolveTooltipSide(rect(16, 200), VIEWPORT), "right");
});

test("底部元素：提示向上弹（不盖住输入框）", () => {
  const bottom = rect(600, VIEWPORT.height - 60);
  assert.equal(resolveTooltipSide(bottom, VIEWPORT), "top");
});

test("中部元素：保持向上弹，与既有观感一致", () => {
  assert.equal(resolveTooltipSide(rect(600, 200), VIEWPORT), "top");
});

test("阈值是公开常量：水平 60%、底部 72%", () => {
  assert.equal(HORIZONTAL_EDGE_RATIO, 0.6);
  assert.equal(BOTTOM_EDGE_RATIO, 0.72);
});

test("没有视口尺寸（未挂载/隐藏窗口）时退回向上", () => {
  assert.equal(resolveTooltipSide(rect(10, 10), { width: 0, height: 0 }), "top");
  assert.equal(resolveTooltipSide(rect(10, 10), { width: -1, height: 800 }), "top");
});

test("AppTooltip 支持 auto 方向：测量容器后再决定 side", async () => {
  const source = await readFile(join(SRC_ROOT, "components", "AppTooltip.vue"), "utf8");

  assert.ok(source.includes("auto"), "AppTooltip 必须提供 auto 选项");
  assert.ok(source.includes("resolveTooltipSide"), "方向必须走位置映射函数");
  assert.ok(source.includes("getBoundingClientRect"), "按触发器真实矩形测量");
  assert.ok(source.includes("tooltip-host"), "auto 模式需要一个可测量的容器（禁用按钮不派发指针事件）");
});
