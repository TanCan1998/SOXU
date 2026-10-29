/**
 * 「添加项目」的系统目录选择状态（Vue 侧）。
 *
 * 负责三件容易写错的事：连续点击只开一个对话框、用户取消不产生任何状态变化、
 * 环境打不开选择器时把原因交给界面显示。路径规整在 services/projectDirectory.ts。
 */

import { ref } from "vue";

import { pickProjectDirectoryFromSystem } from "../services/directoryPicker.ts";

export function useProjectDirectoryPick() {
  const picking = ref(false);
  /** 只在「选择器打不开」时写入；用户取消保持 null，界面不显示错误。 */
  const pickError = ref<string | null>(null);

  /** 返回选中的绝对路径；取消或失败返回 null，调用方保持原状态。 */
  async function pick(): Promise<string | null> {
    if (picking.value) return null;
    picking.value = true;
    pickError.value = null;
    try {
      const outcome = await pickProjectDirectoryFromSystem();
      if (outcome.status === "picked") return outcome.path;
      if (outcome.status === "unavailable") {
        pickError.value = `无法打开系统目录选择器：${outcome.reason}`;
      }
      return null;
    } finally {
      picking.value = false;
    }
  }

  return { picking, pickError, pick };
}
