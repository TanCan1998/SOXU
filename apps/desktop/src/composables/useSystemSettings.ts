/**
 * 系统页设置的响应式状态与持久化（Issue #116 · V4-S2）。
 *
 * 三个开关目前只落到存储：更新检查、系统通知、托盘行为分别属于发布流程与
 * 通知切片（Issue #117），本切片不假装它们已经生效。
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
