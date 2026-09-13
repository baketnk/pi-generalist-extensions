import { createHash } from "node:crypto";

export const STORE_BYTES = 16 * 1024 * 1024;
export const MAX_REVISIONS = 8192;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type Scope = `project:${string}` | `personal:${string}` | "unassigned";
export interface Source {
  // Library callers declare provenance; the Pi adapter binds origin and exact text.
  id: string; author: "user" | "assistant" | "import";
  timestamp?: string; precision?: "day" | "instant" | "unknown";
  excerpt: string; sha256: string;
  origin?: { harness: "pi"; sessionId: string; entryId: string };
}
export interface LegacyOrigin {
  format: "optmem-fixed-v1"; archiveId: string;
  type: "raw" | "summary"; locator: string; recordHash: string;
}
export interface CaptureOrigin {
  harness: "pi"; sessionId: string; entryId: string; toolCallId: string; provider: string; model: string;
}
export interface Note {
  scope: Scope; kind: "fact" | "thread" | "reflection" | "artifact";
  title: string; body: string; author: "user" | "assistant" | "import";
  status: "candidate" | "accepted" | "retracted";
  threadStatus?: "open" | "dormant" | "resolved" | "dismissed";
  sources: Source[];
  legacy?: LegacyOrigin;
  capture?: CaptureOrigin;
  claim?: "inference" | "source-backed" | "assistant-authored";
}
export interface Revision extends Note {
  id: string; revision: number; createdAt: string; reason: string;
  operation: string;
}
export interface Purged { id: string; operations: string[] }
export interface Snapshot { format: "pi-memory-prototype"; version: 1 | 2 | 3 | 4; storeId: string; revisions: Revision[]; purged?: Purged[] }
export interface Envelope { format: "pi-memory-transfer"; version: 1; sha256: string; snapshot: Snapshot }
export const hash = (text: string) => createHash("sha256").update(text).digest("hex");
/** Sorted object keys, preserved array order, UTF-8 JSON, no trailing newline. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Not JSON data");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
}
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k)))
    throw new Error("Invalid object or unknown fields");
}
function text(value: unknown, max: number) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || Buffer.byteLength(value) > max || new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value)) !== value)
    throw new Error(`Expected nonempty UTF-8 text within ${max} bytes`);
}
export function id(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length !== 36 || !UUID.test(value)) throw new Error("Invalid UUID");
}
function date(value: unknown) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error("Expected ISO timestamp");
}
export function scope(value: unknown): asserts value is Scope {
  if (value === "unassigned") return;
  if (typeof value !== "string" || !/^(project|personal):/.test(value)) throw new Error("Explicit project/personal scope required");
  id(value.slice(value.indexOf(":") + 1));
}
export function legacyDate(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Invalid legacy date");
  date(`${value}T00:00:00.000Z`);
}
const noteKeys = ["scope", "kind", "title", "body", "author", "status", "threadStatus", "sources", "legacy", "capture", "claim"];
function fields(value: Record<string, unknown>) {
  scope(value.scope); text(value.title, 240); text(value.body, 8192);
  if (!["fact", "thread", "reflection", "artifact"].includes(value.kind as string) || !["user", "assistant", "import"].includes(value.author as string) || !["candidate", "accepted", "retracted"].includes(value.status as string)) throw new Error("Invalid note classification");
  if ((value.scope === "unassigned" || value.kind === "artifact") && value.status === "accepted") throw new Error("Unassigned notes and legacy artifacts cannot be accepted");
  if (value.legacy !== undefined) {
    object(value.legacy, ["format", "archiveId", "type", "locator", "recordHash"]);
    const origin = value.legacy;
    id(origin.archiveId);
    if (origin.format !== "optmem-fixed-v1" || !["raw", "summary"].includes(origin.type as string) ||
        typeof origin.locator !== "string" || !/^(LOG\.txt#\d+|TREE\/\d+#\d+)$/.test(origin.locator) || origin.locator.length > 80 ||
        typeof origin.recordHash !== "string" || !/^[a-f0-9]{64}$/.test(origin.recordHash) || origin.recordHash.length !== 64 ||
        value.author !== "import" || (origin.type === "summary" ? value.kind !== "artifact" : value.kind !== "fact")) throw new Error("Invalid legacy provenance");
  }
  if (value.capture !== undefined) {
    object(value.capture, ["harness", "sessionId", "entryId", "toolCallId", "provider", "model"]);
    if (value.capture.harness !== "pi" || value.author !== "assistant") throw new Error("Invalid native capture origin");
    id(value.capture.sessionId); text(value.capture.entryId, 128); text(value.capture.toolCallId, 256); text(value.capture.provider, 100); text(value.capture.model, 200);
  }
  if (value.claim !== undefined && !["inference", "source-backed", "assistant-authored"].includes(value.claim as string)) throw new Error("Invalid claim label");
  if (value.kind === "thread" ? !["open", "dormant", "resolved", "dismissed"].includes(value.threadStatus as string) : value.threadStatus !== undefined) throw new Error("Invalid thread status");
  if (!Array.isArray(value.sources) || value.sources.length > 8) throw new Error("At most eight retained sources");
  if (value.claim === "source-backed" && !value.sources.length) throw new Error("Source-backed notes require a retained source");
  const ids = new Set();
  for (const source of value.sources) {
    object(source, ["id", "author", "timestamp", "precision", "excerpt", "sha256", "origin"]);
    if (source.origin !== undefined) {
      object(source.origin, ["harness", "sessionId", "entryId"]);
      if (source.origin.harness !== "pi" || source.author === "import") throw new Error("Invalid source origin");
      id(source.origin.sessionId); text(source.origin.entryId, 128);
    }
    id(source.id); text(source.excerpt, 8192);
    if (source.precision !== undefined && !["day", "instant", "unknown"].includes(source.precision as string)) throw new Error("Invalid time precision");
    if (source.timestamp === undefined) {
      if (source.precision !== "unknown") throw new Error("Missing source time must be explicitly unknown");
    } else if (source.precision === "day") legacyDate(source.timestamp);
    else { if (source.precision === "unknown") throw new Error("Unknown source time cannot have a timestamp"); date(source.timestamp); }
    if (!["user", "assistant", "import"].includes(source.author as string) || source.sha256 !== hash(source.excerpt as string) || ids.has(source.id)) throw new Error("Invalid source author, duplicate ID or hash mismatch");
    ids.add(source.id);
  }
  if (value.legacy !== undefined && !(value.sources as Source[]).some(s => s.sha256 === (value.legacy as unknown as LegacyOrigin).recordHash)) throw new Error("Legacy original bytes must be retained");
  if (Buffer.byteLength(canonical(value)) > 32768) throw new Error("Revision exceeds 32 KiB");
}
export function validateNote(value: unknown): asserts value is Note { object(value, noteKeys); fields(value); }
export function validateSnapshot(value: unknown): asserts value is Snapshot {
  object(value, ["format", "version", "storeId", "revisions", "purged"]);
  if (value.format !== "pi-memory-prototype" || ![1, 2, 3, 4].includes(value.version as number)) throw new Error("Unsupported store format");
  id(value.storeId);
  if (!Array.isArray(value.revisions) || value.revisions.length > MAX_REVISIONS) throw new Error("Revision quota exceeded");
  if (value.version === 1 && value.purged !== undefined) throw new Error("Purge tombstones require schema version 2");
  const latest = new Map<string, Revision>(), operations = new Set<string>(), purgedIds = new Set<string>();
  if (value.purged !== undefined) {
    if (!Array.isArray(value.purged) || value.purged.length > MAX_REVISIONS) throw new Error("Invalid purge tombstones");
    for (const tombstone of value.purged) {
      object(tombstone, ["id", "operations"]); id(tombstone.id);
      if (purgedIds.has(tombstone.id) || !Array.isArray(tombstone.operations) || !tombstone.operations.length || tombstone.operations.length > MAX_REVISIONS) throw new Error("Invalid purge tombstone");
      purgedIds.add(tombstone.id);
      for (const operation of tombstone.operations) {
        id(operation);
        if (operations.has(operation) || operations.size >= MAX_REVISIONS) throw new Error("Duplicate or excessive purged operations");
        operations.add(operation);
      }
    }
  }
  for (const row of value.revisions) {
    object(row, [...noteKeys, "id", "revision", "createdAt", "reason", "operation"]); fields(row);
    if (value.version === 1 && (row.legacy !== undefined || row.scope === "unassigned" || row.kind === "artifact" || (row.sources as Source[]).some(s => s.precision !== undefined || s.timestamp === undefined))) throw new Error("Migration fields require schema version 2");
    if (![3, 4].includes(value.version as number) && (row.capture !== undefined || row.claim !== undefined)) throw new Error("Native capture fields require schema version 3");
    if (value.version !== 4 && (row.sources as Source[]).some(s => s.origin !== undefined)) throw new Error("Source entry origins require schema version 4");
    id(row.id); id(row.operation); date(row.createdAt); text(row.reason, 1024);
    const previous = latest.get(row.id);
    if (purgedIds.has(row.id) || row.revision !== (previous?.revision ?? 0) + 1 || operations.has(row.operation)) throw new Error("Invalid revision chain or duplicate operation");
    const assigning = previous?.scope === "unassigned" && previous.status === "candidate" && row.status === "candidate" && row.scope !== "unassigned";
    if (previous && ((!assigning && row.scope !== previous.scope) || row.kind !== previous.kind || row.author !== previous.author || canonical(row.legacy ?? null) !== canonical(previous.legacy ?? null))) throw new Error("Record identity cannot change");
    latest.set(row.id, row as unknown as Revision); operations.add(row.operation);
  }
  if (Buffer.byteLength(canonical(value)) > STORE_BYTES) throw new Error("Store exceeds 16 MiB; no originals were pruned");
}
export function decodeSnapshot(bytes: Buffer): Snapshot {
  if (bytes.length > STORE_BYTES) throw new Error("Store exceeds 16 MiB");
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  validateSnapshot(value); return value;
}
export function encodeTransfer(snapshot: Snapshot): string {
  validateSnapshot(snapshot);
  return canonical({ format: "pi-memory-transfer", version: 1, sha256: hash(canonical(snapshot)), snapshot });
}
export function decodeTransfer(bytes: Buffer): Snapshot {
  if (bytes.length > STORE_BYTES + 1024) throw new Error("Transfer exceeds limit");
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  object(value, ["format", "version", "sha256", "snapshot"]);
  if (value.format !== "pi-memory-transfer" || value.version !== 1) throw new Error("Unsupported transfer format");
  validateSnapshot(value.snapshot);
  if (value.sha256 !== hash(canonical(value.snapshot))) throw new Error("Transfer hash mismatch");
  return value.snapshot;
}
