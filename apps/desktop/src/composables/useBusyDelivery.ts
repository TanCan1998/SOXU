/**
 * 「忙碌时发送」设置的响应式状态（Issue #111 · V4-S1）。
 *
 * 与 useAppearance 同一套纪律：只在用户改动时写 localStorage，
 * 启动时不把默认值当成用户偏好写进去。
 */

import { ref, watch, type Ref } from "vue";

import {
  persistBusyDelivery,
  readBusyDelivery,
  type BusySendDelivery,
} from "../settings/busyDelivery.ts";

export interface BusyDeliveryControls {
  busyDelivery: Ref<BusySendDelivery>;
  setBusyDelivery(value: BusySendDelivery): void;
}

export function useBusyDelivery(): BusyDeliveryControls {
  const busyDelivery = ref<BusySendDelivery>(readBusyDelivery());

  watch(busyDelivery, (value) => {
    persistBusyDelivery(value);
  });

  function setBusyDelivery(value: BusySendDelivery) {
    if (value === busyDelivery.value) return;
    busyDelivery.value = value;
  }

  return { busyDelivery, setBusyDelivery };
}
