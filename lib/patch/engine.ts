import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { generateUnifiedPatch, truncateHead, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { applyChunks, parsePatch } from "./parser.ts";

export const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * MAX_FILE_BYTES;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const message = (error: unknown) => String(error instanceof Error ? error.message : error).slice(0, 2048);

type Snapshot = { bytes: Buffer; dev: number; ino: number; mode: number; uid: number; gid: number } | null;
type Mutation = { path: string; before: Snapshot; after: Buffer | null; mode: number; owner: Snapshot };
export type PatchChange = { path: string; action: "add" | "update" | "delete"; before: string | null; after: string | null };
export type PatchResult = {
  status: "applied" | "noop" | "rejected" | "partial";
  committed: PatchChange[];
  pending: string[];
  error?: string;
  warnings: string[];
  diff: string;
};
export type PatchOptions = {
  signal?: AbortSignal;
  /** Test seam: runs before each commit's final validation, never exposed to the model. */
  beforeCommit?: (index: number, path: string) => Promise<void>;
};

function inside(root: string, path: string) {
  const rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Patch paths must name files inside cwd.");
  const parts = rel.split(sep);
  if (parts.some(part => part.toLowerCase() === ".git")) throw new Error("Patching .git administration files is not supported.");
  if (process.platform === "win32" && parts.some(part => /[<>:"|?*]|[ .]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
    throw new Error("Windows device, alternate-stream, or normalized alias path rejected.");
}

/** Reject symlinks in every component; not a sandbox against malicious directory races. */
async function checkPath(root: string, path: string): Promise<void> {
  inside(root, path);
  let current = root;
  const parts = relative(root, path).split(sep);
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Symlink path rejected: ${current}`);
      if (i < parts.length - 1 && !stat.isDirectory()) throw new Error(`Not a directory: ${current}`);
    } catch (error) { if (missing(error)) return; throw error; }
  }
}

async function snapshot(root: string, path: string): Promise<Snapshot> {
  await checkPath(root, path);
  let stat;
  try { stat = await fs.lstat(path); } catch (error) { if (missing(error)) return null; throw error; }
  if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Only regular, single-link files are supported: ${path}`);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`File exceeds 1 MiB: ${path}`);
  const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino)
      throw new Error(`File identity changed while reading: ${path}`);
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > MAX_FILE_BYTES) throw new Error(`File exceeds 1 MiB: ${path}`);
    const bytes = buffer.subarray(0, size);
    if (bytes.includes(0) || !Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes))
      throw new Error(`Only NUL-free UTF-8 text is supported: ${path}`);
    return { bytes, dev: opened.dev, ino: opened.ino, mode: opened.mode, uid: opened.uid, gid: opened.gid };
  } finally { await handle.close(); }
}

async function validate(root: string, mutation: Mutation) {
  const current = await snapshot(root, mutation.path);
  const before = mutation.before;
  if (before === null ? current !== null : current === null ||
      current.dev !== before.dev || current.ino !== before.ino || current.mode !== before.mode ||
      current.uid !== before.uid || current.gid !== before.gid || !current.bytes.equals(before.bytes))
    throw new Error(`Stale file or destination appeared: ${mutation.path}; re-read before retrying.`);
}

async function parents(root: string, path: string, created: string[]) {
  await checkPath(root, path);
  let current = root;
  for (const part of relative(root, dirname(path)).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { await fs.mkdir(current); created.push(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe parent directory: ${current}`);
  }
}

function change(m: Mutation, root: string): PatchChange {
  return { path: relative(root, m.path), action: m.after === null ? "delete" : m.before === null ? "add" : "update",
    before: m.before ? digest(m.before.bytes) : null, after: m.after ? digest(m.after) : null };
}

function diff(mutations: Mutation[], root: string): string {
  let text = "";
  for (const m of mutations) {
    const name = relative(root, m.path);
    // Avoid expensive diff computation for large/disjoint text; never return a fabricated patch.
    const before = m.before?.bytes.toString("utf8") ?? "", after = m.after?.toString("utf8") ?? "";
    if ((m.before?.bytes.length ?? 0) + (m.after?.length ?? 0) > 128 * 1024 || before.split("\n").length + after.split("\n").length > 2000) {
      text += `${JSON.stringify(name)}: diff omitted (over 128 KiB or 2000 combined lines); inspect the file/git diff.\n`;
    } else {
      text += generateUnifiedPatch(name, before, after);
    }
    if (Buffer.byteLength(text) > 24 * 1024) break;
  }
  const bounded = truncateHead(text, { maxBytes: 24 * 1024, maxLines: 600 });
  return bounded.content + (bounded.truncated || mutations.length > 1 && Buffer.byteLength(text) > 24 * 1024
    ? "\n[Diff output truncated; inspect files or git diff for the complete changes.]" : "");
}

/** Sorted shared Pi queues cover reads, staging, validation and commit, including move destinations. */
async function locked<T>(paths: string[], run: () => Promise<T>): Promise<T> {
  const acquire = (index: number): Promise<T> => index === paths.length ? run()
    : withFileMutationQueue(paths[index]!, () => acquire(index + 1));
  return acquire(0);
}

export async function executePatch(cwd: string, input: string, options: PatchOptions = {}): Promise<PatchResult> {
  const result: PatchResult = { status: "rejected", committed: [], pending: [], warnings: [], diff: "" };
  try {
    options.signal?.throwIfAborted();
    const files = parsePatch(input, result.warnings);
    const root = await fs.realpath(cwd);
    const resolvePath = (path: string) => {
      // Absolute paths rooted in a symlink spelling of cwd are intentionally not remapped.
      const full = resolve(root, path.startsWith("@") ? path.slice(1) : path);
      inside(root, full);
      return full;
    };
    const operations = files.map(file => ({ file, path: resolvePath(file.path),
      move: file.kind === "update" && file.move ? resolvePath(file.move) : undefined }));
    const paths = operations.flatMap(op => op.move ? [op.path, op.move] : [op.path]);
    if (paths.reduce((sum, path) => sum + Buffer.byteLength(relative(root, path)), 0) > 8192)
      throw new Error("Combined patch paths exceed 8 KiB; split the patch.");
    // Conservative on platforms commonly using case-insensitive volumes.
    const keys = paths.map(path => process.platform === "win32" || process.platform === "darwin" ? path.toLowerCase() : path);
    if (new Set(keys).size !== keys.length) throw new Error("Duplicate/overlapping paths or move chains: combine each file's chunks into one section.");
    // Parent file conflicts (add x and add x/y) are rejected before staging any directories.
    const sorted = [...paths].sort();
    for (const path of keys) for (const other of keys)
      if (other !== path && other.startsWith(path + sep)) throw new Error("A patch target is another target's parent.");
    await Promise.all(paths.map(path => checkPath(root, path)));
    const identities = new Set<string>();
    for (const path of paths) {
      try {
        const stat = await fs.lstat(path);
        const identity = `${stat.dev}:${stat.ino}`;
        if (identities.has(identity)) throw new Error("Duplicate file identities in patch targets.");
        identities.add(identity);
      } catch (error) { if (!missing(error)) throw error; }
    }
    return await locked(sorted, async () => {
      const mutations: Mutation[] = [];
      const temps: string[] = [], created: string[] = [];
      try {
        let total = 0;
        for (const { file, path, move } of operations) {
          options.signal?.throwIfAborted();
          const before = await snapshot(root, path);
          if (file.kind === "add" ? before !== null : before === null)
            throw new Error(file.kind === "add" ? `Add File would overwrite: ${path}` : `File not found: ${path}`);
          if (before && (before.mode & 0o7000)) throw new Error(`Special permission bits unsupported: ${path}`);
          const matchWarnings: string[] = [];
          const after = file.kind === "delete" ? null : Buffer.from(file.kind === "add" ? file.content
            : applyChunks(before!.bytes.toString("utf8"), file.chunks, matchWarnings));
          for (const warning of matchWarnings) if (result.warnings.length < 32)
            result.warnings.push(`${relative(root, path)}: ${warning}`);
          if (matchWarnings.length > 32) result.warnings.push("Additional matching warnings omitted.");
          total += (before?.bytes.length ?? 0) + (after?.length ?? 0);
          if ((after?.length ?? 0) > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) throw new Error("Patch output exceeds 1 MiB/file or 4 MiB combined input/output.");
          if (move) {
            if (await snapshot(root, move)) throw new Error(`Move destination already exists: ${move}`);
            mutations.push({ path: move, before: null, after, mode: before!.mode & 0o777, owner: before });
            mutations.push({ path, before, after: null, mode: 0, owner: before });
          } else if (!before || !after || !before.bytes.equals(after)) {
            mutations.push({ path, before, after, mode: before ? before.mode & 0o777 : 0o666 & ~process.umask(), owner: before });
          } else {
            result.warnings.push(`${relative(root, path)}: update produced content identical to the current file; no write performed.`);
          }
        }
        if (!mutations.length) {
          result.status = "noop";
        } else {
          result.pending = mutations.map(m => relative(root, m.path));
          const staged = new Map<Mutation, string>();
          for (const m of mutations) {
            options.signal?.throwIfAborted();
            if (m.after === null) continue;
            await parents(root, m.path, created);
            const temp = join(dirname(m.path), `.generalist-patch-${randomUUID()}.tmp`);
            const handle = await fs.open(temp, "wx", 0o600);
            temps.push(temp);
            try {
              await handle.writeFile(m.after);
              if (m.owner && process.platform !== "win32") await handle.chown(m.owner.uid, m.owner.gid);
              await handle.chmod(m.mode);
              await handle.sync();
            } finally { await handle.close(); }
            staged.set(m, temp);
          }
          // Derive reports before committing: report preparation errors cannot conceal a successful write.
          const summaries = mutations.map(m => change(m, root));
          const fullDiff = diff(mutations, root);
          for (const m of mutations) await validate(root, m);
          for (let index = 0; index < mutations.length; index++) {
            const m = mutations[index]!;
            await options.beforeCommit?.(index, m.path);
            options.signal?.throwIfAborted();
            await validate(root, m);
            if (m.after === null) await fs.unlink(m.path);
            else if (m.before === null) {
              // Same-filesystem link publishes a fully-written new file without clobbering a late arrival.
              await fs.link(staged.get(m)!, m.path);
            } else await fs.rename(staged.get(m)!, m.path);
            result.committed.push(summaries[index]!); // Record before observing cancellation or cleanup errors.
            result.pending.shift();
          }
          result.status = "applied";
          result.diff = fullDiff;
        }
      } catch (error) {
        result.status = result.committed.length ? "partial" : "rejected";
        result.error = message(error);
        if (result.committed.length) result.diff = "Partial application: inspect committed paths before retrying. No automatic rollback was attempted.";
      } finally {
        for (const temp of temps) {
          try { await fs.unlink(temp); } catch (error) {
            if (!missing(error)) result.warnings.push(`Temporary file cleanup failed: ${temp}: ${message(error)}`);
          }
        }
        if (result.status !== "applied") for (const dir of created.reverse()) {
          try { await fs.rmdir(dir); } catch (error) {
            if (!missing(error) && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") result.warnings.push(`Directory cleanup failed: ${dir}: ${message(error)}`);
          }
        }
      }
      const warningText = result.warnings.join("\n");
      if (Buffer.byteLength(warningText) > 8192) {
        const bounded = truncateHead(warningText, { maxBytes: 8192, maxLines: 80 });
        result.warnings = [bounded.content, "Additional warnings truncated; inspect files and temporary-file cleanup."];
      }
      return result;
    });
  } catch (error) { result.error = message(error); return result; }
}
