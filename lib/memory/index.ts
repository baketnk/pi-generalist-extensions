import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { canonical, decodeSnapshot, hash, id, scope, STORE_BYTES, MAX_REVISIONS, type Revision, type Scope } from "./schema.ts";
import { queryTerms, followupTerms, isTopicTerm } from "./query.ts";
import { boundedFile, checkRoot, withStoreLock } from "./store.ts";
import { INDEX_FILE, INDEX_TEMP, invalidateRecallIndex } from "./derived.ts";
export { queryTerms } from "./query.ts";

const INDEX_BYTES = 64 * 1024 * 1024;
export interface Generation { storeId: string; stamp: string; hash: string }
export interface RecallItem {
  id: string; revision: number; scope: Scope; kind: Revision["kind"]; author: Revision["author"];
  title: string; body: string; date: string; recordHash: string; sourceHashes: string[];
  provenance: string; claim?: Revision["claim"]; capture?: Revision["capture"]; threadStatus?: Revision["threadStatus"]; reason: "human pin" | "lexical match";
}
export function storeStamp(root: string): string {
  checkRoot(root);
  const s = lstatSync(join(root, "store.json"), { bigint: true });
  if (!s.isFile() || s.isSymbolicLink() || s.size > BigInt(STORE_BYTES)) throw new Error("Unavailable canonical memory store");
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
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
      db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA user_version=2;
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
          ...(r.claim ? { claim: r.claim } : {}), ...(r.capture ? { capture: r.capture } : {}),
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
  readonly root: string;
  constructor(root: string, expectedStoreId: string) {
    this.root = root;
    id(expectedStoreId); const stamp = storeStamp(root), path = join(root, INDEX_FILE), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > INDEX_BYTES) throw new Error("Unavailable recall index");
    this.db = new DatabaseSync(path, { readOnly: true });
    try {
      this.db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF;");
      if ((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version !== 2) throw new Error("Unsupported recall index");
      const row = this.db.prepare("SELECT json FROM metadata LIMIT 1").get() as { json?: string } | undefined;
      if (!row?.json || Buffer.byteLength(row.json) > 1024) throw new Error("Invalid recall generation");
      this.generation = JSON.parse(row.json);
      if (this.generation.storeId !== expectedStoreId || this.generation.stamp !== stamp || typeof this.generation.hash !== "string" || !/^[a-f0-9]{64}$/.test(this.generation.hash)) throw new Error("Stale recall index; run /memory reindex");
      this.assertFresh();
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  assertFresh() { if (storeStamp(this.root) !== this.generation.stamp) throw new Error("Recall generation changed; no stale memory supplied"); }
  /** Read scoped FTS postings, not all note bodies. Rarity never depends on an
   * unapproved corpus. All token evidence (including title boosts) comes from FTS,
   * not JS substring matching. No schema migration or prompt-time index rebuild.
   */
  private ranked(query: string, selectedScope: Scope, automatic: boolean, limit: number, previousPrompt?: string) {
    const primary = queryTerms(query, automatic), topic = automatic ? followupTerms(query, previousPrompt) : [];
    if (!primary.length || (automatic && !primary.some(isTopicTerm))) return [];
    const count = (this.db.prepare("SELECT count(*) AS n FROM records WHERE scope=?").get(selectedScope) as { n: number }).n;
    if (count > MAX_REVISIONS) throw new Error("Recall index record quota exceeded");
    if (!count) return [];
    const postings = this.db.prepare(`SELECT records.rowid FROM records JOIN search ON records.rowid=search.rowid
      WHERE records.scope=? AND search MATCH ? LIMIT ?`);
    type Evidence = { rowid: number; hits: number; anchors: number; weight: number; title: number; topicHits: number; topicWeight: number };
    const candidates = new Map<number, Evidence>();
    let totalWeight = 0;
    for (const [i, term] of [...primary, ...topic].entries()) {
      const match = `"${term}"`, isTopic = i >= primary.length;
      const rows = postings.all(selectedScope, match, MAX_REVISIONS + 1) as { rowid: number }[];
      if (rows.length > MAX_REVISIONS) throw new Error("Recall postings quota exceeded");
      // Missing terms still contribute to coverage: one accidental known word in
      // an otherwise unsupported query must not become a perfect match.
      const weight = rows.length ? 1 + Math.log(1 + (count - rows.length + 0.5) / (rows.length + 0.5)) : 1;
      if (!isTopic) totalWeight += weight;
      const titles = new Set(isTopic ? [] : (postings.all(selectedScope, `title : ${match}`, MAX_REVISIONS + 1) as { rowid: number }[]).map(r => r.rowid));
      for (const { rowid } of rows) {
        const evidence = candidates.get(rowid) ?? { rowid, hits: 0, anchors: 0, weight: 0, title: 0, topicHits: 0, topicWeight: 0 };
        if (isTopic) { evidence.topicHits++; evidence.topicWeight += weight; }
        else {
          evidence.hits++; evidence.weight += weight;
          if (isTopicTerm(term)) evidence.anchors++;
          if (titles.has(rowid)) evidence.title += weight * 0.2;
        }
        candidates.set(rowid, evidence);
      }
    }
    const ranked = [...candidates.values()].map(e => {
      const coverage = e.weight / totalWeight;
      const direct = e.anchors > 0 && e.hits >= Math.min(2, primary.length) && coverage >= 0.35;
      const supported = e.hits >= 1 && e.topicHits >= 2 && coverage >= 0.2;
      return { ...e, direct, eligible: automatic ? direct || supported : e.hits === primary.length,
        score: (e.weight + e.title) * coverage + Math.min(e.weight * 0.25, e.topicWeight * 0.15) };
    }).filter(e => e.eligible);
    // Fetch whole bodies only for the bounded finalists. Equal scores retain the
    // established date/ID tie-break, without a globally capped candidate shortlist.
    ranked.sort((a, b) => Number(b.direct) - Number(a.direct) || b.score - a.score);
    const cutoff = ranked[Math.min(limit, ranked.length) - 1]?.score;
    const finalists = ranked.filter((e, i) => i < limit || e.score === cutoff);
    if (!finalists.length) return [];
    // A tied corpus may contain thousands of rows. Let SQLite apply the final
    // date/ID tie-break and return at most limit JSON bodies.
    const groups = new Map<string, number[]>();
    for (const e of finalists) {
      const key = `${Number(e.direct)}:${e.score}`, group = groups.get(key) ?? [];
      group.push(e.rowid); groups.set(key, group);
    }
    const result: { json: string }[] = [];
    for (const group of groups.values()) {
      if (result.length >= limit) break;
      // json_each avoids SQLite's variable-count limit for large tied groups.
      result.push(...this.db.prepare(`SELECT json FROM records WHERE scope=? AND rowid IN (SELECT value FROM json_each(?))
        ORDER BY date DESC,id LIMIT ?`).all(selectedScope, JSON.stringify(group), limit - result.length) as { json: string }[]);
    }
    return result;
  }
  search(query: string, scopes: Scope[], options: { pins?: string[]; automatic?: boolean; limit?: number; threads?: boolean; previousPrompt?: string } = {}) {
    const start = performance.now(), limit = options.limit ?? (options.automatic ? 3 : 10), pins = options.pins ?? [];
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20 || scopes.length > 3 || pins.length > 16 || Buffer.byteLength(query) > (options.automatic ? 16384 : 512) ||
        (options.previousPrompt !== undefined && Buffer.byteLength(options.previousPrompt) > 4096)) throw new Error("Invalid recall bounds");
    scopes.forEach(scope); pins.forEach(id); scopes = [...new Set(scopes)];
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
    const matched: { json: string }[] = [];
    if (options.threads) {
      for (const selectedScope of scopes) {
        matched.push(...this.db.prepare(`SELECT json FROM records WHERE scope=? AND json_extract(json,'$.kind')='thread' AND json_extract(json,'$.threadStatus')='open' ORDER BY date DESC,id LIMIT ?`).all(selectedScope, limit) as { json: string }[]);
      }
    } else {
      for (const selectedScope of scopes) matched.push(...this.ranked(query, selectedScope, options.automatic ?? false, limit, options.previousPrompt));
    }
    // Rank project matches first, reserving one candidate for personal continuity
    // when both match (unless the caller explicitly requests just one result).
    const project = matched.filter(r => (JSON.parse(r.json).scope as string).startsWith("project:"));
    const personal = matched.filter(r => (JSON.parse(r.json).scope as string).startsWith("personal:"));
    const projectCount = Math.min(project.length, limit - (personal.length && limit > 1 ? 1 : 0));
    const selected = [...project.slice(0, projectCount), ...personal.slice(0, limit - projectCount)];
    selected.forEach(r => { const item = JSON.parse(r.json); if (!found.has(item.id)) decode(r, "lexical match"); });
    this.assertFresh();
    return { items: [...found.values()].sort((a, b) => Number(a.scope.startsWith("personal:")) - Number(b.scope.startsWith("personal:"))), milliseconds: Math.round((performance.now() - start) * 100) / 100 };
  }
}
