import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export interface AutocompleteConfig {
  version: 2; enabled: boolean; modelEnabled: boolean; model: string | null;
  scope: "all" | "project"; conversation: boolean; repository: boolean;
}
export const defaults: AutocompleteConfig = {
  version: 2, enabled: false, modelEnabled: true, model: null,
  scope: "all", conversation: true, repository: false,
};
export function modelParts(value: string): { provider: string; id: string } {
  const slash = value.indexOf("/");
  if (value.length > 256 || slash < 1 || slash === value.length - 1 || /[\s\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(value))
    throw new Error("Use an exact Pi provider/model ID, e.g. local/llama3.2:3b");
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}
export function configPath() {
  return process.env.PI_AUTOCOMPLETE_CONFIG || join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent"), "autocomplete.json");
}
export function validateConfig(value: unknown): AutocompleteConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid autocomplete configuration");
  const original = value as Record<string, unknown>;
  // Preserve history activation, but never guess a provider from a legacy Ollama model name.
  const legacy = original.version === 1;
  const c = { ...defaults, ...original, ...(legacy ? { version: 2, model: null } : {}) };
  if (c.version !== 2 || [c.enabled, c.modelEnabled, c.conversation, c.repository].some(v => typeof v !== "boolean") ||
      !["all", "project"].includes(c.scope) || (c.model !== null && typeof c.model !== "string"))
    throw new Error("Invalid autocomplete configuration");
  if (c.model !== null) modelParts(c.model);
  return { version: 2, enabled: c.enabled, modelEnabled: c.modelEnabled, model: c.model,
    scope: c.scope, conversation: c.conversation, repository: c.repository };
}
export function loadAutocompleteConfig(path = configPath()): AutocompleteConfig {
  if (!existsSync(path)) return { ...defaults };
  if (lstatSync(path).isSymbolicLink() || lstatSync(path).size > 16_384) throw new Error("Unsafe autocomplete config file");
  return validateConfig(JSON.parse(readFileSync(path, "utf8")));
}
export function saveAutocompleteConfig(config: AutocompleteConfig, path = configPath()) {
  const value = validateConfig(config);
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Autocomplete config must not be a symlink");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}
