<!--
  设置项的统一行布局（Issue #116，Issue #123 起标题改由元数据目录提供）。

  为什么做成组件：四个页面共 20 个设置项，行距、标签字号、注释样式必须一致；
  逐个页面手写 <div class="field"> 迟早漂移。

  为什么标题不写在面板里：Issue #123 要求「命令注册表与设置项共用一份元数据」。
  标题与默认说明统一来自 settings/catalog.ts，面板只写 setting="appearance.theme"，
  于是「设置页显示的名字」与「命令面板搜到的名字」在结构上不可能不一致。

  无障碍：标题元素带 useId 生成的 id，并通过插槽把 labelId 交给控件，
  控件用它做 aria-labelledby —— 读屏读到的名字与界面上的可见标题逐字一致。
-->
<script setup lang="ts">
import { computed } from "vue";
import { useId } from "reka-ui";

import { settingsEntry } from "../../settings/catalog.ts";
import { useLocale } from "../../locales/index.ts";

const props = defineProps<{
  /**
   * 设置项 id（settings/catalog.ts），标题与默认说明都由它决定。
   *
   * 与 labelKey 二选一：catalog 只收录「设置页有独立行」的项（20 项），
   * 扩展页是静态列表没有条目，但语言包页（Issue #135）确实需要同样的行布局。
   */
  setting?: string;
  /**
   * i18n key：标题直接走 t()，不查 catalog。
   *
   * 用于标题本身必须随语言切换的行。catalog 是纯中文常量，
   * 而语言包页的「内置语言 / 已导入的语言包」要跟着界面语言变。
   */
  labelKey?: string;
  /** 覆盖目录里的说明：仅用于含动态值的行（当前版本 / 数据目录 / 平台）。 */
  description?: string;
}>();

const { t } = useLocale();
const meta = computed(() => (props.setting ? settingsEntry(props.setting) : null));
const resolvedLabel = computed(() => {
  if (props.labelKey) return t(props.labelKey);
  return meta.value?.label ?? "";
});
const description = computed(() => props.description ?? meta.value?.description);

const labelId = useId();
</script>

<template>
  <div class="row" :data-setting="setting ?? ''">
    <div class="row-text">
      <p :id="labelId" class="row-label">{{ resolvedLabel }}</p>
      <p v-if="description" class="row-desc">{{ description }}</p>
    </div>
    <div class="row-control">
      <slot :label-id="labelId" />
    </div>
    <p v-if="$slots.note" class="row-note">
      <slot name="note" />
    </p>
  </div>
</template>

<style scoped>
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  padding: 11px 0;
  border-bottom: 1px solid var(--border);
}

.row:last-child {
  border-bottom: 0;
}

.row-text {
  min-width: 0;
  flex: 1 1 190px;
}

.row-label {
  margin: 0;
  font-size: 0.78125rem;
  color: var(--fg);
}

.row-desc {
  margin: 3px 0 0;
  font-size: 0.6875rem;
  line-height: 1.55;
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}

.row-control {
  display: flex;
  flex: 0 1 auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

/* 注释占满一整行：它解释的是「为什么现在只能这样」，属于整行的补充说明。 */
.row-note {
  flex: 1 0 100%;
  margin: 0;
  font-size: 0.65625rem;
  line-height: 1.65;
  color: var(--fg-subtle);
}
</style>
