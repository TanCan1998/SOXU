/**
 * 系统页设置的响应式状态与持久化（Issue #116 · V4-S2）。
 *
 * 这里只负责「状态 + 落盘」，与后端/通知层的接线由 App.vue 完成：
 * - 完成通知总闸传给 useNotifications；
 * - 关闭行为经 settings/systemBridge.ts 推给 Rust 托盘层。
 *
 * 拆开的好处是 composable 仍然可以在 Node 里用假存储断言读写，
 * 不需要 Tauri 宿主或通知 store。
 */

import { ref, watch, type Ref } from "vue";
import {
  readSystemSettings,
  persistSystemSettings,
  type SystemSettings,
} from "../settings/systemSettings.ts";

export interface SystemSettingsControls {
  system: Ref<SystemSettings>;
  patchSystem(patch: Partial<SystemSettings>): void;
}

export function useSystemSettings(): SystemSettingsControls {
  const system = ref<SystemSettings>(readSystemSettings());

  watch(system, (value) => {
    persistSystemSettings(value);
  });

  function patchSystem(patch: Partial<SystemSettings>): void {
    const current = system.value;
    const next: SystemSettings = { ...current, ...patch };
    const unchanged = (Object.keys(patch) as Array<keyof SystemSettings>).every(
      (key) => current[key] === next[key],
    );
    if (unchanged) return;
    system.value = next;
  }

  return { system, patchSystem };
}
