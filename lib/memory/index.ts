import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { canonical, decodeSnapshot, hash, id, scope, STORE_BYTES, type Revision, type Scope } from "./schema.ts";
import { boundedFile, checkRoot, withStoreLock } from "./store.ts";
import { INDEX_FILE, INDEX_TEMP, invalidateRecallIndex } from "./derived.ts";

const INDEX_BYTES = 64 * 1024 * 1024;
export interface Generation { storeId: string; stamp: string; hash: string }
export interface RecallItem {
  id: string; revision: number; scope: Scope; kind: Revision["kind"]; author: Revision["author"];
  title: string; body: string; date: string; recordHash: string; sourceHashes: string[];
  provenance: string; threadStatus?: Revision["threadStatus"]; reason: "human pin" | "lexical match";
}
export function storeStamp(root: string): string {
  checkRoot(root);
  const s = lstatSync(join(root, "store.json"), { bigint: true });
  if (!s.isFile() || s.isSymbolicLink() || s.size > BigInt(STORE_BYTES)) throw new Error("Unavailable canonical memory store");
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
}
const stopwords = new Set("a an and are as at be been but by can could do does for from had has have how i if in into is it its me my of on or our please should so that the their them then there these they this to until us was we were what when where which who will with would you your".split(" "));
export function queryTerms(query: string): string[] {
  const terms = query.slice(0, 4096).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(terms.filter(t => t.length <= 64 && !stopwords.has(t)))].slice(0, 16);
}
/** Explicit maintenance only. Atomic immutable cache; no WAL, timers, or provider calls. */
export function rebuildRecallIndex(root: string, expectedStoreId: string, signal?: AbortSignal) {
  id(expectedStoreId);
  return withStoreLock(root, () => {
    signal?.throwIfAborted();
    const start = performance.now(), stamp = storeStamp(root), bytes = boundedFile(join(root, "store.json"), STORE_BYTES);
    const snapshot = decodeSnapshot(bytes);
    if (snapshot.storeId !== expectedStoreId || storeStamp(root) !== stamp) throw new Error("Store identity changed; index not published");
    const generation: Generation = { storeId: snapshot.storeId, stamp, hash: hash(bytes.toString("utf8")) };
    const latest = new Map<string, Revision>();
    for (const r of snapshot.revisions) latest.set(r.id, r);
    invalidateRecallIndex(root);
    const temp = join(root, `${INDEX_TEMP}${randomUUID()}`), fd = openSync(temp, "wx", 0o600); closeSync(fd);
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(temp);
      db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA user_version=1;
        CREATE TABLE metadata(json TEXT NOT NULL);
        CREATE TABLE records(id TEXT UNIQUE NOT NULL, scope TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, date TEXT NOT NULL, json TEXT NOT NULL);
        CREATE INDEX scope_lookup ON records(scope);
        CREATE VIRTUAL TABLE search USING fts5(title,body,content='records',content_rowid='rowid',tokenize='unicode61');
        BEGIN IMMEDIATE;`);
      db.prepare("INSERT INTO metadata VALUES(?)").run(canonical(generation));
      const insert = db.prepare("INSERT INTO records VALUES(?,?,?,?,?,?)"), insertFts = db.prepare("INSERT INTO search(rowid,title,body) VALUES(?,?,?)");
      let count = 0;
      for (const r of latest.values()) {
        signal?.throwIfAborted();
        if (r.status !== "accepted" || r.scope === "unassigned" || r.kind === "artifact") continue;
        const date = r.legacy?.type === "raw" ? r.sources.find(s => s.precision === "day")?.timestamp ?? r.createdAt : r.createdAt;
        const item: RecallItem = { id: r.id, revision: r.revision, scope: r.scope, kind: r.kind, author: r.author,
          title: r.title, body: r.body, date, recordHash: hash(canonical(r)), sourceHashes: r.sources.map(s => s.sha256),
          provenance: r.legacy ? "Imported OptMem original; original author unknown; date has day precision" : "Authored note; source hashes check bytes, not truth or entailment",
          ...(r.threadStatus ? { threadStatus: r.threadStatus } : {}), reason: "lexical match" };
        const result = insert.run(r.id, r.scope, r.title, r.body, date, canonical(item));
        insertFts.run(result.lastInsertRowid, r.title, r.body); count++;
      }
      db.exec("COMMIT"); db.close(); db = undefined;
      if (lstatSync(temp).size > INDEX_BYTES) throw new Error("Recall index exceeds 64 MiB");
      signal?.throwIfAborted();
      if (storeStamp(root) !== stamp) throw new Error("Store changed while building index");
      const fd = openSync(temp, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, join(root, INDEX_FILE));
      return { ...generation, records: count, milliseconds: Math.round(performance.now() - start) };
    } finally {
      db?.close();
      for (const path of [temp, `${temp}-journal`]) {
        try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
  });
}
/** Short-lived, read-only prepared-index access. Never reads the canonical body or rebuilds. */
export class RecallIndex {
  private db: DatabaseSync;
  readonly generation: Generation;
  constructor(readonly root: string, expectedStoreId: string) {
    id(expectedStoreId); const stamp = storeStamp(root), path = join(root, INDEX_FILE), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > INDEX_BYTES) throw new Error("Unavailable recall index");
    this.db = new DatabaseSync(path, { readOnly: true });
    try {
      this.db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF;");
      if ((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version !== 1) throw new Error("Unsupported recall index");
      const row = this.db.prepare("SELECT json FROM metadata LIMIT 1").get() as { json?: string } | undefined;
      if (!row?.json || Buffer.byteLength(row.json) > 1024) throw new Error("Invalid recall generation");
      this.generation = JSON.parse(row.json);
      if (this.generation.storeId !== expectedStoreId || this.generation.stamp !== stamp || typeof this.generation.hash !== "string" || !/^[a-f0-9]{64}$/.test(this.generation.hash)) throw new Error("Stale recall index; run /memory reindex");
      this.assertFresh();
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  assertFresh() { if (storeStamp(this.root) !== this.generation.stamp) throw new Error("Recall generation changed; no stale memory supplied"); }
  search(query: string, scopes: Scope[], options: { pins?: string[]; automatic?: boolean; limit?: number; threads?: boolean } = {}) {
    const start = performance.now(), limit = options.limit ?? 10, pins = options.pins ?? [];
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20 || scopes.length > 3 || pins.length > 16 || Buffer.byteLength(query) > (options.automatic ? 16384 : 512)) throw new Error("Invalid recall bounds");
    scopes.forEach(scope); pins.forEach(id);
    if (scopes.includes("unassigned")) throw new Error("Unassigned memory is never recalled");
    this.assertFresh();
    if (!scopes.length) return { items: [] as RecallItem[], milliseconds: performance.now() - start };
    const scopeSql = scopes.map(() => "?").join(","), found = new Map<string, RecallItem>();
    const decode = (row: { json: string }, reason: RecallItem["reason"]) => {
      if (Buffer.byteLength(row.json) > 16384) throw new Error("Oversized recall record");
      const item = JSON.parse(row.json) as RecallItem;
      // Cache is disposable local data, never permission to widen scopes.
      id(item.id); if (!scopes.includes(item.scope) || item.scope === "unassigned" || item.kind === "artifact" || !Number.isSafeInteger(item.revision) || item.revision < 1 || typeof item.body !== "string" || Buffer.byteLength(item.body) > 8192) throw new Error("Invalid indexed memory");
      found.set(item.id, { ...item, reason });
    };
    if (pins.length && !options.threads) {
      const rows = this.db.prepare(`SELECT json FROM records WHERE scope IN (${scopeSql}) AND id IN (${pins.map(() => "?").join(",")}) ORDER BY id LIMIT 16`).all(...scopes, ...pins) as { json: string }[];
      rows.forEach(r => decode(r, "human pin"));
    }
    const terms = queryTerms(query);
    if (options.threads) {
      const rows = this.db.prepare(`SELECT json FROM records WHERE scope IN (${scopeSql}) AND json_extract(json,'$.kind')='thread' AND json_extract(json,'$.threadStatus')='open' ORDER BY date DESC,id LIMIT ?`).all(...scopes, limit) as { json: string }[];
      rows.forEach(r => decode(r, "lexical match"));
    } else if (terms.length) {
      const match = terms.map(t => `"${t}"`).join(options.automatic ? " OR " : " AND ");
      // Score only matching rows inside the approved scopes; no global-corpus BM25.
      const score = terms.map(() => "(instr(lower(records.title),?)>0)+(instr(lower(records.body),?)>0)").join("+");
      const rows = this.db.prepare(`SELECT records.json FROM records JOIN search ON records.rowid=search.rowid WHERE records.scope IN (${scopeSql}) AND search MATCH ? ORDER BY (${score}) DESC, records.date DESC, records.id LIMIT ?`).all(...scopes, match, ...terms.flatMap(t => [t, t]), limit) as { json: string }[];
      rows.forEach(r => { const item = JSON.parse(r.json); if (!found.has(item.id)) decode(r, "lexical match"); });
    }
    this.assertFresh();
    return { items: [...found.values()], milliseconds: Math.round((performance.now() - start) * 100) / 100 };
  }
}
