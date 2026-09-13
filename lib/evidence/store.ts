import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const FILE_BYTES = 1024 * 1024;
export const EXCERPT_BYTES = 12 * 1024;
export const MAX_LINES = 160;
export type EvidenceKind = "source-observation" | "test-contract-inspected";
export interface Evidence {
  version: 1; id: string; title: string; kind: EvidenceKind;
  project: string; capturedAt: string;
  source: string; start: number; end: number;
  fileHash: string; fileBytes: number; excerpt: string;
}
export interface Capture { id: string; title: string; kind: EvidenceKind; path: string; start: number; end: number }
export interface Check {
  id: string; checkedAt: string;
  status: "unchanged" | "changed" | "missing" | "unavailable";
  meaning: string; currentHash?: string; currentBytes?: number;
  currentExcerpt?: string; currentRange?: string; error?: string;
}
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const validId = (id: string) => {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error("Evidence ID must be 1–64 lowercase letters, digits or hyphens.");
  return id;
};
function directory(path: string, create: boolean) {
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Evidence storage must be a real directory.");
}
function boundedRead(path: string, max: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > max) throw new Error(`Requires a regular file of at most ${max} bytes.`);
    const bytes = Buffer.alloc(max + 1);
    let used = 0;
    while (used < bytes.length) {
      const n = readSync(fd, bytes, used, bytes.length - used, null);
      if (!n) break;
      used += n;
    }
    if (used > max) throw new Error(`File exceeds ${max} bytes; nothing was truncated.`);
    return bytes.subarray(0, used);
  } finally { closeSync(fd); }
}
function text(bytes: Buffer): string {
  const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (value.includes("\0")) throw new Error("Binary/NUL-containing files are not supported.");
  return value;
}
function range(start: number, end: number) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start + 1 > MAX_LINES)
    throw new Error(`Choose a 1-based inclusive range of at most ${MAX_LINES} lines.`);
}
function excerpt(lines: string[], start: number, end: number) {
  const value = lines.slice(start - 1, end).join("\n");
  if (Buffer.byteLength(value) > EXCERPT_BYTES) throw new Error(`Excerpt exceeds ${EXCERPT_BYTES} UTF-8 bytes; choose a smaller range.`);
  return value;
}

/** Immutable project-scoped observations. Freshness is computed on demand,
 * never persisted as truth, and never implies a test was executed. */
export class EvidenceStore {
  readonly project: string;
  readonly directory: string;
  constructor(readonly root: string, cwd: string) {
    this.project = realpathSync(cwd);
    this.directory = join(root, hash(this.project));
  }
  private recordPath(id: string, create = false) {
    validId(id); directory(this.root, create); directory(this.directory, create);
    return join(this.directory, `${id}.json`);
  }
  private sourcePath(path: string): string {
    const candidate = resolve(this.project, path);
    const inside = (p: string) => {
      const r = relative(this.project, p);
      return r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r);
    };
    if (!inside(candidate)) throw new Error("Source must be inside this canonical project directory.");
    const canonical = realpathSync(candidate);
    if (!inside(canonical)) throw new Error("Source symlink resolves outside this project.");
    return canonical;
  }
  capture(input: Capture): Evidence {
    validId(input.id); range(input.start, input.end);
    if (!["source-observation", "test-contract-inspected"].includes(input.kind)) throw new Error("Unsupported evidence kind.");
    if (!input.title.trim() || Buffer.byteLength(input.title) > 240) throw new Error("Title must be nonempty and at most 240 UTF-8 bytes.");
    const path = this.sourcePath(input.path), bytes = boundedRead(path, FILE_BYTES);
    const lines = text(bytes).split("\n");
    if (input.end > lines.length) throw new Error("Selected range extends beyond the file.");
    const value: Evidence = {
      version: 1, id: input.id, title: input.title, kind: input.kind,
      project: this.project, capturedAt: new Date().toISOString(),
      source: relative(this.project, path), start: input.start, end: input.end,
      fileHash: hash(bytes), fileBytes: bytes.length,
      excerpt: excerpt(lines, input.start, input.end),
    };
    const serialized = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(serialized) > 32 * 1024) throw new Error("Serialized evidence exceeds 32 KiB; choose a smaller excerpt.");
    const destination = this.recordPath(input.id, true);
    const temporary = join(this.directory, `.pending-${randomUUID()}`);
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, serialized); fsyncSync(fd); }
    finally { closeSync(fd); }
    try {
      try { linkSync(temporary, destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Evidence ID already exists; capture a new ID rather than replacing history.");
        throw error;
      }
    } finally { unlinkSync(temporary); }
    try { const dir = openSync(this.directory, constants.O_RDONLY); try { fsyncSync(dir); } finally { closeSync(dir); } } catch {}
    return value;
  }
  read(id: string): Evidence {
    const value = JSON.parse(text(boundedRead(this.recordPath(id), 32 * 1024))) as Evidence;
    if (!value || value.version !== 1 || value.id !== id || value.project !== this.project ||
        typeof value.title !== "string" || !value.title.trim() || Buffer.byteLength(value.title) > 240 ||
        !["source-observation", "test-contract-inspected"].includes(value.kind) ||
        typeof value.source !== "string" || isAbsolute(value.source) || value.source.length > 4096 ||
        typeof value.capturedAt !== "string" || !Number.isFinite(Date.parse(value.capturedAt)) ||
        typeof value.fileHash !== "string" || !/^[a-f0-9]{64}$/.test(value.fileHash) ||
        !Number.isSafeInteger(value.fileBytes) || value.fileBytes < 0 || value.fileBytes > FILE_BYTES ||
        typeof value.excerpt !== "string" || Buffer.byteLength(value.excerpt) > EXCERPT_BYTES)
      throw new Error("Invalid evidence record; no fallback used.");
    range(value.start, value.end);
    return value;
  }
  list() {
    try { directory(this.root, false); directory(this.directory, false); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const ids = readdirSync(this.directory).filter(n => /^[a-z0-9][a-z0-9-]{0,63}\.json$/.test(n)).sort();
    if (ids.length > 100) throw new Error("More than 100 records; read known IDs directly.");
    return ids.map(name => {
      const e = this.read(name.slice(0, -5));
      return { id: e.id, title: e.title, kind: e.kind, capturedAt: e.capturedAt, freshness: "not checked" };
    });
  }
  check(id: string, compare = false): Check {
    const e = this.read(id), checkedAt = new Date().toISOString();
    try {
      const bytes = boundedRead(this.sourcePath(e.source), FILE_BYTES), currentHash = hash(bytes);
      const result: Check = { id, checkedAt, status: currentHash === e.fileHash ? "unchanged" : "changed",
        meaning: "Whole-file bytes compared with the captured hash; not proof of the observation or test execution.",
        currentHash, currentBytes: bytes.length };
      if (compare) {
        const lines = text(bytes).split("\n"), end = Math.min(e.end, lines.length);
        result.currentRange = e.start > lines.length ? "Captured line range no longer exists" : `${e.start}–${end} (same line positions; not symbol relocation)`;
        try { result.currentExcerpt = excerpt(lines, e.start, end); }
        catch (error) { result.error = String(error); } // freshness still known, oversized comparison is explicit
      }
      return result;
    } catch (error) {
      return { id, checkedAt, status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable",
        meaning: "Current source could not be compared; captured evidence is retained, not revalidated.", error: String(error).slice(0, 500) };
    }
  }
}
