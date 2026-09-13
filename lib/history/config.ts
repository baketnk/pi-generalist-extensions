import { homedir } from "node:os";
import { join, isAbsolute, resolve, relative, sep } from "node:path";
import { readFileSync, existsSync, realpathSync, readdirSync } from "node:fs";
import type { HistoryConfig, Source } from "./types.ts";

export function configPath(): string {
  return process.env.PI_HISTORY_CONFIG || join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent"), "history-search.json");
}
export function loadConfig(path = configPath()): HistoryConfig {
  const home = homedir();
  const defaults: HistoryConfig = { version: 1,
    indexDir: join(process.env.PI_CODING_AGENT_DIR || join(home, ".pi/agent"), "history-search"),
    sources: [
      { harness: "pi", path: join(process.env.PI_CODING_AGENT_DIR || join(home, ".pi/agent"), "sessions") },
      { harness: "omp", path: join(home, ".omp/agent/sessions") },
      { harness: "codex", path: join(home, ".codex/sessions") },
      { harness: "codex", path: join(home, ".codex/archived_sessions") },
      { harness: "hermes", path: join(home, ".hermes/state.db") },
    ],
  };
  if (!existsSync(path)) return defaults;
  const text = readFileSync(path, "utf8");
  if (Buffer.byteLength(text) > 65536) throw new Error("History config exceeds 64 KiB");
  const value = JSON.parse(text);
  if (value.version !== 1 || !Array.isArray(value.sources) || value.sources.length > 32 ||
      typeof value.indexDir !== "string" || !isAbsolute(value.indexDir)) throw new Error("Invalid history configuration");
  for (const source of value.sources) {
    if (!["pi", "omp", "codex", "hermes"].includes(source.harness) ||
        typeof source.path !== "string" || !isAbsolute(source.path)) throw new Error("History sources require known harnesses and absolute paths");
  }
  return value;
}

/** No symlink traversal. Explicit source roots themselves may be symlink aliases. */
export function discover(sources: Source[]): { files: Source[]; warnings: string[] } {
  const files: Source[] = [], warnings: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (!existsSync(source.path)) { warnings.push(`Missing source: ${source.path}`); continue; }
    const root = realpathSync(source.path);
    const add = (path: string) => {
      if (seen.has(path)) return;
      seen.add(path); files.push({ harness: source.harness, path });
    };
    if (source.harness === "hermes") { add(root); continue; }
    const visit = (dir: string) => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); }
      catch { warnings.push(`Unreadable directory: ${dir}`); return; }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) add(path);
      }
    };
    visit(root);
  }
  return { files, warnings };
}
export function allowedSource(config: HistoryConfig, harness: string, path: string): boolean {
  if (!existsSync(path)) return false;
  const target = realpathSync(path);
  return config.sources.some(source => {
    if (source.harness !== harness || !existsSync(source.path)) return false;
    const root = realpathSync(source.path);
    const rel = relative(root, target);
    return harness === "hermes" ? target === root : !!rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep) && resolve(path) === target;
  });
}
