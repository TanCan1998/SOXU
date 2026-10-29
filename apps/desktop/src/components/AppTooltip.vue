<script setup lang="ts">
/**
 * 统一悬浮提示：复用 Reka UI 的 Tooltip 原语（已在依赖内），不新增依赖。
 *
 * 延迟、焦点触发、Escape 关闭、aria-describedby、碰撞翻转都由原语负责；
 * 这里只固定 SOXU 的参数与呈现层 class。内容经 portal 挂到 body，
 * 因此不会被侧栏/顶栏的 overflow 裁掉，也不受父级 transform 影响。
 *
 * 用法：把原来写 title 的元素包进来，文本通过 text 传入。
 *   <AppTooltip text="侧栏 (Ctrl+B)"><button class="icon-button">…</button></AppTooltip>
 */
import { TooltipContent, TooltipPortal, TooltipRoot, TooltipTrigger } from "reka-ui";
import { TOOLTIP_COLLISION_PADDING_PX, TOOLTIP_SIDE_OFFSET_PX } from "./tooltipConfig.ts";

withDefaults(
  defineProps<{
    /** 提示文案：鼠标悬停与键盘聚焦时读屏都会拿到这段说明。 */
    text: string;
    /** 首选方向；空间不足时由原语自动翻转。 */
    side?: "top" | "right" | "bottom" | "left";
  }>(),
  { side: "top" },
);
</script>

<template>
  <TooltipRoot>
    <TooltipTrigger as-child>
      <slot />
    </TooltipTrigger>
    <TooltipPortal>
      <TooltipContent
        class="soxu-tooltip"
        :side="side"
        :side-offset="TOOLTIP_SIDE_OFFSET_PX"
        :collision-padding="TOOLTIP_COLLISION_PADDING_PX"
      >
        {{ text }}
      </TooltipContent>
    </TooltipPortal>
  </TooltipRoot>
</template>
