import { createReadStream, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Session, Source, Message } from "./types.ts";

export function sessionKey(source: Source, id: string): string {
  return createHash("sha256").update(`${source.harness}\0${source.path}\0${id}`).digest("hex").slice(0, 24);
}
export function visibleText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(b => b && ["text", "input_text", "output_text"].includes(b.type) && typeof b.text === "string")
    .map(b => b.text).join("\n");
}
function timestamp(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return new Date(value < 1e11 ? value * 1000 : value).toISOString();
  return "";
}
function makeSession(source: Source, id: string, cwd: string, time: unknown): Session {
  return { key: sessionKey(source, id), nativeId: id, harness: source.harness, path: source.path,
    cwd, title: "", time: timestamp(time), tree: source.harness === "pi" || source.harness === "omp",
    nodes: new Map(), messages: [], warnings: [] };
}

export async function parseJsonl(source: Source, includeTools = false, signal?: AbortSignal): Promise<Session[]> {
  if (statSync(source.path).size > 512 * 1024 * 1024) throw new Error("Source exceeds 512 MiB per-file bound");
  let session: Session | undefined, lineNumber = 0, malformed = 0, previous: string | null = null;
  const stream = createReadStream(source.path, { encoding: "utf8", signal });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const raw of reader) {
      signal?.throwIfAborted(); lineNumber++;
      if (!raw.trim()) continue;
      if (Buffer.byteLength(raw) > 16 * 1024 * 1024) { malformed++; continue; }
      let entry: any;
      try { entry = JSON.parse(raw.replace(/^\uFEFF/, "")); } catch { malformed++; continue; }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) { malformed++; continue; }
      if (["session", "session_header", "header", "session_meta"].includes(entry.type)) {
        const header = entry.payload || entry;
        if (!session && typeof (header.id || header.session_id) === "string")
          session = makeSession(source, header.id || header.session_id, header.cwd || "", header.timestamp || entry.timestamp);
        continue;
      }
      if (!session) continue;
      const id = String(entry.id || `line:${lineNumber}`);
      const parent = session.tree && Object.hasOwn(entry, "parentId") ? (typeof entry.parentId === "string" ? entry.parentId : null) : previous;
      if (session.tree) { session.nodes.set(id, parent); previous = id; }
      let role = "", kind: Message["kind"] = "prose", text = "";
      if (entry.type === "session_info" && typeof entry.name === "string") session.title = entry.name;
      if (source.harness === "codex") {
        // event_msg repeats response_item text. Never index it twice.
        if (entry.type === "response_item") {
          const p = entry.payload || {};
          if (p.type === "message" && ["user", "assistant"].includes(p.role) && !["analysis", "reasoning"].includes(p.channel)) {
            role = p.role; text = visibleText(p.content);
          } else if (includeTools && ["function_call_output", "custom_tool_call_output"].includes(p.type)) {
            role = "tool"; kind = "tool"; text = visibleText(p.output);
          }
        } else if (entry.type === "compacted") {
          role = "summary"; kind = "summary"; text = visibleText(entry.payload?.message);
        }
      } else if (entry.type === "message") {
        const m = entry.message || {};
        if (["user", "assistant"].includes(m.role) && !["analysis", "reasoning"].includes(m.channel)) {
          role = m.role; text = visibleText(m.content);
          if (!text && includeTools && m.role === "assistant" && Array.isArray(m.content)) {
            const calls = m.content.filter((b: any) => b.type === "toolCall");
            if (calls.length) { kind = "tool"; text = JSON.stringify(calls); }
          }
        } else if (includeTools && ["toolResult", "tool"].includes(m.role)) {
          role = "tool"; kind = "tool"; text = visibleText(m.content);
        }
      } else if (["compaction", "branch_summary"].includes(entry.type)) {
        role = "summary"; kind = "summary"; text = visibleText(entry.summary);
      }
      if (text.trim()) {
        // Codex IDs may be null or reused across display representations. The
        // source line is a stable locator until rewrite; source signatures guard it.
        const messageId = source.harness === "codex" ? `line:${lineNumber}` : id;
        session.messages.push({ id: messageId, parent, seq: lineNumber, role,
          kind, text, time: timestamp(entry.timestamp || entry.message?.timestamp), locator: `line:${lineNumber}` });
        if (!session.tree) { session.nodes.set(messageId, previous); previous = messageId; }
      }
    }
  } finally { reader.close(); stream.destroy(); }
  if (!session) throw new Error("No supported session header (possibly a partial write)");
  if (malformed) session.warnings.push(`${malformed} malformed/oversized lines skipped (possibly a live partial write)`);
  return [session];
}

export function parseHermes(source: Source, includeTools = false, onlySession?: string): Session[] {
  const db = new DatabaseSync(source.path, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000");
    const columns = new Set((db.prepare("PRAGMA table_info(messages)").all() as any[]).map(r => r.name));
    for (const required of ["id", "session_id", "role", "content", "timestamp"])
      if (!columns.has(required)) throw new Error(`Unsupported Hermes schema: missing ${required}`);
    const sessionColumns = new Set((db.prepare("PRAGMA table_info(sessions)").all() as any[]).map(r => r.name));
    const active = columns.has("active") ? " AND active=1" : "";
    const summary = columns.has("_compressed_summary") ? "_compressed_summary" : "0";
    const query = db.prepare(`SELECT id,role,content,timestamp,${summary} AS summary FROM messages
      WHERE session_id=?${active} AND role IN ('user','assistant'${includeTools ? ",'tool'" : ""}) ORDER BY id`);
    // One read transaction is a consistent WAL snapshot; never open Hermes code.
    db.exec("BEGIN");
    const sessions = db.prepare(`SELECT id,${sessionColumns.has("cwd") ? "cwd" : "''"} AS cwd,
      ${sessionColumns.has("title") ? "title" : "''"} AS title,started_at FROM sessions${onlySession ? " WHERE id=?" : ""}`)
      .all(...(onlySession ? [onlySession] : [])) as any[];
    const result = sessions.map(row => {
      const s = makeSession(source, row.id, row.cwd || "", row.started_at); s.title = row.title || "";
      let previous: string | null = null;
      for (const m of query.iterate(row.id) as Iterable<any>) {
        let content = m.content;
        if (typeof content === "string" && content.trimStart().startsWith("[")) {
          try { const parsed = JSON.parse(content); if (Array.isArray(parsed)) content = parsed; } catch { /* literal prose */ }
        }
        const text = visibleText(content);
        if (!text.trim()) continue;
        const id = String(m.id);
        s.messages.push({ id, parent: previous, seq: Number(m.id), role: m.role,
          kind: m.role === "tool" ? "tool" : m.summary ? "summary" : "prose",
          time: timestamp(m.timestamp), text, locator: `messages.id=${id}` });
        s.nodes.set(id, previous); previous = id;
      }
      return s;
    });
    db.exec("COMMIT"); return result;
  } finally { db.close(); }
}

/** Latest-recorded ancestry, not an assertion of a running harness's live leaf. */
export function branchMessages(session: Session, leaf?: string): Message[] {
  if (!session.tree) return session.messages;
  const end = leaf || [...session.nodes.keys()].at(-1);
  if (end && !session.nodes.has(end)) throw new Error("Unknown entry ID for this session");
  const path = new Set<string>(); let cursor: string | null | undefined = end;
  while (cursor) {
    if (path.has(cursor)) throw new Error("Cycle in session ancestry");
    path.add(cursor);
    if (!session.nodes.has(cursor)) { session.warnings.push(`Missing ancestor ${cursor}`); break; }
    cursor = session.nodes.get(cursor);
  }
  return session.messages.filter(m => path.has(m.id));
}
