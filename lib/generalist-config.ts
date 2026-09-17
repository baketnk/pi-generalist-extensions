import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type BackgroundModel = { provider: string; model: string };

export function validBackgroundModel(value: unknown): value is BackgroundModel {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return [v.provider, v.model].every(x => typeof x === "string" && x.length > 0 && x.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(x))
    && Object.keys(v).length === 2;
}

export type GeneralistDefaults = {
  version: 1;
  meitan: boolean;
  memory?: boolean;
  output: boolean;
  patch?: boolean;
  icons?: boolean;
  backgroundModel?: BackgroundModel | null;
};

export const generalistConfigPath = (agentDir = getAgentDir()) => join(agentDir, "extensions", "generalist-settings.json");

function valid(value: unknown): value is GeneralistDefaults {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.version === 1 && typeof v.meitan === "boolean" && typeof v.output === "boolean"
    && (v.memory === undefined || typeof v.memory === "boolean")
    && (v.patch === undefined || typeof v.patch === "boolean") && (v.icons === undefined || typeof v.icons === "boolean")
    && (v.backgroundModel === undefined || v.backgroundModel === null || validBackgroundModel(v.backgroundModel))
    && Object.keys(v).every(key => ["version", "meitan", "memory", "output", "patch", "icons", "backgroundModel"].includes(key));
}

/** Global defaults explicitly saved from the Generalist TUI; branch entries still take precedence. */
export function loadGeneralistDefaults(path = generalistConfigPath()): GeneralistDefaults | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return valid(value) ? value : undefined;
  } catch { return undefined; }
}

/** Atomic synchronous write gives Ctrl+S a durability boundary, like Pi's saved model defaults. */
export function saveGeneralistDefaults(defaults: GeneralistDefaults, path = generalistConfigPath()): void {
  if (!valid(defaults)) throw new Error("Invalid Generalist defaults");
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(defaults, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}
