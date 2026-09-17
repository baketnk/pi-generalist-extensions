import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export interface AutocompleteConfig {
  version: 1; enabled: boolean; modelEnabled: boolean; model: string; endpoint: string;
  cpuOnly: boolean; scope: "all" | "project";
}
export const defaults: AutocompleteConfig = {
  version: 1, enabled: false, modelEnabled: true, model: "llama3.2:3b",
  endpoint: "http://127.0.0.1:11434", cpuOnly: false, scope: "all",
};
export function configPath() {
  return process.env.PI_AUTOCOMPLETE_CONFIG || join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent"), "autocomplete.json");
}
export function validateConfig(value: unknown): AutocompleteConfig {
  const c = { ...defaults, ...(value as object) };
  if (c.version !== 1 || [c.enabled, c.modelEnabled, c.cpuOnly].some(v => typeof v !== "boolean") ||
      !["all", "project"].includes(c.scope) || typeof c.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/.test(c.model))
    throw new Error("Invalid autocomplete configuration");
  const url = new URL(c.endpoint);
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("Autocomplete requires a loopback Ollama origin (no credentials, path, or redirects)");
  return { version: 1, enabled: c.enabled, modelEnabled: c.modelEnabled, model: c.model,
    endpoint: url.origin, cpuOnly: c.cpuOnly, scope: c.scope };
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
