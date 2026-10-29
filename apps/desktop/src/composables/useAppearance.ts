/**
 * 外观（字号 + 字体族）的响应式状态与副作用（Issue #98）。
 *
 * 抽成 composable 而不是继续写在 App.vue：App.vue 已接近 600 行，
 * 而这段逻辑与主题共享同一条纪律（同步落地 DOM、只在用户改动时持久化），
 * 放在一起能整体测（见 tests/appearance.test.ts 的 useAppearance 用例）。
 */

import { ref, watch, type Ref } from "vue";
import {
  applyDocumentAppearance,
  persistAppearance,
  resolveInitialAppearance,
  type Appearance,
  type FontFamilyName,
  type FontSizeName,
} from "../theme/appearance.ts";

export interface AppearanceControls {
  /** 当前外观；设置面板按它渲染选中态，改它等于改外观。 */
  appearance: Ref<Appearance>;
  setFontSize(value: FontSizeName): void;
  setFontFamily(value: FontFamilyName): void;
}

export function useAppearance(): AppearanceControls {
  const appearance = ref<Appearance>(resolveInitialAppearance());

  // 持久化只在用户改动时发生（与 theme.ts 一致）：没动过设置的用户不会被首次启动写死一份默认值。
  watch(appearance, (value) => {
    persistAppearance(value);
  });

  /**
   * 落地 DOM：flush "sync" + immediate。
   * data-* 必须和这次提交在同一帧写进 <html>，否则改字号的那一帧仍按旧 token 排版，
   * 文字会先按旧尺寸画一次再跳；immediate 则接管启动时（挂载后）的第一次落地。
   */
  watch(
    appearance,
    (value) => {
      applyDocumentAppearance(value);
    },
    { flush: "sync", immediate: true },
  );

  function setFontSize(value: FontSizeName) {
    if (value === appearance.value.fontSize) return;
    appearance.value = { ...appearance.value, fontSize: value };
  }

  function setFontFamily(value: FontFamilyName) {
    if (value === appearance.value.fontFamily) return;
    appearance.value = { ...appearance.value, fontFamily: value };
  }

  return { appearance, setFontSize, setFontFamily };
}
