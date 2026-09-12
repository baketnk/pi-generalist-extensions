import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
export interface ModelPreset {
  provider: string;
  model: string;
  thinking: ThinkingLevel;
}
const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const HISTORY_LIMIT = 8;
export const presetKey = (p: ModelPreset) => JSON.stringify([p.provider, p.model, p.thinking]);
export const presetLabel = (p: ModelPreset) => `${p.provider}/${p.model} · ${p.thinking}`;

function isPreset(value: unknown): value is ModelPreset {
  if (!value || typeof value !== "object") return false;
  const p = value as ModelPreset;
  return typeof p.provider === "string" && !!p.provider &&
    typeof p.model === "string" && !!p.model && levels.has(p.thinking);
}

export function readHistory(path: string): ModelPreset[] {
  let data: unknown;
  try { data = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (!Array.isArray(data) || !data.every(isPreset)) throw new Error("Invalid model history");
  const seen = new Set<string>();
  return data.filter(p => {
    const key = presetKey(p);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, HISTORY_LIMIT);
}

/** Best-effort preferences only; atomic replacement prevents partial JSON reads. */
export function rememberPreset(path: string, preset: ModelPreset) {
  const history = readHistory(path);
  const next = [preset, ...history.filter(p => presetKey(p) !== presetKey(preset))].slice(0, HISTORY_LIMIT);
  if (JSON.stringify(next) === JSON.stringify(history)) return;
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}
