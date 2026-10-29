/**
 * 会话页设置的响应式状态与持久化（Issue #116 · V4-S2）。
 *
 * 与 useBusyDelivery 同一套写法：初始值来自存储（可注入），只在用户改动时写回，
 * 写入失败不影响界面——设置项的存储是尽力而为的偏好，不是数据。
 */

import { ref, watch, type Ref } from "vue";
import {
  readSessionSettings,
  persistSessionSettings,
  type SessionSettings,
} from "../settings/sessionSettings.ts";

export interface SessionSettingsControls {
  session: Ref<SessionSettings>;
  /** 局部更新：设置面板每次只改一项，不需要把整份设置搬来搬去。 */
  patchSession(patch: Partial<SessionSettings>): void;
}

export function useSessionSettings(): SessionSettingsControls {
  const session = ref<SessionSettings>(readSessionSettings());

  watch(session, (value) => {
    persistSessionSettings(value);
  });

  function patchSession(patch: Partial<SessionSettings>): void {
    const current = session.value;
    const next: SessionSettings = { ...current, ...patch };
    const unchanged = (Object.keys(patch) as Array<keyof SessionSettings>).every(
      (key) => current[key] === next[key],
    );
    if (unchanged) return;
    session.value = next;
  }

  return { session, patchSession };
}
