import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { LIMITS } from "./types.ts";

export const RESOURCE_CEILINGS = { turns: 1000, tools: 4000 } as const;
export interface WorkerLimits { version: 1; turns: number; tools: number }
export const DEFAULT_WORKER_LIMITS: WorkerLimits = { version: 1, turns: LIMITS.turns, tools: LIMITS.tools };

export function validateWorkerLimits(value: unknown): WorkerLimits {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid subagent limits configuration.");
  const config = value as Record<string, unknown>;
  if (config.version !== 1 || Object.keys(config).some(key => !["version", "turns", "tools"].includes(key)) ||
      !Number.isSafeInteger(config.turns) || (config.turns as number) < 1 || (config.turns as number) > RESOURCE_CEILINGS.turns ||
      !Number.isSafeInteger(config.tools) || (config.tools as number) < 1 || (config.tools as number) > RESOURCE_CEILINGS.tools)
    throw new Error(`Subagent limits require version 1, turns 1–${RESOURCE_CEILINGS.turns}, and tools 1–${RESOURCE_CEILINGS.tools}.`);
  return { version: 1, turns: config.turns as number, tools: config.tools as number };
}

export function workerLimitsPath(agentDir: string) { return join(agentDir, "subagent-limits.json"); }
export function loadWorkerLimits(agentDir: string): WorkerLimits {
  const path = workerLimitsPath(agentDir);
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_WORKER_LIMITS };
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("Unsafe subagent limits configuration file.");
  return validateWorkerLimits(JSON.parse(readFileSync(path, "utf8")));
}
export function saveWorkerLimits(agentDir: string, value: WorkerLimits): void {
  const config = validateWorkerLimits(value), path = workerLimitsPath(agentDir);
  try { if (lstatSync(path).isSymbolicLink()) throw new Error("Subagent limits configuration must not be a symlink."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" }); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
}
