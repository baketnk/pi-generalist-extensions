import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export interface ModelRef { provider: string; id: string }
export interface ModelConfig { version: 1; ladder: string[] }
export function modelRef(value: string): ModelRef {
  const slash = value.indexOf("/");
  if (value.length > 256 || slash < 1 || slash === value.length - 1 || /[\s\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(value))
    throw new Error("Worker model must be self, next-smaller, or an exact provider/model ID.");
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}
export function modelKey(model: ModelRef) { return `${model.provider}/${model.id}`; }
export function validateModelConfig(value: unknown): ModelConfig {
  const c = value as ModelConfig;
  if (!c || Object.keys(c).some(key => !["version", "ladder"].includes(key)) || c.version !== 1 || !Array.isArray(c.ladder) || c.ladder.length < 2 || c.ladder.length > 32 ||
      c.ladder.some(v => typeof v !== "string") || new Set(c.ladder).size !== c.ladder.length)
    throw new Error("Subagent model ladder requires version 1 and 2–32 distinct exact provider/model IDs.");
  c.ladder.forEach(modelRef);
  return { version: 1, ladder: [...c.ladder] };
}
export function modelConfigPath(agentDir: string) {
  return process.env.PI_SUBAGENTS_CONFIG || join(agentDir, "subagent-models.json");
}
export function loadModelConfig(agentDir: string): ModelConfig | undefined {
  const path = modelConfigPath(agentDir);
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw new Error("Unsafe subagent model configuration file.");
  return validateModelConfig(JSON.parse(readFileSync(path, "utf8")));
}
export function saveModelConfig(agentDir: string, value: ModelConfig) {
  const config = validateModelConfig(value), path = modelConfigPath(agentDir);
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Subagent model configuration must not be a symlink.");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" }); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
}

/** Resolve once to a concrete model before launch. Config is read only for next-smaller. */
export function resolveWorkerModel(selection: string | undefined, parent: ModelRef | undefined, readConfig: () => ModelConfig | undefined): ModelRef {
  if (selection && !["self", "same", "next-smaller"].includes(selection)) return modelRef(selection);
  if (!parent) throw new Error("Parent has no model; specify an exact worker provider/model (no fallback).");
  if (selection !== "next-smaller") return { provider: parent.provider, id: parent.id };
  const config = readConfig();
  if (!config) throw new Error("No subagent model ladder configured. Use /subagents ladder provider/model ... or choose self/explicit model.");
  const ladder = validateModelConfig(config).ladder, index = ladder.indexOf(modelKey(parent));
  if (index < 0) throw new Error("Parent model is not in the configured subagent ladder; no next-smaller fallback.");
  if (index === ladder.length - 1) throw new Error("Parent is already the smallest model in the configured ladder; choose self explicitly.");
  return modelRef(ladder[index + 1]!);
}
