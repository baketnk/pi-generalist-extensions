import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const SOURCE_BYTES = 128 * 1024;
const RECORD_BYTES = 1024 * 1024, INDEX_BYTES = 32 * 1024 * 1024;
export const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export function validId(id: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error("ID must be 1–64 lowercase letters, digits or hyphens.");
  return id;
}
export interface Original {
  version: 1; id: string; identity: string; path: string; capturedAt: string;
  title: string; sha256: string; markdown: string;
}
export type SourceState = "unchanged" | "changed" | "missing" | "unavailable";
export interface Span { id: string; identity: string; sha256: string; path: string; capturedAt: string; title: string; start: number; end: number; text: string }
function bounded(path: string, max: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > max) throw new Error("Unsafe or oversized file.");
    const bytes = Buffer.alloc(max + 1);
    let size = 0, n: number;
    while (size <= max && (n = readSync(fd, bytes, size, max + 1 - size, null)) > 0) size += n;
    const after = fstatSync(fd);
    if (size > max || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("File changed during bounded read.");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size));
  } finally { closeSync(fd); }
}
function directory(path: string, create = false) {
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  const s = lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("Unsafe continuity directory.");
}
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
function decode(text: string): Original {
  const r = JSON.parse(text) as Original;
  if (r.version !== 1 || typeof r.id !== "string" || typeof r.identity !== "string" || !/^[a-f0-9-]{36}$/.test(r.identity) ||
      typeof r.path !== "string" || !isAbsolute(r.path) || r.path.length > 4096 ||
      typeof r.capturedAt !== "string" || !Number.isFinite(Date.parse(r.capturedAt)) || typeof r.title !== "string" || r.title.length > 240 ||
      typeof r.markdown !== "string" || !r.markdown.trim() || Buffer.byteLength(r.markdown) > SOURCE_BYTES || r.sha256 !== hash(r.markdown)) throw new Error("Invalid continuity original.");
  validId(r.id); return r;
}
const stop = new Set("a an and are as at be been but by can could do does for from had has have how i if in into is it its me my of on or our please should so that the their them then there these they this to us was we were what when where which who will with would you your".split(" "));
export function terms(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(t => t.length <= 64 && !stop.has(t)))];
}
interface SearchIndex { version: 1; generation: string; records: Omit<Original, "markdown" | "version">[]; postings: Record<string, Record<string, number[]>> }

/** Human-selected shelf, separate from native memory. No implicit startup I/O. */
export class ContinuityStore {
  readonly root: string;
  constructor(root: string) {
    if (!isAbsolute(root)) throw new Error("Continuity root must be absolute.");
    this.root = resolve(root);
  }
  private paths(create = false) {
    directory(this.root, create); directory(join(this.root, "sources"), create);
  }
  private file(id: string) { return join(this.root, "sources", `${validId(id)}.json`); }
  private lock<T>(fn: () => T): T {
    this.paths(true);
    const path = join(this.root, ".lock");
    let fd: number;
    try { fd = openSync(path, "wx", 0o600); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Continuity store busy; inspect a crash-left lock manually, never steal it automatically.");
      throw e;
    }
    try { return fn(); } finally { closeSync(fd); unlinkSync(path); }
  }
  private publish(path: string, value: unknown) {
    const temp = join(this.root, `.pending-${randomUUID()}`), fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
    try { renameSync(temp, path); } finally { try { unlinkSync(temp); } catch (e) { if (!missing(e)) throw e; } }
    const parent = openSync(dirname(path), constants.O_RDONLY);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  }
  private invalidate() {
    try {
      const path = join(this.root, "index.json"), s = lstatSync(path);
      if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) throw new Error("Unsafe continuity index.");
      unlinkSync(path);
    } catch (e) { if (!missing(e)) throw e; }
  }
  prepare(id: string, path: string): Original {
    validId(id);
    if (!isAbsolute(path) || path.length > 4096 || !/\.md$/i.test(path)) throw new Error("Select one absolute .md file (no globs).");
    // Reject final-component links before resolving parents; ancestor aliases are canonicalized.
    const s = lstatSync(path);
    if (!s.isFile() || s.isSymbolicLink()) throw new Error("Select a regular Markdown file, not a symlink.");
    const canonical = realpathSync(path), markdown = bounded(canonical, SOURCE_BYTES);
    if (!markdown.trim()) throw new Error("Original is empty.");
    return { version: 1, id, identity: randomUUID(), path: canonical, capturedAt: new Date().toISOString(),
      title: (markdown.split("\n").find(line => line.trim()) ?? id).replace(/^#+\s*/, "").slice(0, 240), sha256: hash(markdown), markdown };
  }
  save(prepared: Original, expectedIdentity?: string) {
    const record = decode(JSON.stringify(prepared));
    return this.lock(() => {
      let current: Original | undefined;
      try { current = this.read(record.id); } catch (e) { if (!missing(e)) throw e; }
      if (current?.identity !== expectedIdentity) throw new Error("Registration conflict; preview again.");
      if (!current && this.list().length >= 100) throw new Error("Continuity shelf limit is 100 originals.");
      if (this.check(record) !== "unchanged") throw new Error("External original changed after preview; preview again.");
      this.invalidate(); this.publish(this.file(record.id), record); return record;
    });
  }
  remove(id: string, expectedIdentity: string) {
    this.lock(() => {
      if (this.read(id).identity !== expectedIdentity) throw new Error("Registration conflict; preview again.");
      this.invalidate(); unlinkSync(this.file(id));
      const fd = openSync(join(this.root, "sources"), constants.O_RDONLY);
      try { fsyncSync(fd); } finally { closeSync(fd); }
    });
  }
  read(id: string): Original {
    this.paths(); const r = decode(bounded(this.file(id), RECORD_BYTES));
    if (r.id !== id) throw new Error("Original ID mismatch.");
    return r;
  }
  list(): Pick<Original, "id" | "identity" | "title" | "sha256" | "path" | "capturedAt">[] {
    try { this.paths(); } catch (e) { if (missing(e)) return []; throw e; }
    const names = readdirSync(join(this.root, "sources")).filter(n => n.endsWith(".json")).sort();
    if (names.length > 100) throw new Error("Continuity shelf exceeds 100 originals.");
    return names.map(n => { const { markdown: _, version: __, ...metadata } = this.read(n.slice(0, -5)); return metadata; });
  }
  check(record: Original): SourceState {
    try { return hash(bounded(record.path, SOURCE_BYTES)) === record.sha256 ? "unchanged" : "changed"; }
    catch (e) { return missing(e) ? "missing" : "unavailable"; }
  }
  span(id: string, start = 1, end?: number): Span {
    const r = this.read(id), lines = r.markdown.split("\n");
    end ??= Math.min(lines.length, start + 79);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > lines.length || end - start >= 160) throw new Error("Select an existing inclusive range of at most 160 lines.");
    const text = lines.slice(start - 1, end).join("\n");
    if (Buffer.byteLength(text) > 16384) throw new Error("Selected span exceeds 16 KiB; choose a smaller range.");
    const { markdown: _, version: __, ...metadata } = r;
    return { ...metadata, start, end, text };
  }
  private generation() {
    this.paths();
    const names = readdirSync(join(this.root, "sources")).filter(n => n.endsWith(".json")).sort();
    if (names.length > 100) throw new Error("Continuity shelf exceeds 100 originals.");
    return hash(JSON.stringify(names.map(name => {
      const path = this.file(name.slice(0, -5)), s = lstatSync(path, { bigint: true });
      if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n || s.size > BigInt(RECORD_BYTES)) throw new Error("Unsafe continuity original.");
      return [name, s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String);
    })));
  }
  reindex(signal?: AbortSignal) {
    return this.lock(() => {
      const records = this.list(), index: SearchIndex = { version: 1, generation: this.generation(), records, postings: Object.create(null) };
      for (const item of records) {
        signal?.throwIfAborted();
        this.read(item.id).markdown.split("\n").forEach((line, i) => {
          for (const term of terms(line)) {
            const posting = index.postings[term] ??= Object.create(null);
            (posting[item.id] ??= []).push(i + 1);
          }
        });
      }
      if (Buffer.byteLength(JSON.stringify(index)) > INDEX_BYTES) throw new Error("Continuity index exceeds 32 MiB.");
      signal?.throwIfAborted(); this.invalidate(); this.publish(join(this.root, "index.json"), index);
      return { records: records.length, generation: index.generation };
    });
  }
  search(query: string, limit = 5) {
    if (query.length > 512 || !Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error("Search accepts 512 characters and 1–10 results.");
    const selected = terms(query).slice(0, 16);
    if (!selected.length) return [];
    this.paths();
    let index: SearchIndex;
    try { index = JSON.parse(bounded(join(this.root, "index.json"), INDEX_BYTES)); }
    catch (e) { if (missing(e)) throw new Error("No continuity index; use /continuity reindex."); throw e; }
    const generation = this.generation();
    if (index.version !== 1 || index.generation !== generation || !Array.isArray(index.records) || index.records.length > 100 || !index.postings || typeof index.postings !== "object") throw new Error("Stale or invalid continuity index; use /continuity reindex.");
    const rows = index.records.flatMap(r => {
      validId(r.id);
      if (typeof r.title !== "string" || r.title.length > 240 || typeof r.path !== "string" || r.path.length > 4096) throw new Error("Invalid continuity index metadata.");
      const hits = selected.map(t => Object.hasOwn(index.postings, t) ? index.postings[t]?.[r.id] : undefined);
      if (hits.some(h => !Array.isArray(h) || !h.length || h.some(n => !Number.isSafeInteger(n) || n < 1))) return [];
      const lines = [...new Set(hits.flat() as number[])].sort((a, b) => a - b);
      return [{ ...r, matchingLines: lines.slice(0, 20), omittedLines: Math.max(0, lines.length - 20), matchedTerms: selected }];
    }).slice(0, limit);
    if (this.generation() !== generation) throw new Error("Continuity shelf changed during search; retry.");
    return rows;
  }
}
