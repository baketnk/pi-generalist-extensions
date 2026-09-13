import { opendirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { canonical, hash, legacyDate, scope, type Note, type Scope } from "./schema.ts";
import { boundedFile, checkRoot } from "./store.ts";

// Compatibility reader only. No upstream code, CLI invocation, tree rebuilding,
// default home, environment lookup, or writes to the selected snapshot.
export const LEGACY_FORMAT = "optmem-fixed-v1";
export const LOG_RECORD_BYTES = 320;
export const TREE_RECORD_BYTES = 288;
export const MAX_LEGACY_RAW = 4096;
const MAX_SOURCE_BYTES = MAX_LEGACY_RAW * (LOG_RECORD_BYTES + TREE_RECORD_BYTES);
export interface LegacyOptions {
  archiveId: string; targetScope?: Scope; includeSummaries?: boolean;
}
export interface LegacyPlan {
  entries: Array<{ note: Note; operation: string }>;
  report: {
    format: typeof LEGACY_FORMAT; archiveId: string; digest: string; targetScope: Scope;
    rawRecords: number; summaryRecords: number; blankSummaries: number; missingSummaries: number;
    duplicateRawBodies: number; selectedRecords: number; unassignedRecords: number;
    sourceBytes: number; selectedNoteBytes: number; treePresent: boolean;
    warnings: string[];
  };
}
/** UUID-shaped deterministic IDs, namespaced by a human-assigned archive UUID. */
export function legacyId(value: string): string {
  const hex = hash(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function names(root: string, max: number): string[] {
  const directory = opendirSync(root), result: string[] = [];
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      if (result.length >= max) throw new Error("Too many snapshot directory entries");
      result.push(entry.name);
    }
  } finally { directory.closeSync(); }
  return result.sort();
}
function line(record: Buffer, locator: string): string {
  if (record.at(-1) !== 10) throw new Error(`Invalid fixed-width terminator at ${locator}`);
  let decoded: string;
  try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(record.subarray(0, -1)); }
  catch { throw new Error(`Invalid UTF-8 at ${locator}`); }
  const value = decoded.replace(/ +$/, "");
  if (/[\r\n\0]/.test(value)) throw new Error(`Invalid control/line separator at ${locator}`);
  return value;
}
function body(value: string, locator: string) {
  if (!value || value !== value.trim() || Buffer.byteLength(value) > 280) throw new Error(`Invalid text length or whitespace at ${locator}`);
}
/** Require an explicitly chosen, inactive snapshot. Metadata reports never contain note text. */
export function inspectOptmemSnapshot(root: string, options: LegacyOptions): LegacyPlan {
  if (!isAbsolute(root)) throw new Error("Explicit absolute snapshot root required");
  root = resolve(root); checkRoot(root);
  if (typeof options.archiveId !== "string" || options.archiveId.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(options.archiveId)) throw new Error("Explicit archive UUID required");
  if (options.includeSummaries !== undefined && typeof options.includeSummaries !== "boolean") throw new Error("Invalid summary selection");
  const targetScope = options.targetScope ?? "unassigned";
  scope(targetScope);
  const rootNames = names(root, 8);
  if (!rootNames.includes("LOG.txt") || rootNames.some(n => !["LOG.txt", "TREE", "config", ".lock"].includes(n))) throw new Error("Unsupported OptMem snapshot layout");
  const files = new Map<string, Buffer>();
  const log = boundedFile(join(root, "LOG.txt"), MAX_LEGACY_RAW * LOG_RECORD_BYTES);
  if (log.length % LOG_RECORD_BYTES) throw new Error("Partial LOG.txt record; snapshot was not repaired or truncated");
  files.set("LOG.txt", log);
  const rawRecords = log.length / LOG_RECORD_BYTES, treePresent = rootNames.includes("TREE");
  let sourceBytes = log.length;
  if (treePresent) {
    const treeRoot = join(root, "TREE"); checkRoot(treeRoot);
    for (const name of names(treeRoot, 16)) {
      const size = Number(name);
      if (!/^[1-9][0-9]*$/.test(name) || !Number.isSafeInteger(size) || size < 2 || size > MAX_LEGACY_RAW || !Number.isInteger(Math.log2(size))) throw new Error("Unsupported TREE level name");
      const bytes = boundedFile(join(treeRoot, name), Math.floor(rawRecords / size) * TREE_RECORD_BYTES);
      if (bytes.length % TREE_RECORD_BYTES) throw new Error(`Partial TREE/${size} record; snapshot was not repaired or truncated`);
      sourceBytes += bytes.length;
      if (sourceBytes > MAX_SOURCE_BYTES) throw new Error("Snapshot exceeds byte quota");
      files.set(`TREE/${size}`, bytes);
    }
  }
  const entries: LegacyPlan["entries"] = [];
  let summaryRecords = 0, blankSummaries = 0, duplicateRawBodies = 0;
  const bodies = new Set<string>();
  const add = (type: "raw" | "summary", locator: string, value: string, record: Buffer, date?: string) => {
    const recordText = new TextDecoder("utf-8", { fatal: true }).decode(record);
    const recordHash = hash(recordText);
    const origin = `${LEGACY_FORMAT}:${options.archiveId}:${locator}`;
    const note: Note = {
      scope: targetScope, kind: type === "raw" ? "fact" : "artifact", title: `OptMem ${type} ${locator}`,
      body: value, author: "import", status: "candidate",
      sources: [{ id: legacyId(`${origin}:source`), author: "import", excerpt: recordText, sha256: recordHash,
        ...(date ? { timestamp: date, precision: "day" as const } : { precision: "unknown" as const }) }],
      legacy: { format: LEGACY_FORMAT, archiveId: options.archiveId, type, locator, recordHash },
    };
    entries.push({ note, operation: legacyId(`${origin}:import`) });
  };
  for (let index = 0; index < rawRecords; index++) {
    const locator = `LOG.txt#${index}`, record = log.subarray(index * LOG_RECORD_BYTES, (index + 1) * LOG_RECORD_BYTES);
    const value = line(record, locator), match = /^#(0|[1-9][0-9]*) (\d{4}-\d{2}-\d{2}) (.+)$/.exec(value);
    if (!match || match[1] !== String(index)) throw new Error(`Invalid raw identity at ${locator}`);
    try { legacyDate(match[2]); } catch { throw new Error(`Invalid date at ${locator}`); }
    body(match[3], locator);
    if (bodies.has(match[3])) duplicateRawBodies++; bodies.add(match[3]);
    add("raw", locator, match[3], record, match[2]);
  }
  let possibleSummaries = 0;
  for (let size = 2; size <= rawRecords; size *= 2) possibleSummaries += Math.floor(rawRecords / size);
  for (const [path, bytes] of files) {
    if (path === "LOG.txt") continue;
    for (let index = 0; index < bytes.length / TREE_RECORD_BYTES; index++) {
      const locator = `${path}#${index}`, record = bytes.subarray(index * TREE_RECORD_BYTES, (index + 1) * TREE_RECORD_BYTES);
      const value = line(record, locator);
      if (!value) { blankSummaries++; continue; }
      body(value, locator); summaryRecords++;
      if (options.includeSummaries !== false) add("summary", locator, value, record);
    }
  }
  // Re-read approved files and directory inventories before accepting this observation.
  // This detects ordinary changes; only an inactive copy provides a coherent snapshot.
  if (canonical(names(root, 8)) !== canonical(rootNames) ||
      (treePresent && canonical(names(join(root, "TREE"), 16)) !== canonical([...files.keys()].filter(k => k.startsWith("TREE/")).map(k => k.slice(5)).sort()))) throw new Error("Snapshot directory changed during inspection");
  for (const [path, bytes] of files) {
    if (!boundedFile(join(root, path), bytes.length).equals(bytes)) throw new Error("Snapshot changed during inspection");
  }
  const fileHashes = [...files].map(([path, bytes]) => ({ path, sha256: hash(bytes.toString("utf8")), bytes: bytes.length })).sort((a, b) => a.path.localeCompare(b.path));
  const digest = hash(canonical({ format: LEGACY_FORMAT, archiveId: options.archiveId, targetScope, includeSummaries: options.includeSummaries !== false, files: fileHashes }));
  const warnings = ["Imported authorship is unknown; no user statements or verified facts are inferred.", "config and .lock are not read or imported. Retained excerpts and exports may contain private text."];
  if (targetScope === "unassigned") warnings.push("All selected records remain unassigned candidates until explicitly classified.");
  if (!treePresent) warnings.push("TREE is absent: raw originals only; summary retention coverage is unknown.");
  if (possibleSummaries > summaryRecords) warnings.push("Missing/blank summaries are not rebuilt; all valid raw originals remain available.");
  if (options.includeSummaries === false) warnings.push("Summary artifacts were explicitly excluded.");
  return { entries, report: { format: LEGACY_FORMAT, archiveId: options.archiveId, digest, targetScope, rawRecords, summaryRecords, blankSummaries,
    missingSummaries: possibleSummaries - summaryRecords, duplicateRawBodies, selectedRecords: entries.length,
    unassignedRecords: targetScope === "unassigned" ? entries.length : 0, sourceBytes,
    selectedNoteBytes: Buffer.byteLength(canonical(entries)), treePresent, warnings } };
}
