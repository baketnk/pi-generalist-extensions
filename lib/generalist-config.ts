import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type GeneralistDefaults = {
  version: 1;
  meitan: boolean;
  output: boolean;
  patch?: boolean;
  icons?: boolean;
};

export const generalistConfigPath = (agentDir = getAgentDir()) => join(agentDir, "extensions", "generalist-settings.json");

function valid(value: unknown): value is GeneralistDefaults {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.version === 1 && typeof v.meitan === "boolean" && typeof v.output === "boolean"
    && (v.patch === undefined || typeof v.patch === "boolean") && (v.icons === undefined || typeof v.icons === "boolean")
    && Object.keys(v).every(key => ["version", "meitan", "output", "patch", "icons"].includes(key));
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
