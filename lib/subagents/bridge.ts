import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BoardRuntime } from "../switchboard/runtime.ts";
import { atomicJson, jsonFile, secret, type Paths } from "../switchboard/shared.ts";

// Host-only callbacks on Pi's shared bus. Neither runtime/client objects nor tokens
// cross this bridge. Model tools cannot invoke these operations or supply file paths.
const BOARD = "generalist:subagents:board-host:v1", ACTIVE = "generalist:subagents:active:v1";
const QUIESCE = "generalist:subagents:quiesce:v1";
interface BoardHost {
  provision(id: string, file: string): Promise<{ participant: string; workerFile: string } | undefined>;
  retire(id: string): Promise<void>;
}
export interface WorkerBinding { token: string; paths: Paths; parent: string; runId: string }
export function registerBoardHost(pi: ExtensionAPI, get: () => BoardRuntime | undefined) {
  const host: BoardHost = {
    async provision(id, file) {
      const r = get(); if (!r || r.closed) return undefined;
      await r.start(); if (r.state === "off") return undefined;
      const client = r.requireClient();
      const saved = await jsonFile<WorkerBinding | undefined>(file, undefined);
      const binding: WorkerBinding = saved ?? { token: secret(), paths: r.options.paths, parent: r.card!.id, runId: id };
      if (binding.parent !== r.card!.id || binding.runId !== id) throw new Error("Worker capability belongs to a different parent/run.");
      if (!saved) await atomicJson(file, binding);
      // The capability exists on disk BEFORE the request. A lost response is recoverable.
      const child = await client.call<{ id: string }>("provision", { runId: id, capability: binding.token });
      return { participant: child.id, workerFile: file };
    },
    async retire(id) {
      const r = get(); if (!r || r.closed || r.state === "off") throw new Error("Switchboard unavailable for worker retirement; lease expiry is not retirement.");
      await r.requireClient().call("retire_worker", { runId: id });
    },
  };
  return pi.events.on(BOARD, request => (request as { accept: (host: BoardHost) => void }).accept(host));
}
export function registerActiveRuns(pi: ExtensionAPI, get: () => number, stop: () => Promise<void>) {
  const active = pi.events.on(ACTIVE, request => (request as { accept: (n: number) => void }).accept(get()));
  const quiesce = pi.events.on(QUIESCE, request => (request as { accept: (value: Promise<void>) => void }).accept(stop()));
  return () => { active(); quiesce(); };
}
export async function quiesceRuns(pi: ExtensionAPI) { let promise: Promise<void> | undefined; pi.events.emit(QUIESCE, { accept: (p: Promise<void>) => { promise = p; } }); await promise; }
export function activeRuns(pi: ExtensionAPI) { let active = 0; pi.events.emit(ACTIVE, { accept: (n: number) => { active = n; } }); return active; }
function board(pi: ExtensionAPI) { let host: BoardHost | undefined; pi.events.emit(BOARD, { accept: (value: BoardHost) => { host = value; } }); return host; }
export async function provisionWorker(pi: ExtensionAPI, id: string, file: string) { return board(pi)?.provision(id, file); }
export async function retireWorker(pi: ExtensionAPI, id: string) { const host = board(pi); if (!host) throw new Error("Switchboard host unavailable for retirement."); await host.retire(id); }
