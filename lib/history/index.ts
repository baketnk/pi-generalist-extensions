import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync, existsSync, lstatSync, statSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { allowedSource, discover } from "./config.ts";
import { parseJsonl, parseHermes, branchMessages } from "./sources.ts";
import { NOTICE, MAX_OUTPUT_BYTES, type HistoryConfig, type Session, type Source } from "./types.ts";

export function signature(path: string): string {
  return [path, path + "-wal"].map(p => {
    if (!existsSync(p)) return "missing";
    const s = statSync(p); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  }).join("|");
}
export function ftsQuery(query: string): string {
  const terms = [...query.matchAll(/"([^"]+)"|([^\s"]+)/g)].map(m => (m[1] || m[2]).trim()).filter(Boolean);
  if (!terms.length) throw new Error("Query has no searchable terms");
  return terms.map(t => `"${t.replaceAll('"', '""')}"`).join(" AND ");
}
export function bounded(value: Record<string, any>): string {
  // Always emit valid JSON, never cut a citation/UTF-8 sequence halfway through.
  const rows = value.results || value.messages;
  while (Buffer.byteLength(JSON.stringify(value)) > MAX_OUTPUT_BYTES && rows?.length) {
    rows.pop(); value.outputTruncated = true;
  }
  const output = JSON.stringify(value);
  if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) throw new Error("History metadata exceeds output bound; narrow request");
  return output;
}

export interface SearchOptions {
  query?: string; variants?: string[]; harness?: string; project?: string;
  after?: string; before?: string; role?: string; limit?: number;
}
export class HistoryIndex {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly config: HistoryConfig;
  constructor(config: HistoryConfig) {
    this.config = config;
    if (existsSync(config.indexDir) && lstatSync(config.indexDir).isSymbolicLink()) throw new Error("Index directory must not be a symlink");
    mkdirSync(config.indexDir, { recursive: true, mode: 0o700 }); chmodSync(config.indexDir, 0o700);
    this.path = join(config.indexDir, "history.sqlite");
    if (existsSync(this.path) && lstatSync(this.path).isSymbolicLink()) throw new Error("Index database must not be a symlink");
    this.db = new DatabaseSync(this.path);
    try {
    chmodSync(this.path, 0o600);
    const version = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version > 1) throw new Error("History index schema is newer than this extension");
    this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS sources(path TEXT PRIMARY KEY,harness TEXT NOT NULL,signature TEXT NOT NULL,indexed_at TEXT NOT NULL,warnings TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(key TEXT PRIMARY KEY,native_id TEXT NOT NULL,harness TEXT NOT NULL,path TEXT NOT NULL REFERENCES sources(path) ON DELETE CASCADE,cwd TEXT NOT NULL,title TEXT NOT NULL,time TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY,session_key TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
        entry_id TEXT NOT NULL,parent_id TEXT,seq INTEGER NOT NULL,part INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,time TEXT NOT NULL,locator TEXT NOT NULL,text TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chunks_session ON chunks(session_key);
      CREATE INDEX IF NOT EXISTS chunks_time ON chunks(time);
      CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(text,content='chunks',content_rowid='id',tokenize='unicode61');
      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN INSERT INTO history_fts(rowid,text) VALUES(new.id,new.text); END;
      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN INSERT INTO history_fts(history_fts,rowid,text) VALUES('delete',old.id,old.text); END;
      PRAGMA user_version=1;`);
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }

  async refresh(signal?: AbortSignal) {
    const start = performance.now();
    const { files, warnings } = discover(this.config.sources);
    let updated = 0, skipped = 0, failed = 0;
    for (const source of files) {
      signal?.throwIfAborted();
      try {
        if (!allowedSource(this.config, source.harness, source.path)) throw new Error("Source moved outside configured roots");
        const before = signature(source.path);
        const old = this.db.prepare("SELECT signature,harness FROM sources WHERE path=?").get(source.path) as any;
        if (old?.signature === before && old.harness === source.harness) { skipped++; continue; }
        const sessions = source.harness === "hermes" ? parseHermes(source) : await parseJsonl(source, false, signal);
        signal?.throwIfAborted();
        const after = signature(source.path);
        // Never publish a potentially mixed snapshot or mark it fresh. Retry on
        // the next request; another agent can keep writing while we search.
        if (after !== before) { warnings.push(`Changing source deferred: ${source.path}`); skipped++; continue; }
        this.replaceSource(source, before, sessions); updated++;
      } catch (error) {
        signal?.throwIfAborted(); failed++;
        warnings.push(`${source.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const paths = new Set(files.map(s => s.path));
    for (const row of this.db.prepare("SELECT path FROM sources").all() as any[])
      if (!paths.has(row.path)) this.db.prepare("DELETE FROM sources WHERE path=?").run(row.path);
    return { updated, skipped, failed, warnings: warnings.slice(0, 30), warningCount: warnings.length,
      milliseconds: Math.round(performance.now() - start), ...this.stats() };
  }
  private replaceSource(source: Source, stamp: string, sessions: Session[]) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM sources WHERE path=?").run(source.path);
      this.db.prepare("INSERT INTO sources VALUES(?,?,?,?,?)").run(source.path, source.harness, stamp, new Date().toISOString(),
        JSON.stringify(sessions.flatMap(s => s.warnings)));
      const addSession = this.db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,?)");
      const addChunk = this.db.prepare("INSERT INTO chunks(session_key,entry_id,parent_id,seq,part,role,kind,time,locator,text) VALUES(?,?,?,?,?,?,?,?,?,?)");
      for (const s of sessions) {
        addSession.run(s.key, s.nativeId, s.harness, s.path, s.cwd, s.title, s.time);
        for (const m of s.messages) {
          if (m.kind === "tool") continue;
          // Per-message chunks keep the tail of long sessions searchable. A little
          // overlap preserves phrase matches across chunk boundaries.
          for (let offset = 0, part = 0; offset < m.text.length; offset += 3840, part++) {
            addChunk.run(s.key, m.id, m.parent, m.seq, part, m.role, m.kind, m.time, m.locator, m.text.slice(offset, offset + 4000));
            if (offset + 4000 >= m.text.length) break;
          }
        }
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  stats() {
    const counts = this.db.prepare(`SELECT (SELECT count(*) FROM sources) sources,(SELECT count(*) FROM sessions) sessions,
      (SELECT count(*) FROM chunks) chunks,(SELECT coalesce(sum(length(CAST(text AS BLOB))),0) FROM chunks) textBytes`).get() as { sources: number; sessions: number; chunks: number; textBytes: number };
    return { ...counts, databaseBytes: statSync(this.path).size,
      walBytes: existsSync(this.path + "-wal") ? statSync(this.path + "-wal").size : 0 };
  }
  search(options: SearchOptions = {}) {
    const start = performance.now();
    options = { ...options };
    for (const key of ["after", "before"] as const) {
      if (!options[key]) continue;
      const date = new Date(options[key]!);
      if (!Number.isFinite(date.getTime())) throw new Error(`Invalid ${key} date`);
      options[key] = date.toISOString();
    }
    const queries = [options.query, ...(options.variants || [])].filter((s): s is string => !!s?.trim());
    if (queries.length > 4 || queries.some(q => q.length > 512)) throw new Error("At most four queries, each <=512 characters");
    const conditions: string[] = [], values: string[] = [];
    for (const [column, value, op] of [["s.harness", options.harness, "="], ["c.role", options.role, "="],
      ["c.time", options.after, ">="], ["c.time", options.before, "<="]] as const) {
      if (value) { conditions.push(`${column}${op}?`); values.push(value); }
    }
    if (options.project) { conditions.push("instr(lower(s.cwd),lower(?))>0"); values.push(options.project); }
    const match = queries.length ? queries.map(q => `(${ftsQuery(q)})`).join(" OR ") : "";
    if (match) conditions.unshift("history_fts MATCH ?");
    const sql = `SELECT s.key AS session,s.native_id AS nativeId,s.harness,s.path,s.cwd,s.title,
      c.entry_id AS entry,c.parent_id AS parent,c.seq,c.role,c.kind,c.time,c.locator,
      ${match ? "snippet(history_fts,0,'[',']',' … ',50)" : "substr(c.text,1,700)"} AS excerpt,
      src.indexed_at AS indexedAt,src.signature AS signature,src.warnings AS sourceWarnings
      FROM ${match ? "history_fts JOIN chunks c ON c.id=history_fts.rowid" : "chunks c"}
      JOIN sessions s ON s.key=c.session_key JOIN sources src ON src.path=s.path
      ${conditions.length ? "WHERE " + conditions.join(" AND ") : ""}
      ORDER BY c.time DESC,c.seq DESC${match ? ",bm25(history_fts)" : ""} LIMIT 200`;
    const rows = this.db.prepare(sql).all(...(match ? [match, ...values] : values)) as any[];
    const results: any[] = [], seen = new Set<string>();
    const limit = Math.max(1, Math.min(20, Math.trunc(options.limit || 10)));
    for (const row of rows) {
      const id = `${row.session}:${row.entry}`;
      if (seen.has(id) || !allowedSource(this.config, row.harness, row.path)) continue;
      seen.add(id);
      const { signature: stamp, ...result } = row;
      result.sourceChanged = signature(row.path) !== stamp;
      result.sourceWarnings = JSON.parse(row.sourceWarnings);
      results.push(result);
      if (results.length >= limit) break;
    }
    return { notice: NOTICE, results, candidateLimit: 200, milliseconds: +(performance.now() - start).toFixed(2) };
  }
  async read(sessionKey: string, options: { entry?: string; offset?: number; limit?: number; includeTools?: boolean } = {}, signal?: AbortSignal) {
    const row = this.db.prepare("SELECT s.*,src.signature,src.indexed_at FROM sessions s JOIN sources src ON src.path=s.path WHERE s.key=?").get(sessionKey) as any;
    if (!row || !allowedSource(this.config, row.harness, row.path)) throw new Error("Unknown or disallowed session; search first");
    const source: Source = { harness: row.harness, path: row.path };
    const before = signature(row.path);
    const sessions = source.harness === "hermes" ? parseHermes(source, options.includeTools, row.native_id) : await parseJsonl(source, options.includeTools, signal);
    const s = sessions.find(s => s.nativeId === row.native_id);
    if (!s) throw new Error("Session no longer exists in source; refresh index");
    let messages = branchMessages(s, options.entry);
    if (!s.tree && options.entry) {
      const end = messages.findIndex(m => m.id === options.entry);
      if (end < 0) throw new Error("Entry no longer exists; refresh search");
      messages = messages.slice(0, end + 1);
    }
    const offset = Math.max(0, Math.trunc(options.offset || 0)), limit = Math.max(1, Math.min(50, Math.trunc(options.limit || 12)));
    const end = Math.max(0, messages.length - offset), start = Math.max(0, end - limit);
    const selected = messages.slice(start, end).map(m => ({ ...m, text: m.text.slice(0, 6000), textTruncated: m.text.length > 6000 }));
    // Retain the newest entries (including the requested anchor) when the byte
    // budget, rather than the requested count, determines the page size.
    while (Buffer.byteLength(JSON.stringify(selected)) > 40_000 && selected.length > 1) selected.shift();
    return { notice: NOTICE, session: s.key, nativeId: s.nativeId, harness: s.harness, path: s.path, cwd: s.cwd,
      branch: s.tree ? `Ancestry ending at ${options.entry || 'latest recorded entry'}; not live branch status` : "Recorded linear history",
      offset, nextOffset: end - selected.length > 0 ? offset + selected.length : null,
      warnings: s.warnings, indexedAt: row.indexed_at, sourceChangedSinceIndex: before !== row.signature,
      sourceChangedDuringRead: signature(row.path) !== before, messages: selected };
  }
}
