import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PAGE_BYTES = 8192;
export interface Page { id: string; revision: number; content: string; path: string }
export interface PadSummary { id: string; revision: number; title: string }
const validId = (id: string) => {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error("Workpad ID must be 1–64 lowercase letters, digits or hyphens.");
  return id;
};
function validateContent(content: string) {
  if (!content.trim()) throw new Error("Workpad page cannot be empty.");
  if (Buffer.byteLength(content, "utf8") > PAGE_BYTES) throw new Error(`Active page exceeds ${PAGE_BYTES} UTF-8 bytes; shorten it explicitly (no automatic truncation).`);
}
function directory(path: string, create: boolean) {
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Not a real workpad directory: ${path}`);
}

/** Immutable Markdown revisions. An atomic hard-link publishes one complete revision;
 * competing writers of N+1 cannot both win. No lockfiles or stale-lock recovery.
 * Files are plain Markdown but immutable: edit via the tool/UI to create a revision.
 */
export class WorkpadStore {
  readonly project: string;
  readonly directory: string;
  constructor(readonly root: string, cwd: string) {
    this.project = realpathSync(cwd);
    this.directory = join(root, createHash("sha256").update(this.project).digest("hex"));
  }
  private paths(id: string, create = false) {
    validId(id);
    directory(this.root, create);
    directory(this.directory, create);
    const pad = join(this.directory, id);
    directory(pad, create);
    return pad;
  }
  private latest(pad: string): number {
    return readdirSync(pad).reduce((max, name) => /^\d{8}\.md$/.test(name) ? Math.max(max, Number(name.slice(0, 8))) : max, 0);
  }
  read(id: string, revision?: number): Page {
    const pad = this.paths(id);
    const rev = revision ?? this.latest(pad);
    if (!Number.isSafeInteger(rev) || rev < 1 || rev > 99999999) throw new Error("Workpad revision does not exist.");
    const path = join(pad, `${String(rev).padStart(8, "0")}.md`);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let content: string;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > PAGE_BYTES) throw new Error("Invalid or oversized workpad revision.");
      content = readFileSync(fd, "utf8");
    } finally { closeSync(fd); }
    validateContent(content);
    return { id, revision: rev, content, path };
  }
  list(): PadSummary[] {
    try { directory(this.root, false); directory(this.directory, false); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const ids = readdirSync(this.directory).filter(id => /^[a-z0-9][a-z0-9-]{0,63}$/.test(id)).sort();
    if (ids.length > 100) throw new Error("More than 100 workpads in this project; attach/read a known ID directly.");
    return ids.flatMap(id => {
      const pad = this.paths(id);
      if (!this.latest(pad)) return []; // unpublished/crashed create
      const p = this.read(id);
      return [{ id, revision: p.revision, title: p.content.split("\n").find(line => line.trim())!.replace(/^#+\s*/, "").slice(0, 120) }];
    });
  }
  create(id: string, content: string): Page { return this.publish(id, 0, content); }
  update(id: string, expectedRevision: number, content: string): Page {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("An existing expectedRevision is required.");
    return this.publish(id, expectedRevision, content);
  }
  private publish(id: string, expected: number, content: string): Page {
    validateContent(content);
    const pad = this.paths(id, expected === 0);
    const current = this.latest(pad);
    if (current !== expected) throw new Error(`Revision conflict: expected ${expected}, found ${current}. Read again before editing.`);
    if (current >= 99999999) throw new Error("Workpad revision limit reached.");
    const revision = current + 1;
    const destination = join(pad, `${String(revision).padStart(8, "0")}.md`);
    const temporary = join(pad, `.pending-${randomUUID()}`);
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, content, "utf8"); fsyncSync(fd); }
    finally { closeSync(fd); }
    try {
      try { linkSync(temporary, destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Revision conflict: another writer published first. Read again before editing.");
        throw error;
      }
    } finally { unlinkSync(temporary); }
    // Publication is atomic; fsync persistence of the directory is best effort
    // across supported filesystems. This is not a cross-file transaction.
    try { const dir = openSync(pad, constants.O_RDONLY); try { fsyncSync(dir); } finally { closeSync(dir); } } catch {}
    return this.read(id, revision);
  }
}
