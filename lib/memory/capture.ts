import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { hash, type CaptureOrigin, type Source } from "./schema.ts";

export function operationId(value: string): string {
  const h = hash(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
/** The host has drained the current assistant message before tool execution. */
export function captureOrigin(ctx: ExtensionContext, toolCallId: string): CaptureOrigin {
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const message = entry.message;
    if (message.content.some(b => b.type === "toolCall" && b.id === toolCallId && b.name === "memory")) {
      return { harness: "pi", sessionId: ctx.sessionManager.getSessionId(), entryId: entry.id,
        toolCallId, provider: message.provider, model: message.model };
    }
  }
  throw new Error("Current host memory tool call not found; capture refused");
}
function sourceText(entry: SessionEntry): { author: "user" | "assistant"; text: string } | undefined {
  if (entry.type !== "message" || !["user", "assistant"].includes(entry.message.role)) return;
  const message = entry.message;
  if (message.role !== "user" && message.role !== "assistant") return;
  const text = typeof message.content === "string" ? message.content : message.content.filter(b => b.type === "text").map(b => b.text).join("\n");
  return text.trim() ? { author: message.role, text } : undefined;
}
export function sourceCatalog(ctx: ExtensionContext) {
  return ctx.sessionManager.getBranch().flatMap(entry => {
    const source = sourceText(entry);
    return source ? [{ entryId: entry.id, author: source.author, timestamp: entry.timestamp, bytes: Buffer.byteLength(source.text) }] : [];
  }).slice(-10);
}
/** Exact text-only current-branch excerpt. No thinking, summaries, images, tools or arbitrary paths. */
export function retainedSource(ctx: ExtensionContext, entryId: string, excerpt: string): Source {
  if (!excerpt.trim() || Buffer.byteLength(excerpt) > 4096) throw new Error("Source excerpt must be 1–4096 UTF-8 bytes");
  const entry = ctx.sessionManager.getBranch().find(e => e.id === entryId), source = entry && sourceText(entry);
  if (!entry || !source || !source.text.includes(excerpt)) throw new Error("Source is not an exact current-branch user/assistant text excerpt");
  return { id: operationId(`${ctx.sessionManager.getSessionId()}:${entry.id}:${hash(excerpt)}`), author: source.author,
    timestamp: entry.timestamp, precision: "instant", excerpt, sha256: hash(excerpt),
    origin: { harness: "pi", sessionId: ctx.sessionManager.getSessionId(), entryId: entry.id } };
}
