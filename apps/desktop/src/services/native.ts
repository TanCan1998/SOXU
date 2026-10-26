import { invoke } from "@tauri-apps/api/core";
export type RuntimeInfo = { appName: string; appVersion: string; platform: string };
export async function runtimeInfo(): Promise<RuntimeInfo> { return invoke<RuntimeInfo>("runtime_info"); }
