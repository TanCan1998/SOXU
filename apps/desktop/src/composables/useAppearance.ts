/**
 * 外观（字号 + 界面字体 + 代码字体 + 正文宽度 + 强调色）的响应式状态与副作用
 * （Issue #98 / #116）。
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
  type AccentName,
  type Appearance,
  type CodeFontName,
  type ContentWidthName,
  type FontFamilyName,
  type FontSizeName,
} from "../theme/appearance.ts";

export interface AppearanceControls {
  /** 当前外观；设置面板按它渲染选中态，改它等于改外观。 */
  appearance: Ref<Appearance>;
  setFontSize(value: FontSizeName): void;
  setFontFamily(value: FontFamilyName): void;
  setAccent(value: AccentName): void;
  setCodeFont(value: CodeFontName): void;
  setContentWidth(value: ContentWidthName): void;
  /** 整块替换（设置面板把一份完整外观冒泡上来时用）；值没变就不写存储。 */
  patchAppearance(next: Appearance): void;
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

  /** 只有真的变了才换新对象：避免一次无意义的写入，也避免触发多余的 DOM 落地。 */
  function update(next: Appearance): void {
    const current = appearance.value;
    if (
      next.fontSize === current.fontSize &&
      next.fontFamily === current.fontFamily &&
      next.codeFont === current.codeFont &&
      next.contentWidth === current.contentWidth &&
      next.accent === current.accent
    ) {
      return;
    }
    appearance.value = next;
  }

  function setFontSize(value: FontSizeName) {
    update({ ...appearance.value, fontSize: value });
  }

  function setFontFamily(value: FontFamilyName) {
    update({ ...appearance.value, fontFamily: value });
  }

  function setAccent(value: AccentName) {
    update({ ...appearance.value, accent: value });
  }

  function setCodeFont(value: CodeFontName) {
    update({ ...appearance.value, codeFont: value });
  }

  function setContentWidth(value: ContentWidthName) {
    update({ ...appearance.value, contentWidth: value });
  }

  return {
    appearance,
    setFontSize,
    setFontFamily,
    setAccent,
    setCodeFont,
    setContentWidth,
    patchAppearance: update,
  };
}
