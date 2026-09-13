import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { invalidateRecallIndex } from "./derived.ts";
import { canonical, decodeSnapshot, decodeTransfer, encodeTransfer, id, scope, STORE_BYTES, MAX_REVISIONS, validateNote, validateSnapshot, type Note, type Revision, type Scope, type Snapshot } from "./schema.ts";

function directory(path: string) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Storage path must contain only real directories");
}
export function checkRoot(root: string) {
  let path = parse(root).root;
  directory(path);
  for (const part of relative(path, root).split(sep).filter(Boolean)) { path = join(path, part); directory(path); }
}
export function boundedFile(path: string, max: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > max) throw new Error("Expected bounded regular file");
    const bytes = Buffer.alloc(stat.size + 1); let used = 0;
    while (used < bytes.length) { const n = readSync(fd, bytes, used, bytes.length - used, null); if (!n) break; used += n; }
    if (used > max) throw new Error("File exceeds limit");
    if (used !== stat.size) throw new Error("File size changed while reading");
    return bytes.subarray(0, used);
  } finally { closeSync(fd); }
}
function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function withStoreLock<T>(root: string, action: () => T): T {
  checkRoot(root);
  const lock = join(root, ".writer-lock");
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Store busy or interrupted writer; lock is never automatically stolen");
    throw error;
  }
  try {
    const result = action();
    // Retried operations also flush a rename whose previous acknowledgement failed.
    syncDirectory(root);
    return result;
  } finally { rmdirSync(lock); }
}
/** Bounded local store; no Pi API, provider, default home or timers. */
export class MemoryStore {
  readonly root: string;
  constructor(root: string) {
    if (!isAbsolute(root)) throw new Error("Explicit absolute store root required");
    this.root = resolve(root);
    checkRoot(this.root); // caller creates the private directory explicitly
  }
  private locked<T>(action: () => T): T { return withStoreLock(this.root, action); }
  private load(): Snapshot {
    checkRoot(this.root);
    return decodeSnapshot(boundedFile(join(this.root, "store.json"), STORE_BYTES));
  }
  private publish(value: Snapshot) {
    value.version = 2; // old v1 stores upgrade on explicit writes, never on reads
    validateSnapshot(value);
    invalidateRecallIndex(this.root); // includes purge: derived copies cannot outlive originals
    const target = join(this.root, "store.json");
    // Refuse replacing symlinks, including dangling ones.
    try { if (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()) throw new Error("Invalid store file"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temp = join(this.root, `.pending-${randomUUID()}`);
    const fd = openSync(temp, "wx", 0o600);
    try {
      try { writeFileSync(fd, canonical(value)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, target); // locked() flushes the directory before acknowledging
    } finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  initialize(): string {
    return this.locked(() => {
      try { return this.load().storeId; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const snapshot: Snapshot = { format: "pi-memory-prototype", version: 2, storeId: randomUUID(), revisions: [] };
      this.publish(snapshot); return snapshot.storeId;
    });
  }
  /** operation is a caller-generated UUID, reused only for an identical retry. */
  note(note: Note, operation: string): Revision {
    validateNote(note); id(operation);
    if (note.author === "import" && note.status !== "candidate") throw new Error("Imported notes must enter as candidates");
    return this.locked(() => {
      const snapshot = this.load();
      if (snapshot.purged?.some(p => p.operations.includes(operation))) throw new Error("Operation belongs to a purged record");
      const old = snapshot.revisions.find(r => r.operation === operation);
      if (old) {
        const { id: _id, revision, createdAt: _time, reason: _reason, operation: _op, ...body } = old;
        if (revision !== 1 || canonical(body) !== canonical(note)) throw new Error("Operation conflict");
        return old;
      }
      const row: Revision = { ...note, id: randomUUID(), revision: 1, createdAt: new Date().toISOString(), reason: "Initial capture", operation };
      snapshot.revisions.push(row); this.publish(snapshot); return row;
    });
  }
  revise(recordId: string, expectedRevision: number, note: Note, reason: string, operation: string): Revision {
    id(recordId); id(operation); validateNote(note);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("Invalid expected revision");
    return this.locked(() => {
      const snapshot = this.load();
      if (snapshot.purged?.some(p => p.id === recordId || p.operations.includes(operation))) throw new Error("Record or operation was purged");
      const retry = snapshot.revisions.find(r => r.operation === operation);
      if (retry) {
        const { id: storedId, revision, createdAt: _time, reason: storedReason, operation: _op, ...body } = retry;
        if (storedId !== recordId || revision !== expectedRevision + 1 || storedReason !== reason || canonical(body) !== canonical(note)) throw new Error("Operation conflict");
        return retry;
      }
      const previous = snapshot.revisions.filter(r => r.id === recordId).at(-1);
      if (!previous || previous.revision !== expectedRevision) throw new Error("Revision conflict or missing record");
      const row: Revision = { ...note, id: recordId, revision: expectedRevision + 1, createdAt: new Date().toISOString(), reason, operation };
      snapshot.revisions.push(row); this.publish(snapshot); return row;
    });
  }
  read(recordId: string, allowedScopes: Scope[], revision?: number): Revision {
    id(recordId); allowedScopes.forEach(scope);
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new Error("Invalid revision");
    const row = this.load().revisions.filter(r => r.id === recordId && (revision === undefined || r.revision === revision)).at(-1);
    if (!row || !allowedScopes.includes(row.scope)) throw new Error("Record not found in allowed scopes");
    return row;
  }
  search(query: string, allowedScopes: Scope[], options: { candidates?: boolean; offset?: number; limit?: number } = {}) {
    allowedScopes.forEach(scope);
    const { offset = 0, limit = 10, candidates = false } = options;
    if (Buffer.byteLength(query) > 512 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("Invalid search bounds");
    const terms = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    if (!terms.length) return { items: [], nextOffset: null };
    const latest = new Map<string, Revision>();
    for (const row of this.load().revisions) latest.set(row.id, row);
    const matches = [...latest.values()].filter(r => allowedScopes.includes(r.scope) && (r.status === "accepted" || (candidates && r.status === "candidate")) && terms.every(t => `${r.title}\n${r.body}`.toLowerCase().includes(t)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    // Metadata only: bounded original bodies are retrieved explicitly with read.
    const items = matches.slice(offset, offset + limit).map(({ id, revision, scope, title, kind, status, createdAt }) => ({ id, revision, scope, title, kind, status, createdAt }));
    return { items, nextOffset: offset + items.length < matches.length ? offset + items.length : null };
  }
  list(allowedScopes: Scope[], options: { status?: Note["status"]; offset?: number; limit?: number } = {}) {
    allowedScopes.forEach(scope);
    const { status = "candidate", offset = 0, limit = 10 } = options;
    if (!["candidate", "accepted", "retracted"].includes(status) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("Invalid list bounds");
    const latest = new Map<string, Revision>();
    for (const row of this.load().revisions) latest.set(row.id, row);
    const matches = [...latest.values()].filter(r => allowedScopes.includes(r.scope) && r.status === status).sort((a, b) => a.id.localeCompare(b.id));
    const items = matches.slice(offset, offset + limit).map(({ id, revision, scope, title, kind, status, legacy }) => ({ id, revision, scope, title, kind, status, ...(legacy ? { legacy } : {}) }));
    return { items, nextOffset: offset + items.length < matches.length ? offset + items.length : null };
  }
  /** Atomic candidate-only migration boundary. No archive root or file access here. */
  importNotes(entries: Array<{ note: Note; operation: string }>, dryRun = true) {
    if (!Array.isArray(entries) || entries.length > MAX_REVISIONS) throw new Error("Import batch exceeds revision quota");
    for (const entry of entries) {
      validateNote(entry.note); id(entry.operation);
      if (entry.note.author !== "import" || entry.note.status !== "candidate") throw new Error("Migration entries must be imported candidates");
    }
    return this.locked(() => {
      let snapshot: Snapshot;
      try { snapshot = this.load(); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        snapshot = { format: "pi-memory-prototype", version: 2, storeId: randomUUID(), revisions: [] };
      }
      snapshot.version = 2;
      const operations = new Map(snapshot.revisions.map(r => [r.operation, r]));
      const seen = new Set<string>();
      let added = 0, existing = 0, skippedPurged = 0;
      const purgedOperations = new Set(snapshot.purged?.flatMap(p => p.operations) ?? []);
      const timestamp = new Date().toISOString();
      for (const { note, operation } of entries) {
        if (seen.has(operation)) throw new Error("Duplicate migration operation");
        seen.add(operation);
        if (purgedOperations.has(operation)) { skippedPurged++; continue; }
        const old = operations.get(operation);
        if (old) {
          const { id: _id, revision, createdAt: _time, reason: _reason, operation: _op, ...body } = old;
          if (revision !== 1 || canonical(body) !== canonical(note)) throw new Error("Migration source conflict; original was not replaced");
          existing++; continue; // review/correction successors remain current
        }
        snapshot.revisions.push({ ...note, id: operation, operation, revision: 1, createdAt: timestamp, reason: "Explicit legacy snapshot import" });
        added++;
      }
      validateSnapshot(snapshot);
      const bytes = Buffer.byteLength(canonical(snapshot));
      if (!dryRun) this.publish(snapshot);
      return { added, existing, skippedPurged, revisions: snapshot.revisions.length, bytes, dryRun };
    });
  }
  /** Human administration only. IDs/operation tombstones remain to prevent resurrection. */
  purge(recordId: string, expectedRevision: number, confirmation: string) {
    id(recordId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || confirmation !== `purge:${recordId}`) throw new Error("Explicit record confirmation and expected revision required");
    return this.locked(() => {
      const snapshot = this.load();
      if (snapshot.purged?.some(p => p.id === recordId)) return { id: recordId, removedRevisions: 0, alreadyPurged: true };
      const history = snapshot.revisions.filter(r => r.id === recordId);
      if (history.at(-1)?.revision !== expectedRevision) throw new Error("Purge revision conflict or missing record");
      snapshot.revisions = snapshot.revisions.filter(r => r.id !== recordId);
      (snapshot.purged ??= []).push({ id: recordId, operations: history.map(r => r.operation) });
      this.publish(snapshot);
      return { id: recordId, removedRevisions: history.length, alreadyPurged: false };
    });
  }
  export(): string { return encodeTransfer(this.load()); }
  /** Same-store merge or explicit empty-root restore; never silently combines stores. */
  import(bytes: Buffer, dryRun = true) {
    const incoming = decodeTransfer(bytes); // validate all input before taking lock or publishing
    return this.locked(() => {
      let local: Snapshot;
      try { local = this.load(); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        local = { ...incoming, revisions: [] };
      }
      if (local.storeId !== incoming.storeId) throw new Error("Different store identity; restore into an empty root");
      const tombstones = new Map(local.purged?.map(p => [p.id, p]) ?? []);
      for (const tombstone of incoming.purged ?? []) {
        const old = tombstones.get(tombstone.id);
        if (old && canonical(old) !== canonical(tombstone)) throw new Error("Import purge conflict");
        if (!old) { (local.purged ??= []).push(tombstone); tombstones.set(tombstone.id, tombstone); }
      }
      // Import is neither permission to delete local records nor restore purged ones.
      if ([...local.revisions, ...incoming.revisions].some(r => tombstones.has(r.id))) throw new Error("Import conflicts with purge tombstones; no originals changed");
      const known = new Map(local.revisions.map(r => [`${r.id}:${r.revision}`, r]));
      let added = 0;
      for (const row of incoming.revisions) {
        const old = known.get(`${row.id}:${row.revision}`);
        if (old && canonical(old) !== canonical(row)) throw new Error("Import revision conflict");
        if (!old) { local.revisions.push(row); added++; }
      }
      local.version = 2;
      validateSnapshot(local);
      if (!dryRun) this.publish(local);
      return { storeId: local.storeId, added, dryRun };
    });
  }
}
