export type SessionId = string;
export type RuntimeId = string;
export interface RuntimeIdentity { sessionId: SessionId; runtimeId: RuntimeId; generation: number }
export type AgentLifecycle = "starting" | "idle" | "running" | "stopping" | "exited";
