/**
 * 回归测试：设置里的「忙碌时发送」默认投递（Issue #111 · V4-S1）。
 *
 * 与外观偏好同一套纪律：默认值不写存储、脏值逐字段回退、存储不可用不抛错。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { nextTick } from "vue";

import { useBusyDelivery } from "../src/composables/useBusyDelivery.ts";
import {
  BUSY_DELIVERY_OPTIONS,
  BUSY_DELIVERY_STORAGE_KEY,
  DEFAULT_BUSY_DELIVERY,
  isBusySendDelivery,
  persistBusyDelivery,
  readBusyDelivery,
  type KeyValueStorage,
} from "../src/settings/busyDelivery.ts";

class FakeStorage implements KeyValueStorage {
  readonly entries = new Map<string, string>();
  failOnGet = false;
  failOnSet = false;

  getItem(key: string): string | null {
    if (this.failOnGet) throw new Error("SecurityError");
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failOnSet) throw new Error("QuotaExceededError");
    this.entries.set(key, value);
  }
}

test("默认值与存储键：加入当前 + 独立键名", () => {
  assert.equal(DEFAULT_BUSY_DELIVERY, "steer");
  assert.equal(BUSY_DELIVERY_STORAGE_KEY, "soxu.busyDelivery");
  assert.deepEqual(readBusyDelivery(new FakeStorage()), "steer");
  assert.equal(readBusyDelivery(null), "steer", "没有 localStorage 时用默认值");
});

test("合法性：只认 steer / followUp（并行发送不是默认项）", () => {
  for (const value of ["steer", "followUp"]) {
    assert.equal(isBusySendDelivery(value), true, value);
  }
  for (const value of ["parallel", "", null, undefined, 0, "Steer"]) {
    assert.equal(isBusySendDelivery(value), false, String(value));
  }
  assert.deepEqual(
    BUSY_DELIVERY_OPTIONS.map((option) => option.value),
    ["steer", "followUp"],
  );
});

test("读写往返：脏值退回默认，写入只落规范化后的值", () => {
  const storage = new FakeStorage();
  assert.equal(persistBusyDelivery("followUp", storage), true);
  assert.equal(readBusyDelivery(storage), "followUp");

  const dirty = new FakeStorage();
  dirty.entries.set(BUSY_DELIVERY_STORAGE_KEY, "parallel");
  assert.equal(readBusyDelivery(dirty), "steer", "并行发送不能作为默认投递");

  const normalize = new FakeStorage();
  assert.equal(persistBusyDelivery("parallel" as never, normalize), true);
  assert.equal(normalize.entries.get(BUSY_DELIVERY_STORAGE_KEY), "steer");
});

test("存储不可用（隐私模式 / 配额满）不抛错", () => {
  const broken = new FakeStorage();
  broken.failOnGet = true;
  assert.equal(readBusyDelivery(broken), "steer");

  const full = new FakeStorage();
  full.failOnSet = true;
  assert.equal(persistBusyDelivery("followUp", full), false);
  assert.equal(persistBusyDelivery("followUp", null), false);
});

test("useBusyDelivery：启动不写存储，用户改动才落盘且幂等", async () => {
  const storage = new FakeStorage();
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });

  try {
    const { busyDelivery, setBusyDelivery } = useBusyDelivery();
    assert.equal(busyDelivery.value, "steer");
    assert.equal(storage.entries.size, 0, "启动时不能把默认值当用户偏好写进去");

    setBusyDelivery("followUp");
    await nextTick();
    assert.equal(storage.entries.get(BUSY_DELIVERY_STORAGE_KEY), "followUp");

    storage.entries.set(BUSY_DELIVERY_STORAGE_KEY, "sentinel");
    setBusyDelivery("followUp");
    await nextTick();
    assert.equal(
      storage.entries.get(BUSY_DELIVERY_STORAGE_KEY),
      "sentinel",
      "重复选同一项不产生写入",
    );
  } finally {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});
