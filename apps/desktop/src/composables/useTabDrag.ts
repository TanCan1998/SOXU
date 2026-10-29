/**
 * 会话 Tab 的拖拽排序状态机（Issue #99）。
 *
 * 从 `SessionTabs.vue` 抽出来的原因有两条：
 * 1. 指针事件的 add/remove 与状态复位都集中在同一个模块里——系统资源有单一 owner，
 *    组件卸载时只需要调用这里暴露的清理，不会出现「谁加的 listener 谁忘了摘」。
 * 2. 阈值、落位、让位这些规则留在 `tabStripLayout.ts` 的纯函数里，
 *    这里只负责「什么时候调用它们」，不含视觉细节。
 *
 * 元素来源刻意用 DOM 查询而不是 `v-for` 的函数式 ref 数组：关闭一个 Tab 之后
 * ref 数组会留下空洞或错位，落位判定就会整体偏一格；`querySelectorAll` 的返回顺序
 * 与视觉顺序一致，天然免疫这个问题。
 *
 * 语义边界：
 * - 拖拽只表达顺序（`onMove(fromIndex, toIndex)`），从不切换当前会话。
 * - 位移不超过阈值时整段按下/抬起都退化成普通点击，组件用 `consumeClickSuppression()`
 *   判断要不要吞掉随后的 click。
 */

import { computed, onBeforeUnmount, ref, watch } from "vue";
import { TAB_GAP, dropIndex, exceedsDragThreshold, slotShift } from "./tabStripLayout.ts";

/** 每个 Tab 的宿主元素类名（`SessionTabs.vue` 的 scoped 样式同名）。 */
const TAB_ITEM_SELECTOR = ".tab-item";

/** 拖动开始时缓存的几何：之后整段拖拽不再读布局，避免每帧强制重排。 */
interface DragGeometry {
  /** 各 Tab 的水平中心（client 坐标），用于落位命中测试。 */
  centers: number[];
  /** 各 Tab 的左边界（client 坐标），用于定位目标槽位。 */
  lefts: number[];
  /** 参与本次拖动的 Tab 数量（原地拍快照，拖动中数量变化就放弃这次拖动）。 */
  total: number;
  /** 滚动容器的左边界与滚动位置：把 client 坐标换算成容器内容坐标。 */
  containerLeft: number;
  scrollLeft: number;
}

interface DragState {
  fromIndex: number;
  pointerId: number;
  startX: number;
  /** 相对按下位置的横向位移，直接用作被拖 Tab 的 transform。 */
  dx: number;
  /** 是否已越过阈值；没越过的按下/抬起只是一次普通点击。 */
  active: boolean;
  toIndex: number;
  geometry: DragGeometry;
}

export type TabStyle = Record<string, string>;

export interface TabDragOptions {
  /** Tab 数量；拖拽过程中数量变化时缓存的几何已失效，直接放弃这次拖动。 */
  count: () => number;
  /** 滚动容器；拿不到时视为无法拖动。 */
  container: () => HTMLElement | null;
  /** 单个 Tab 的等宽值：让位动画的槽距 = 宽度 + 间距。 */
  tabWidth: () => number;
  /** 落位提交。实现方只改顺序，不改 `activeSessionId`。 */
  onMove: (fromIndex: number, toIndex: number) => void;
}

export function useTabDrag(options: TabDragOptions) {
  const drag = ref<DragState | null>(null);
  /** 松手当帧关闭过渡，避免「先回弹再跳位」的重影。 */
  const settling = ref(false);
  const active = computed(() => drag.value?.active === true);
  /** 拖动结束后的第一次 click 必须吞掉，否则松手会顺带切换会话。 */
  let swallowClick = false;

  function tabElements(): HTMLElement[] {
    const container = options.container();
    return container ? Array.from(container.querySelectorAll<HTMLElement>(TAB_ITEM_SELECTOR)) : [];
  }

  function collectGeometry(elements: HTMLElement[]): DragGeometry | null {
    const container = options.container();
    if (!container) return null;
    const containerRect = container.getBoundingClientRect();
    const centers: number[] = [];
    const lefts: number[] = [];
    for (const element of elements) {
      const rect = element.getBoundingClientRect();
      centers.push(rect.left + rect.width / 2);
      lefts.push(rect.left);
    }
    return {
      centers,
      lefts,
      total: elements.length,
      containerLeft: containerRect.left,
      scrollLeft: container.scrollLeft,
    };
  }

  function onPointerDown(event: PointerEvent) {
    // 只接主键：右键留给系统菜单，中键不参与排序。
    if (event.button !== 0) return;
    // 关闭按钮不是拖拽把手，否则「点关闭」会先排一次序。
    if (event.target instanceof Element && event.target.closest(".tab-close")) return;
    if (drag.value) return;
    const host = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    if (!host) return;
    const elements = tabElements();
    const index = elements.indexOf(host);
    // 只有一个 Tab 时没有可排序的对象，直接按点击处理。
    if (index < 0 || elements.length < 2) return;
    const geometry = collectGeometry(elements);
    if (!geometry) return;
    drag.value = {
      fromIndex: index,
      pointerId: event.pointerId,
      startX: event.clientX,
      dx: 0,
      active: false,
      toIndex: index,
      geometry,
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", cancel);
    // 拖到窗口外松手（或切到别的应用）时收不到 pointerup，靠 blur 兜底，
    // 否则 Tab 会一直停在拖动位置、提示也一直被禁用。
    window.addEventListener("blur", cancel);
  }

  function onPointerMove(event: PointerEvent) {
    const state = drag.value;
    if (!state || event.pointerId !== state.pointerId) return;
    state.dx = event.clientX - state.startX;
    if (!state.active) {
      // 阈值之内仍当点击处理：鼠标抖动、触屏微移都不会改变顺序。
      if (!exceedsDragThreshold(state.dx)) return;
      state.active = true;
    }
    state.toIndex = dropIndex(state.geometry.centers, state.fromIndex, event.clientX);
  }

  function onPointerUp(event: PointerEvent) {
    const state = drag.value;
    if (!state || event.pointerId !== state.pointerId) return;
    const { fromIndex, toIndex, active: wasActive } = state;
    release();
    if (!wasActive) return;
    swallowClick = true;
    // click 在 pointerup 之后派发；用宏任务延后复位，保证被吞掉。
    window.setTimeout(() => {
      swallowClick = false;
    }, 0);
    if (fromIndex !== toIndex) options.onMove(fromIndex, toIndex);
  }

  function cancel() {
    release();
  }

  /** 解除所有 window 级监听；无论正常松手、指针取消、窗口失焦还是组件卸载都必须走到这里。 */
  function release() {
    const state = drag.value;
    drag.value = null;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("blur", cancel);
    if (!state?.active) return;
    settling.value = true;
    requestAnimationFrame(() => {
      settling.value = false;
    });
  }

  /** 组件在 Tab 的 click 里先问一句：这次点击是不是拖拽的余波。 */
  function consumeClickSuppression(): boolean {
    if (!swallowClick) return false;
    swallowClick = false;
    return true;
  }

  /** 该下标是否就是正在被拖的那个 Tab（组件据此加 `.dragging` 样式）。 */
  function isDragged(index: number): boolean {
    const state = drag.value;
    return state?.active === true && state.fromIndex === index;
  }

  /** 被拖的 Tab 跟手，其余 Tab 按落位方向归位一个槽位。 */
  function styleFor(index: number): TabStyle {
    const state = drag.value;
    if (!state?.active) return {};
    if (index === state.fromIndex) {
      return { transform: `translate3d(${Math.round(state.dx)}px, 0, 0)`, zIndex: "3" };
    }
    const shift = slotShift(index, state.fromIndex, state.toIndex);
    if (shift === 0) return {};
    const pitch = options.tabWidth() + TAB_GAP;
    return { transform: `translate3d(${shift * pitch}px, 0, 0)` };
  }

  /**
   * 目标槽位框的位置：无论向左还是向右，被让空出来的永远是目标位的原始位置
   * （右移时后面的 Tab 左移一格，左移时前面的 Tab 右移一格），
   * 所以两个方向都用目标位的左边界，不需要分方向特判。
   */
  const markerStyle = computed<TabStyle | null>(() => {
    const state = drag.value;
    if (!state?.active || state.fromIndex === state.toIndex || state.geometry.total < 2) return null;
    const left = state.geometry.lefts[state.toIndex] ?? 0;
    const x = left - state.geometry.containerLeft + state.geometry.scrollLeft + 1;
    return { transform: `translate3d(${Math.round(x)}px, 0, 0)` };
  });

  // Tab 数量在拖动中变化（例如快捷键关了别的 Tab）时，缓存的几何已失效，放弃这次拖动。
  watch(options.count, () => cancel());

  // 卸载时不留下 window 监听：加与摘都在这个模块里。
  onBeforeUnmount(release);

  return {
    active,
    settling,
    markerStyle,
    onPointerDown,
    styleFor,
    isDragged,
    consumeClickSuppression,
  };
}
