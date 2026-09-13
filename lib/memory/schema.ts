import { createHash } from "node:crypto";

export const STORE_BYTES = 1024 * 1024;
export const MAX_REVISIONS = 128;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type Scope = `project:${string}` | `personal:${string}`;
export interface Source {
  // Caller-declared provenance, not host-verified transcript provenance.
  id: string; author: "user" | "assistant" | "import";
  timestamp: string; excerpt: string; sha256: string;
}
export interface Note {
  scope: Scope; kind: "fact" | "thread" | "reflection";
  title: string; body: string; author: "user" | "assistant" | "import";
  status: "candidate" | "accepted" | "retracted";
  threadStatus?: "open" | "dormant" | "resolved" | "dismissed";
  sources: Source[];
}
export interface Revision extends Note {
  id: string; revision: number; createdAt: string; reason: string;
  operation: string;
}
export interface Snapshot { format: "pi-memory-prototype"; version: 1; storeId: string; revisions: Revision[] }
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
  if (typeof value !== "string" || !/^(project|personal):/.test(value)) throw new Error("Explicit project/personal scope required");
  id(value.slice(value.indexOf(":") + 1));
}
const noteKeys = ["scope", "kind", "title", "body", "author", "status", "threadStatus", "sources"];
function fields(value: Record<string, unknown>) {
  scope(value.scope); text(value.title, 240); text(value.body, 8192);
  if (!["fact", "thread", "reflection"].includes(value.kind as string) || !["user", "assistant", "import"].includes(value.author as string) || !["candidate", "accepted", "retracted"].includes(value.status as string)) throw new Error("Invalid note classification");
  if (value.kind === "thread" ? !["open", "dormant", "resolved", "dismissed"].includes(value.threadStatus as string) : value.threadStatus !== undefined) throw new Error("Invalid thread status");
  if (!Array.isArray(value.sources) || value.sources.length > 8) throw new Error("At most eight retained sources");
  const ids = new Set();
  for (const source of value.sources) {
    object(source, ["id", "author", "timestamp", "excerpt", "sha256"]);
    id(source.id); date(source.timestamp); text(source.excerpt, 8192);
    if (!["user", "assistant", "import"].includes(source.author as string) || source.sha256 !== hash(source.excerpt as string) || ids.has(source.id)) throw new Error("Invalid source author, duplicate ID or hash mismatch");
    ids.add(source.id);
  }
  if (Buffer.byteLength(canonical(value)) > 32768) throw new Error("Revision exceeds 32 KiB");
}
export function validateNote(value: unknown): asserts value is Note { object(value, noteKeys); fields(value); }
export function validateSnapshot(value: unknown): asserts value is Snapshot {
  object(value, ["format", "version", "storeId", "revisions"]);
  if (value.format !== "pi-memory-prototype" || value.version !== 1) throw new Error("Unsupported store format");
  id(value.storeId);
  if (!Array.isArray(value.revisions) || value.revisions.length > MAX_REVISIONS) throw new Error("Revision quota exceeded");
  const latest = new Map<string, Revision>(), operations = new Set<string>();
  for (const row of value.revisions) {
    object(row, [...noteKeys, "id", "revision", "createdAt", "reason", "operation"]); fields(row);
    id(row.id); id(row.operation); date(row.createdAt); text(row.reason, 1024);
    const previous = latest.get(row.id);
    if (row.revision !== (previous?.revision ?? 0) + 1 || operations.has(row.operation)) throw new Error("Invalid revision chain or duplicate operation");
    if (previous && (row.scope !== previous.scope || row.kind !== previous.kind || row.author !== previous.author)) throw new Error("Record identity cannot change");
    latest.set(row.id, row as unknown as Revision); operations.add(row.operation);
  }
  if (Buffer.byteLength(canonical(value)) > STORE_BYTES) throw new Error("Store exceeds 1 MiB; no originals were pruned");
}
export function decodeSnapshot(bytes: Buffer): Snapshot {
  if (bytes.length > STORE_BYTES) throw new Error("Store exceeds 1 MiB");
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
