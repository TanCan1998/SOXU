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
 *
 * `auto`（Issue #111）：让方向跟着元素位置走（左元素右侧弹、右元素左侧弹、底部向上弹），
 * 见 tooltipPlacement.ts。开启后会在插槽外包一层 `display: inline-flex` 的 span——
 * 测量需要真实盒子，而且禁用态按钮不派发指针事件，提示必须挂在容器上才出得来。
 */
import { computed, ref, watch } from "vue";
import { TooltipContent, TooltipPortal, TooltipRoot, TooltipTrigger } from "reka-ui";
import { TOOLTIP_COLLISION_PADDING_PX, TOOLTIP_SIDE_OFFSET_PX } from "./tooltipConfig.ts";
import { resolveTooltipSide, type TooltipSide } from "./tooltipPlacement.ts";

const props = withDefaults(
  defineProps<{
    /** 提示文案：鼠标悬停与键盘聚焦时读屏都会拿到这段说明。 */
    text: string;
    /** 首选方向；空间不足时由原语自动翻转。 */
    side?: TooltipSide;
    /**
     * 临时关闭提示（例如正在拖拽 Tab）：这时指针只是路过，不是想了解这一项，
     * 弹出的气泡反而挡住插入位置。关闭后键盘聚焦/读屏的 aria 关系也一并撤掉。
     */
    disabled?: boolean;
    /** 按元素位置自动决定方向（覆盖 side）。 */
    auto?: boolean;
  }>(),
  { side: "top", disabled: false, auto: false },
);

const host = ref<HTMLElement | null>(null);
const autoSide = ref<TooltipSide>("top");
const resolvedSide = computed<TooltipSide>(() => (props.auto ? autoSide.value : props.side));

/**
 * 气泡的开关由本地状态持有（受控用法）。
 *
 * 原因：Reka 的 `disabled` 只摘掉新监听器，既不收起已弹出的气泡，也不撤销
 * 已经在跑的「延迟打开」计时器。拖拽 Tab 时指针一直在按钮上，那个计时器到点
 * 仍会把气泡弹出来挡住插入位置，所以 disabled 期间任何打开请求都立即收回。
 */
const open = ref(false);
watch([() => props.disabled, open], ([disabled, isOpen]) => {
  if (disabled && isOpen) open.value = false;
});

/** 打开前先测量：方向在内容渲染前定好，避免先按旧方向画一帧再翻面。 */
function onOpenChange(value: boolean) {
  open.value = value;
  if (value) measure();
}

function measure() {
  if (!props.auto) return;
  const element = host.value;
  if (!element || typeof window === "undefined") return;
  autoSide.value = resolveTooltipSide(element.getBoundingClientRect(), {
    width: window.innerWidth,
    height: window.innerHeight,
  });
}
</script>

<template>
  <TooltipRoot :open="open" :disabled="disabled" @update:open="onOpenChange">
    <TooltipTrigger as-child>
      <span v-if="auto" ref="host" class="tooltip-host"><slot /></span>
      <slot v-else />
    </TooltipTrigger>
    <TooltipPortal>
      <TooltipContent
        class="soxu-tooltip"
        :side="resolvedSide"
        :side-offset="TOOLTIP_SIDE_OFFSET_PX"
        :collision-padding="TOOLTIP_COLLISION_PADDING_PX"
      >
        {{ text }}
      </TooltipContent>
    </TooltipPortal>
  </TooltipRoot>
</template>

<style scoped>
.tooltip-host {
  display: inline-flex;
  align-items: center;
  min-width: 0;
}
</style>
