import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { LIMITS, type ContextSnapshotEvent, type ForkSnapshot } from "./types.ts";

export const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Never repair a half tool batch by fabricating results. */
export function completeMessages(messages: AgentMessage[]): void {
  const pending = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "toolResult") {
      if (pending.get(message.toolCallId) !== message.toolName) throw new Error("Fork has an orphan or mismatched tool result.");
      pending.delete(message.toolCallId);
    } else {
      if (pending.size) throw new Error("Fork boundary splits a tool batch.");
      if (message.role === "assistant") for (const part of message.content) if (part.type === "toolCall") {
        if (pending.has(part.id)) throw new Error("Duplicate tool call in fork.");
        pending.set(part.id, part.name);
      }
    }
  }
  if (pending.size) throw new Error("Fork boundary has unfinished tools.");
}

/** Exact post-context-hook messages; no live source reads or activation replay. */
export function freezeSnapshot(event: ContextSnapshotEvent, session: string, branch: SessionEntry[]): ForkSnapshot {
  if (event.contextErrors) throw new Error("Cannot fork a context with failed transformations.");
  if (!event.leafId || !branch.some(e => e.id === event.leafId)) throw new Error("Snapshot anchor is not on this branch.");
  completeMessages(event.messages);
  if (Buffer.byteLength(JSON.stringify(event.messages)) > LIMITS.snapshotBytes) throw new Error("Fork snapshot exceeds 2 MiB; no silent truncation.");
  const protectedKinds = new Set<string>();
  for (const message of event.messages) {
    if (message.role === "custom" && !["workpad-snapshot-v2", "switchboard:observation:v1", "subagents:observation:v1"].includes(message.customType)) protectedKinds.add(message.customType);
    if (message.role === "toolResult" && ["memory", "continuity", "history_read", "history_search"].includes(message.toolName)) protectedKinds.add(message.toolName);
    if (message.role === "compactionSummary" || message.role === "branchSummary") protectedKinds.add("summary-may-contain-private-history");
  }
  const messages = structuredClone(event.messages);
  return { version: 1, session, anchor: event.leafId, timestamp: Date.now(), digest: hash(messages), messages,
    protectedKinds: [...protectedKinds], providerRequestHooks: event.providerRequestHooks };
}

/** Bounded runtime shelf: historical anchors only where a real snapshot was observed. */
export class SnapshotShelf {
  private snapshots: ForkSnapshot[] = [];
  error?: string;
  capture(event: ContextSnapshotEvent, session: string, branch: SessionEntry[]) {
    try {
      const snapshot = freezeSnapshot(event, session, branch);
      this.snapshots = this.snapshots.filter(s => s.session !== session || s.anchor !== snapshot.anchor);
      this.snapshots.push(snapshot);
      while (this.snapshots.length > 8 || Buffer.byteLength(JSON.stringify(this.snapshots)) > 8 * 1024 * 1024) this.snapshots.shift();
      this.error = undefined;
    } catch (e) { this.error = String(e); }
  }
  list() { return this.snapshots.map(({ messages, ...snapshot }) => ({ ...snapshot, messageCount: messages.length })); }
  select(session: string, branch: SessionEntry[], anchor?: string): ForkSnapshot {
    if (!anchor && this.error) throw new Error(`Latest request has no safe fork snapshot: ${this.error}`);
    const ids = new Set(branch.map(e => e.id));
    const candidates = this.snapshots.filter(s => s.session === session && ids.has(s.anchor));
    const selected = anchor ? candidates.find(s => s.anchor === anchor) : candidates.at(-1);
    if (!selected) throw new Error(this.error ?? "No observed fork checkpoint. Fork requires Pi's context_snapshot hook and a captured request on this branch; choose fresh explicitly or a listed checkpoint.");
    return structuredClone(selected);
  }
}
