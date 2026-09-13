import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { canonical, hash, id, scope, type Scope } from "./schema.ts";
import { boundedFile, checkRoot } from "./store.ts";

export interface HousekeepingConfig {
  enabled: boolean; provider: string; model: string;
}
export function validateHousekeeping(value: unknown): asserts value is HousekeepingConfig {
  keys(value, ["enabled", "provider", "model"]);
  if (typeof value.enabled !== "boolean" || [value.provider, value.model].some(v =>
    typeof v !== "string" || !v.trim() || v.length > 200 || /[\s\x00-\x1f]/.test(v))) throw new Error("Invalid housekeeping model selection");
}
export interface MemoryConfig {
  version: 1; storeRoot: string; storeId: string;
  projects: Array<{ id: string; paths: string[] }>;
  personalIds: string[]; pins: Array<{ id: string; scope: Scope }>;
  housekeeping?: HousekeepingConfig;
  defaultPersonalId?: string;
  preferMeitanMemory?: boolean;
}
function keys(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new Error("Invalid native memory configuration");
}
export function validateConfig(value: unknown): asserts value is MemoryConfig {
  keys(value, ["version", "storeRoot", "storeId", "projects", "personalIds", "pins", "housekeeping", "defaultPersonalId", "preferMeitanMemory"]);
  if (value.preferMeitanMemory !== undefined && typeof value.preferMeitanMemory !== "boolean") throw new Error("Invalid Meitan/memory preference");
  if (value.housekeeping !== undefined) validateHousekeeping(value.housekeeping);
  if (value.version !== 1 || typeof value.storeRoot !== "string" || !isAbsolute(value.storeRoot) || value.storeRoot.length > 4096) throw new Error("Explicit absolute native store root required");
  id(value.storeId);
  if (!Array.isArray(value.projects) || value.projects.length > 32 || !Array.isArray(value.personalIds) || value.personalIds.length > 8 || !Array.isArray(value.pins) || value.pins.length > 16) throw new Error("Native memory configuration exceeds bounds");
  const paths = new Set<string>(), projects = new Set<string>();
  for (const project of value.projects) {
    keys(project, ["id", "paths"]); id(project.id);
    if (projects.has(project.id) || !Array.isArray(project.paths) || !project.paths.length || project.paths.length > 16) throw new Error("Invalid project aliases");
    projects.add(project.id);
    for (const path of project.paths) {
      if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096 || paths.has(path)) throw new Error("Ambiguous or invalid project alias");
      paths.add(path);
    }
  }
  const personal = new Set();
  for (const profile of value.personalIds) { id(profile); if (personal.has(profile)) throw new Error("Duplicate personal profile"); personal.add(profile); }
  if (value.defaultPersonalId !== undefined) {
    id(value.defaultPersonalId);
    if (!personal.has(value.defaultPersonalId)) throw new Error("Default personal profile is not configured");
  }
  const pins = new Set();
  for (const pin of value.pins) {
    keys(pin, ["id", "scope"]); id(pin.id); scope(pin.scope);
    if (pin.scope === "unassigned" || pins.has(pin.id)) throw new Error("Invalid pinned memory"); pins.add(pin.id);
    if (pin.scope.startsWith("project:") ? !projects.has(pin.scope.slice(8)) : !personal.has(pin.scope.slice(9))) throw new Error("Pin scope is not configured");
  }
  if (Buffer.byteLength(canonical(value)) > 32768) throw new Error("Memory configuration exceeds 32 KiB");
}
export function readMemoryConfig(path: string): { value?: MemoryConfig; digest: string } {
  if (!isAbsolute(path)) throw new Error("Absolute memory configuration path required");
  checkRoot(dirname(path));
  try {
    const bytes = boundedFile(path, 32768), value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    validateConfig(value); return { value, digest: hash(bytes.toString("utf8")) };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { digest: "missing" }; throw error; }
}
export function saveMemoryConfig(path: string, value: MemoryConfig, expectedDigest: string): string {
  validateConfig(value); checkRoot(dirname(path));
  const lock = `${path}.lock`, temp = `${path}.pending-${randomUUID()}`;
  mkdirSync(lock, { mode: 0o700 });
  try {
    if (readMemoryConfig(path).digest !== expectedDigest) throw new Error("Memory configuration changed; review again");
    const text = canonical(value), fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
    const directory = openSync(dirname(path), "r"); try { fsyncSync(directory); } finally { closeSync(directory); }
    return hash(text);
  } finally {
    try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    rmdirSync(lock);
  }
}
export function projectFor(config: MemoryConfig, cwd: string): string | undefined {
  const canonical = realpathSync(cwd);
  return config.projects.find(p => p.paths.includes(canonical))?.id;
}
