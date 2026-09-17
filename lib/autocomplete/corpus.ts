import { DatabaseSync } from "node:sqlite";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { allowedSource } from "../history/config.ts";
import type { HistoryConfig } from "../history/types.ts";
import { MAX_CORPUS_CHARS, MAX_SAMPLES, usablePrompt, type PromptSample } from "./predictor.ts";

/** Index-only read. Never discovers, refreshes, parses, creates, or modifies history sources. */
export function readCorpus(config: HistoryConfig, cwd: string, scope: "all" | "project"): PromptSample[] {
  const path = join(config.indexDir, "history.sqlite");
  if (!existsSync(path)) return [];
  if (lstatSync(config.indexDir).isSymbolicLink() || lstatSync(path).isSymbolicLink()) throw new Error("History index must not be a symlink");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=100;");
    const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version !== 1) throw new Error("Unsupported history index schema; refresh with /history-index");
    // Only complete, short first chunks; never learn overlapping middle chunks or summaries.
    const rows = db.prepare(`SELECT c.text,s.cwd,s.path,s.harness FROM chunks c
      JOIN sessions s ON s.key=c.session_key
      WHERE c.role='user' AND c.kind='prose' AND c.part=0 AND length(c.text) BETWEEN 3 AND 2000
      ${scope === "project" ? "AND s.cwd=?" : ""}
      ORDER BY c.time DESC,c.seq DESC,c.id DESC LIMIT 6000`).all(...(scope === "project" ? [cwd] : [])) as unknown as Array<PromptSample & { path: string; harness: string }>;
    const result: PromptSample[] = [], seen = new Set<string>(), permissions = new Map<string, boolean>();
    let chars = 0;
    for (const row of rows) {
      const key = `${row.harness}\0${row.path}`;
      if (!permissions.has(key)) permissions.set(key, allowedSource(config, row.harness, row.path));
      if (!permissions.get(key) || seen.has(row.text) || !usablePrompt(row.text)) continue;
      if (result.length >= MAX_SAMPLES || chars + row.text.length > MAX_CORPUS_CHARS) break;
      result.push({ text: row.text, cwd: row.cwd }); seen.add(row.text); chars += row.text.length;
    }
    return result;
  } finally { db.close(); }
}
