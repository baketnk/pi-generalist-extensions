import { join } from "node:path";
import { atomicJson, jsonFile, VERSION, type Paths } from "./shared.ts";

type Event = "start" | "startup-failed" | "SIGTERM" | "SIGINT" | "idle-stop" | "stop-failed";
export interface DaemonEvent { at: number; pid: number; version: number; event: Event }
export async function daemonEvents(paths: Paths): Promise<DaemonEvent[]> {
  const value = await jsonFile<unknown>(join(paths.root, "daemon-events.json"), []);
  if (!Array.isArray(value)) return [];
  return value.filter(e => e && Number.isFinite(e.at) && Number.isInteger(e.pid) && Number.isInteger(e.version) &&
    ["start", "startup-failed", "SIGTERM", "SIGINT", "idle-stop", "stop-failed"].includes(e.event))
    .slice(-64).map(({ at, pid, version, event }) => ({ at, pid, version, event }));
}
/** Only the flock-owning daemon writes. No requests, bodies, credentials or exception text. */
export async function recordDaemonEvent(paths: Paths, event: Event): Promise<void> {
  try {
    const previous = await daemonEvents(paths);
    await atomicJson(join(paths.root, "daemon-events.json"), [...previous.slice(-63), { at: Date.now(), pid: process.pid, version: VERSION, event }]);
  } catch { /* Diagnostics must not determine service availability. */ }
}
