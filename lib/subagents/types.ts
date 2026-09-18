import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";

export const PROTOCOL = 1;
export type WorkerPermissions = "read-only" | "implement";
/** Missing permissions on old intents/records always means read-only. */
export function workerPermissions(value: unknown): WorkerPermissions {
  if (value === undefined) return "read-only";
  if (value === "read-only" || value === "implement") return value;
  throw new Error("Invalid worker permissions; choose read-only or implement.");
}
export const LIMITS = { active: 4, activeMax: 16, seconds: 600, secondsMax: 1800, turns: 24, tools: 80,
  outputTokens: 4096, taskBytes: 32768, snapshotBytes: 2 * 1024 * 1024, logBytes: 8 * 1024 * 1024,
  reportBytes: 8192, pageBytes: 16384, runs: 128 } as const;
export interface ContextSnapshotEvent {
  type: "context_snapshot"; messages: AgentMessage[]; leafId: string | null;
  contextErrors: number; providerRequestHooks: boolean;
}
export interface ForkSnapshot {
  version: 1; session: string; anchor: string; timestamp: number; digest: string;
  messages: AgentMessage[]; protectedKinds: string[]; providerRequestHooks: boolean;
}
export interface WorkerReport {
  outcome: "completed" | "partial" | "blocked" | "inconclusive";
  summary: string; findings?: string; verification?: string; uncertainties?: string;
}
export interface Launch {
  permissions?: WorkerPermissions;
  version: 1; id: string; operation: string; owner: string; cwd: string; label: string; task: string;
  mode: "fresh" | "fork"; model: { provider: string; id: string }; thinking: ThinkingLevel;
  seconds: number; maxTurns: number; maxTools: number; maxOutputTokens: number;
  instructions: { path: string; content: string }[]; snapshot?: ForkSnapshot;
  privatePaths?: string[];
  agentDir: string; workerFile?: string;
}
export type TaskState = "starting" | "running" | "needs-input" | "reported" | "incomplete" | "failed" | "cancelled" | "timed-out" | "budget-exceeded" | "interrupted";
export interface RunRecord {
  permissions?: WorkerPermissions;
  version: 1; id: string; operation: string; owner: string; label: string; taskSummary?: string; cwd: string;
  mode: "fresh" | "fork"; source?: { session: string; anchor: string; digest: string };
  model: Launch["model"]; thinking: ThinkingLevel; createdAt: number; updatedAt: number;
  taskState: TaskState; process: "starting" | "live" | "exited" | "unknown"; cleanup: "pending" | "observed" | "unknown";
  pid?: number; exitCode?: number | null; signal?: string | null; reason?: string;
  sessionFile?: string; report?: WorkerReport; question?: { id: string; text: string };
  turns: number; tools: number; usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  collectedAt?: number; participant?: string; persistenceError?: string;
  coordinationError?: string;
}
export interface WorkerEvent { seq: number; at: number; kind: string; text?: string; toolId?: string; tool?: string; data?: unknown }
export type WorkerPacket =
  | { version: 1; type: "ready"; sessionFile: string }
  | { version: 1; type: "event"; event: WorkerEvent }
  | { version: 1; type: "needs-input"; id: string; text: string }
  | { version: 1; type: "terminal"; state: TaskState; reason?: string; report?: WorkerReport };
export type ParentPacket = { version: 1; type: "input"; id: string; text: string } | { version: 1; type: "cancel" };
