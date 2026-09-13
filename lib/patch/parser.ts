// SPDX-License-Identifier: Apache-2.0
// Adapted from OpenAI Codex's apply-patch format (Copyright 2025 OpenAI).
// Modified for Generalist: TypeScript parser, unique tiered matching,
// byte-preserving context, bounded inputs; no shell-wrapper recovery.
// See ../../licenses/codex-NOTICE and ../../licenses/codex-Apache-2.0.txt.

export const MAX_PATCH_BYTES = 256 * 1024;
export const MAX_FILES = 32;
export type PatchLine = { kind: " " | "+" | "-"; text: string };
export type Chunk = { context?: string; lines: PatchLine[]; eof: boolean };
export type FilePatch =
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; move?: string; chunks: Chunk[] };

export function parsePatch(input: string, warnings: string[] = []): FilePatch[] {
  if (typeof input !== "string" || Buffer.byteLength(input) > MAX_PATCH_BYTES)
    throw new Error("Patch must be a string of at most 256 KiB.");
  if (input.includes("\0") || /\r(?!\n)/.test(input)) throw new Error("NUL and bare CR are unsupported in patches.");
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  while (lines.at(-1) === "") lines.pop();
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch")
    throw new Error("Expected *** Begin Patch and *** End Patch; no Markdown fences or shell wrappers.");
  let i = 1;
  const files: FilePatch[] = [];
  const fail = (message: string): never => { throw new Error(`Patch line ${i + 1}: ${message}`); };
  const path = (value: string) => {
    if (!value || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value) || value.length > 4096)
      fail("Invalid path (empty, whitespace-padded, control characters, or over 4096 characters).");
    return value;
  };
  const boundary = () => lines[i]?.startsWith("*** ");
  while (i < lines.length - 1) {
    const header = lines[i++]!;
    if (header.startsWith("*** Add File: ")) {
      const name = path(header.slice(14));
      const added: string[] = [];
      while (i < lines.length - 1 && !boundary()) {
        if (!lines[i]!.startsWith("+")) fail("Add File content must start with +.");
        added.push(lines[i++]!.slice(1));
      }
      files.push({ kind: "add", path: name, content: added.length ? added.join("\n") + "\n" : "" });
    } else if (header.startsWith("*** Delete File: ")) {
      files.push({ kind: "delete", path: path(header.slice(17)) });
    } else if (header.startsWith("*** Update File: ")) {
      const file: Extract<FilePatch, { kind: "update" }> = { kind: "update", path: path(header.slice(17)), chunks: [] };
      if (lines[i]?.startsWith("*** Move to: ")) file.move = path(lines[i++]!.slice(13));
      let sawChunk = false;
      while (i < lines.length - 1 && !boundary()) {
        sawChunk = true;
        const chunkLine = i + 1;
        const chunk: Chunk = { lines: [], eof: false };
        if (lines[i] === "@@" || lines[i]?.startsWith("@@ ")) {
          const marker = lines[i++]!;
          if (marker !== "@@") {
            chunk.context = marker.slice(3);
            if (/^-\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(chunk.context)) fail("Use @@ or @@ literal context, not unified-diff line numbers.");
          }
        } else if (file.chunks.length) fail("Expected @@ before the next chunk.");
        while (i < lines.length - 1 && !boundary() && lines[i] !== "@@" && !lines[i]?.startsWith("@@ ")) {
          const line = lines[i]!;
          if (![" ", "+", "-"].includes(line[0] ?? "")) fail("Expected a space, +, or - prefix (including blank context lines).");
          chunk.lines.push({ kind: line[0] as PatchLine["kind"], text: line.slice(1) });
          i++;
        }
        if (lines[i] === "*** End of File") { chunk.eof = true; i++; }
        if (!chunk.lines.length || !chunk.lines.some(line => line.kind !== " ")) {
          const kind = chunk.lines.length ? "context-only" : "empty";
          warnings.push(`${file.path}: ignored ${kind} chunk beginning at patch line ${chunkLine}.`);
        } else file.chunks.push(chunk);
        if (chunk.eof && i < lines.length - 1 && !boundary()) fail("End of File must finish this file's chunks.");
      }
      if (!file.chunks.length && !file.move && !sawChunk) fail("Update File requires a change or Move to.");
      files.push(file);
    } else fail("Expected Add File, Update File, or Delete File header.");
    if (files.length > MAX_FILES) fail(`At most ${MAX_FILES} file operations per patch.`);
  }
  if (!files.length) throw new Error("Patch contains no file operations.");
  return files;
}

type SourceLine = { text: string; ending: string };
function sourceLines(text: string): SourceLine[] {
  return (text.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+$/g) ?? []).map(raw => {
    const ending = /(?:\r\n|\n|\r)$/.exec(raw)?.[0] ?? "";
    return { text: raw.slice(0, raw.length - ending.length), ending };
  });
}

/** Codex-style last-resort punctuation normalization, used only for matching. */
function punctuation(text: string): string {
  return text.trim()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
    .replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/g, " ");
}
const matchLevels = [
  { name: "exact", normalize: (text: string) => text },
  { name: "trailing whitespace", normalize: (text: string) => text.trimEnd() },
  { name: "leading/trailing whitespace", normalize: (text: string) => text.trim() },
  { name: "Unicode punctuation", normalize: punctuation },
];

/** Original-file coordinates; tolerant matching never normalizes preserved source bytes. */
export function applyChunks(source: string, chunks: Chunk[], warnings: string[] = []): string {
  if (!chunks.length) return source; // move-only
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  const original = sourceLines(source.slice(bom.length));
  const ending = original.find(line => line.ending)?.ending ?? "\n";
  const out: SourceLine[] = [];
  let cursor = 0;
  let work = 0;
  const normalized = new Map<string, string[]>();
  const unique = (pattern: string[], start: number, eof: boolean) => {
    for (const level of matchLevels) {
      const wanted = pattern.map(level.normalize);
      let haystack = normalized.get(level.name);
      if (!haystack) { haystack = original.map(line => level.normalize(line.text)); normalized.set(level.name, haystack); }
      const matches: number[] = [];
      // KMP avoids quadratic comparisons for long repeated source/patch blocks.
      const prefix = new Array<number>(wanted.length).fill(0);
      for (let i = 1, j = 0; i < wanted.length; i++) {
        while (j > 0 && wanted[i] !== wanted[j]) j = prefix[j - 1]!;
        if (wanted[i] === wanted[j]) j++;
        prefix[i] = j;
      }
      const from = eof ? Math.max(start, original.length - wanted.length) : start;
      for (let i = from, j = 0; i < haystack.length; i++) {
        if (++work > 10_000_000) throw new Error("Patch matching work limit exceeded; use smaller patches or more specific @@ context.");
        while (j > 0 && haystack[i] !== wanted[j]) j = prefix[j - 1]!;
        if (haystack[i] === wanted[j]) j++;
        if (j === wanted.length) {
          if (!eof || i === haystack.length - 1) matches.push(i - j + 1);
          if (matches.length > 1) break;
          j = prefix[j - 1]!;
        }
      }
      if (matches.length > 1) throw new Error(`Ambiguous ${level.name} context near lines ${matches.map(at => at + 1).join(", ")}; include more context.`);
      if (matches.length) {
        if (level.name !== "exact") warnings.push(`Matched at line ${matches[0]! + 1} using ${level.name} tolerance; inspect the resulting diff.`);
        return matches[0]!;
      }
    }
    throw new Error("Expected lines not found, including whitespace/punctuation fallbacks; re-read the file.");
  };
  for (const chunk of chunks) {
    let start = cursor;
    if (chunk.context !== undefined) start = unique([chunk.context], cursor, false) + 1;
    const old = chunk.lines.filter(line => line.kind !== "+").map(line => line.text);
    // Codex convention: an addition-only chunk appends. Use context lines for other insertion points.
    const at = old.length ? unique(old, start, chunk.eof) : original.length;
    for (let i = cursor; i < at; i++) out.push(original[i]!);
    let consumed = at;
    for (const line of chunk.lines) {
      if (line.kind === " ") out.push(original[consumed++]!);
      else if (line.kind === "-") consumed++;
      else out.push({ text: line.text, ending });
    }
    cursor = consumed;
  }
  for (let i = cursor; i < original.length; i++) out.push(original[i]!);
  // Retain existing EOF newline policy; empty source additions get a newline.
  if (out.length && original.length) out[out.length - 1] = { ...out.at(-1)!, ending: original.at(-1)!.ending ? out.at(-1)!.ending || ending : "" };
  return bom + out.map((line, index) => line.text + (index < out.length - 1 ? line.ending || ending : line.ending)).join("");
}
