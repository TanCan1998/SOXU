<script setup lang="ts">
/**
 * 发送选项菜单。
 *
 * 结构照 PiDeck `ComposerPanels.tsx:368-410`：主钮旁边一个 caret 钮，
 * 点开是 reka-ui DropdownMenu，`side="top" align="end" side-offset=6`（贴着主钮向上弹出、右对齐）。
 *
 * 可用条件全部来自 `sendMode.ts` 的纯函数，组件不自己判断：
 * 不可用的项直接 `disabled`，并在描述位置写出原因（不用 title 属性，
 * 项目的悬浮说明统一走 AppTooltip；菜单项里塞 tooltip 会和菜单的键盘交互打架）。
 *
 * 三种投递方式的运行时语义自 Issue #146 起全部接通（协议事实与实测见
 * docs/development/send-modes.md）：steer / followUp 走 Pi 的 streamingBehavior，
 * parallel 由前端另开临时会话。菜单里因此不再有「可见但点了没效果」的选项；
 * 仍然不可点的项都是**条件不满足**（例如空闲时的「加入当前」），并当场写出原因。
 *
 * 回滚路径保留：`sendModeAvailability` 的 ready=false 会把三项整体置灰并显示
 * 「即将支持」，用于协议回退到旧版本的情况（测试覆盖）。
 */

import { computed } from "vue";
import { ChevronUp, CornerDownLeft, GitBranch, ListOrdered } from "@lucide/vue";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from "reka-ui";

import {
  SEND_MODE_ORDER,
  sendModeAvailability,
  sendModeDescription,
  sendModeLabel,
  type SendModeContext,
} from "./sendMode.ts";
import { useLocale } from "../locales/index.ts";
import type { SendMode } from "../workspace/types.ts";

/*
 * 注意：boolean 类型的 prop 在 Vue 里"缺省即 false"（Boolean casting），
 * 所以 hasProject 必须显式给默认值 true——否则「没传」会被读成「没有项目」，
 * 协议接入后并行发送会被莫名置灰。attachments 是 number，缺省是 undefined，同样给个 0 兜底。
 */
const props = withDefaults(
  defineProps<{
    /** agent 是否正在跑一轮（决定「加入当前」是否可用）。 */
    busy: boolean;
    draft: string;
    /** 附件数量；首版恒为 0，条件已按决策文档写好。 */
    attachments?: number;
    /** 是否有已登记的 projectId：并行发送要落到一个项目下的临时会话。 */
    hasProject?: boolean;
    disabled: boolean;
  }>(),
  { attachments: 0, hasProject: true, disabled: false },
);

const emit = defineEmits<{ (event: "select", mode: SendMode): void }>();

const { t } = useLocale();

/** 菜单项与可用条件：一次算好，模板只做渲染。 */
const items = computed(() => {
  const context: SendModeContext = {
    busy: props.busy,
    draft: props.draft,
    attachments: props.attachments ?? 0,
    hasProject: props.hasProject ?? true,
  };
  const availability = sendModeAvailability(context);
  return SEND_MODE_ORDER.map((mode) => ({
    mode,
    label: sendModeLabel(mode),
    description: sendModeDescription(mode),
    enabled: availability[mode].enabled,
    reason: availability[mode].reason,
  }));
});

const icons = { steer: CornerDownLeft, followUp: ListOrdered, parallel: GitBranch } as const;

function choose(mode: SendMode) {
  emit("select", mode);
}
</script>

<template>
  <DropdownMenuRoot>
    <DropdownMenuTrigger as-child>
      <button
        class="send-caret send-mode-trigger"
        type="button"
        :aria-label="t('composer.menu.trigger')"
        :disabled="disabled"
      >
        <ChevronUp :size="13" :stroke-width="2.2" aria-hidden="true" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent
        class="send-menu"
        side="top"
        align="end"
        :side-offset="6"
        :collision-padding="8"
        :aria-label="t('composer.menu.label')"
      >
        <DropdownMenuItem
          v-for="item in items"
          :key="item.mode"
          class="send-menu-item"
          :disabled="!item.enabled"
          :data-mode="item.mode"
          @select="choose(item.mode)"
        >
          <component :is="icons[item.mode]" :size="14" :stroke-width="1.9" aria-hidden="true" />
          <span class="mi-text">
            <span class="mi-label">{{ item.label }}</span>
            <!--
              描述始终显示（用户要知道「加入当前」是什么意思），不可用时再把原因接在后面。
              只用原因替换描述会让三项看起来一模一样，反而看不出它们的差别。
            -->
            <span class="mi-desc">
              {{ item.description }}<template v-if="!item.enabled"> · {{ item.reason }}</template>
            </span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>

<style scoped>
/*
 * 与主钮拼成一个整体：右半是 caret，左侧一条分隔线（原型 send-split）。
 *
 * 前景与分隔线必须引用 --soxu-on-accent（复审阻塞点）：
 * 上一版这里写死 #fff，在青绿/蓝绿/玫红/琥珀四个色板上是白字压浅底——
 * 琥珀 2.15:1、蓝绿 2.49:1，低于 WCAG 1.4.11 的非文本 3:1。
 * 色板自己在 base.css 里按「白/墨取对比度更高者」定义这个 token，
 * 组件只消费它；实测见 tests/sendCaretContrast.test.ts 与
 * docs/development/evidence/issue-116-v4-s2/README.md §3.7。
 */
.send-caret {
  display: grid;
  place-items: center;
  width: 26px;
  height: 30px;
  color: var(--soxu-on-accent);
  border-left: 1px solid color-mix(in srgb, var(--soxu-on-accent) 28%, transparent);
  transition:
    background-color var(--soxu-motion-fast) var(--soxu-motion-ease),
    transform var(--soxu-motion-fast) var(--ease-spring, var(--soxu-motion-ease));
}

.send-caret:hover:enabled {
  background: color-mix(in srgb, var(--soxu-accent) 84%, #000);
}

.send-caret:active:enabled {
  transform: scale(0.96);
}

.send-caret:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>

<style>
/*
 * 菜单内容渲染在 portal 里（挂到 body），拿不到 scoped 属性，因此这一段是全局样式，
 * 选择器统一带 .send-menu 前缀，不会影响其他浮层。
 */
.send-menu {
  z-index: 70;
  min-width: 208px;
  padding: 5px;
  border-radius: 10px;
  border: 1px solid var(--soxu-border);
  background: var(--soxu-panel);
  box-shadow: var(--soxu-shadow-raised);
  animation: soxu-send-menu-in var(--soxu-motion-base) var(--ease-spring, var(--soxu-motion-ease));
}

@keyframes soxu-send-menu-in {
  from {
    opacity: 0;
    transform: translateY(4px) scale(0.98);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

.send-menu-item {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 7px 9px;
  border-radius: 7px;
  color: var(--soxu-subtext);
  font-size: 0.75rem;
  outline: none;
  cursor: pointer;
  transition:
    background-color var(--soxu-motion-fast) var(--soxu-motion-ease),
    color var(--soxu-motion-fast) var(--soxu-motion-ease);
}

.send-menu-item[data-highlighted] {
  background: var(--soxu-hover);
  color: var(--soxu-fg);
}

.send-menu-item[data-disabled] {
  opacity: 0.45;
  cursor: default;
}

.send-menu-item[data-disabled][data-highlighted] {
  background: transparent;
  color: var(--soxu-subtext);
}

.send-menu-item .mi-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.send-menu-item .mi-label {
  color: var(--soxu-fg);
}

.send-menu-item .mi-desc {
  font-size: 0.6875rem;
  line-height: 1.45;
  color: var(--soxu-muted);
}

@media (prefers-reduced-motion: reduce) {
  .send-menu {
    animation: none;
  }
}
</style>
