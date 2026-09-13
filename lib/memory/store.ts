import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { canonical, decodeSnapshot, decodeTransfer, encodeTransfer, id, scope, STORE_BYTES, validateNote, validateSnapshot, type Note, type Revision, type Scope, type Snapshot } from "./schema.ts";

function directory(path: string) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Storage path must contain only real directories");
}
function checkRoot(root: string) {
  let path = parse(root).root;
  directory(path);
  for (const part of relative(path, root).split(sep).filter(Boolean)) { path = join(path, part); directory(path); }
}
export function boundedFile(path: string, max: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > max) throw new Error("Expected bounded regular file");
    const bytes = Buffer.alloc(max + 1); let used = 0;
    while (used < bytes.length) { const n = readSync(fd, bytes, used, bytes.length - used, null); if (!n) break; used += n; }
    if (used > max) throw new Error("File exceeds limit");
    return bytes.subarray(0, used);
  } finally { closeSync(fd); }
}
function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
/** Experimental bounded local store; no Pi API, provider, default home or timers. */
export class MemoryStore {
  readonly root: string;
  constructor(root: string) {
    if (!isAbsolute(root)) throw new Error("Explicit absolute store root required");
    this.root = resolve(root);
    checkRoot(this.root); // caller creates the private directory explicitly
  }
  private locked<T>(action: () => T): T {
    checkRoot(this.root);
    const lock = join(this.root, ".writer-lock");
    try { mkdirSync(lock, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Store busy or interrupted writer; lock is never automatically stolen");
      throw error;
    }
    try {
      const result = action();
      // Also sync identical retries: the first attempt may have renamed successfully
      // but failed its directory flush before returning an acknowledgement.
      syncDirectory(this.root);
      return result;
    } finally { rmdirSync(lock); }
  }
  private load(): Snapshot {
    checkRoot(this.root);
    return decodeSnapshot(boundedFile(join(this.root, "store.json"), STORE_BYTES));
  }
  private publish(value: Snapshot) {
    validateSnapshot(value);
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
      const snapshot: Snapshot = { format: "pi-memory-prototype", version: 1, storeId: randomUUID(), revisions: [] };
      this.publish(snapshot); return snapshot.storeId;
    });
  }
  /** operation is a caller-generated UUID, reused only for an identical retry. */
  note(note: Note, operation: string): Revision {
    validateNote(note); id(operation);
    if (note.author === "import" && note.status !== "candidate") throw new Error("Imported notes must enter as candidates");
    return this.locked(() => {
      const snapshot = this.load(), old = snapshot.revisions.find(r => r.operation === operation);
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
      const snapshot = this.load(), retry = snapshot.revisions.find(r => r.operation === operation);
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
    const row = this.load().revisions.filter(r => r.id === recordId && allowedScopes.includes(r.scope) && (revision === undefined || r.revision === revision)).at(-1);
    if (!row) throw new Error("Record not found in allowed scopes");
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
      const known = new Map(local.revisions.map(r => [`${r.id}:${r.revision}`, r]));
      let added = 0;
      for (const row of incoming.revisions) {
        const old = known.get(`${row.id}:${row.revision}`);
        if (old && canonical(old) !== canonical(row)) throw new Error("Import revision conflict");
        if (!old) { local.revisions.push(row); added++; }
      }
      validateSnapshot(local);
      if (!dryRun) this.publish(local);
      return { storeId: local.storeId, added, dryRun };
    });
  }
}
