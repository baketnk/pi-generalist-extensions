import { constants, type Dirent } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_FILE = 1024 * 1024, MAX_SCAN = 2000, MAX_SCAN_BYTES = 8 * 1024 * 1024;
const hidden = new Set([".git", ".pi", ".meitan", "node_modules", ".ssh", ".aws", ".local"]);
const sensitive = (name: string) => hidden.has(name) || name === ".env" || name.startsWith(".env.") || /^(auth|credentials|capability)\.json$/i.test(name);
export class InspectFiles {
  root: string;
  privatePaths: string[];
  constructor(root: string, privatePaths: string[] = []) { this.root = root; this.privatePaths = privatePaths.map(p => resolve(p)); }
  private denied(path: string) {
    return this.privatePaths.some(root => { const rel = relative(root, path); return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)); });
  }
  async path(input: string) {
    if (typeof input !== "string" || input.includes("\0")) throw new Error("Invalid path.");
    const path = resolve(this.root, input), rel = relative(this.root, path);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || rel.split(sep).some(sensitive) || this.denied(path)) throw new Error("Path outside inspect grant or private path.");
    let current = this.root;
    for (const part of rel.split(sep).filter(Boolean)) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new Error("Inspect profile does not follow symlinks.");
    }
    if (await realpath(path) !== path) throw new Error("Canonical path changed.");
    return path;
  }
  async text(input: string) {
    const path = await this.path(input), handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = await handle.stat();
      if (!st.isFile() || st.nlink !== 1 || st.size > MAX_FILE) throw new Error("Read requires a regular, single-link file <=1 MiB.");
      const buffer = Buffer.alloc(MAX_FILE + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_FILE || buffer.subarray(0, bytesRead).includes(0)) throw new Error("Oversized or binary file.");
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } finally { await handle.close(); }
  }
  async list(input: string) {
    const path = await this.path(input);
    if (!(await lstat(path)).isDirectory()) throw new Error("Directory required.");
    const entries: Dirent[] = [];
    for await (const entry of await opendir(path)) {
      if (entries.length >= MAX_SCAN) throw new Error("Directory exceeds 2000 entries; select a narrower path.");
      entries.push(entry);
    }
    return entries.filter(e => !e.isSymbolicLink() && !sensitive(e.name) && !this.denied(join(path, e.name))).sort((a, b) => a.name.localeCompare(b.name));
  }
  async search(query: string, input = ".", signal?: AbortSignal) {
    const pending = [input], matches: string[] = []; let files = 0, entries = 0, bytes = 0, omitted = false;
    while (pending.length) {
      signal?.throwIfAborted();
      const dir = pending.pop()!;
      for (const entry of await this.list(dir)) {
        signal?.throwIfAborted();
        if (++entries > MAX_SCAN) return { matches, files, limited: true };
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { if (pending.length < MAX_SCAN) pending.push(path); else omitted = true; continue; }
        if (!entry.isFile()) continue;
        if (++files > MAX_SCAN || bytes >= MAX_SCAN_BYTES || matches.length >= 80) return { matches, files, limited: true };
        let content: string;
        try { content = await this.text(path); } catch { omitted = true; continue; }
        bytes += Buffer.byteLength(content);
        if (bytes > MAX_SCAN_BYTES) return { matches, files, limited: true };
        const lines = content.split("\n");
        for (let i = 0; i < lines.length && matches.length < 80; i++) if (lines[i]!.includes(query)) matches.push(`${path}:${i + 1}: ${lines[i]!.slice(0, 200)}`);
      }
    }
    return { matches, files, limited: omitted };
  }
}
export function inspectTools(root: string, privatePaths: string[] = []) {
  const files = new InspectFiles(root, privatePaths);
  const result = (value: unknown) => {
    const encoded = Buffer.from(JSON.stringify(value));
    const text = encoded.subarray(0, 16000).toString("utf8") + (encoded.length > 16000 ? "\n[Output clipped to <=16 KiB; request a narrower range.]" : "");
    return { content: [{ type: "text" as const, text }], details: {} };
  };
  return [
    defineTool({ name: "read", label: "Read", description: "Read UTF-8 text inside the assigned root. No private paths, symlinks, binary files or files >1 MiB. Output <=16 KiB.",
      parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }, { additionalProperties: false }),
      async execute(_id, args, signal) { signal?.throwIfAborted(); const all = (await files.text(args.path)).split("\n"), start = (args.offset ?? 1) - 1;
        const lines = all.slice(start, start + (args.limit ?? 120)).map((l, i) => `${start + i + 1}: ${l}`); return result({ path: args.path, lines, totalLines: all.length, note: "Page/output may be clipped; narrow the range if needed." }); } }),
    defineTool({ name: "ls", label: "List", description: "List at most 200 non-private entries in a granted directory; no symlink traversal.",
      parameters: Type.Object({ path: Type.Optional(Type.String()) }, { additionalProperties: false }),
      async execute(_id, args, signal) { signal?.throwIfAborted(); const entries = await files.list(args.path ?? "."); return result({ entries: entries.slice(0, 200).map(e => e.name + (e.isDirectory() ? "/" : "")), omitted: Math.max(0, entries.length - 200) }); } }),
    defineTool({ name: "grep", label: "Search", description: "Literal text search within assigned root. At most 2000 files/8 MiB scanned, 80 matches, 16 KiB output. Private, large and binary files excluded; no shell or regular expressions.",
      parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 200 }), path: Type.Optional(Type.String()) }, { additionalProperties: false }),
      async execute(_id, args, signal) { return result(await files.search(args.query, args.path, signal)); } }),
  ];
}
