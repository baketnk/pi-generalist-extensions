import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "@earendil-works/pi-coding-agent";

export const SNAPSHOT = "workpad-snapshot-v2";
export interface Snapshot {
  epoch: string;
  position: number;
  anchor: string;
  key: string;
  content: string;
  timestamp: number;
  reset?: boolean;
}
export const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Materialize a durable append-only journal at its original message boundaries.
 * Custom entries persist the snapshots without sendMessage queue timing changing
 * their position relative to an assistant response or a parallel tool batch.
 * Compaction starts a fresh epoch; no rewriting of older snapshots is needed.
 */
export function snapshotContext(
  input: AgentMessage[], journal: Snapshot[], epoch: string,
  desired: { key: string; content: string } | undefined,
  refreshTokens: number | undefined,
  save: (snapshot: Snapshot) => void,
  namespace?: { type: string; legacyTypes?: string[]; prefix?: string },
): AgentMessage[] {
  // These are our request projections, not transcript messages. Strip only our
  // types if another context hook passes a prior projection back to us.
  const customType = namespace?.type ?? SNAPSHOT;
  const ownedTypes = new Set([customType, ...(namespace?.legacyTypes ?? (namespace ? [] : ["workpad-context-v1"]))]);
  const messages = input.filter(m => !(m.role === "custom" && ownedTypes.has(m.customType)));
  if (!desired && !journal.length) return messages;
  const hash = createHash("sha256");
  const anchors = [hash.copy().digest("hex")];
  for (const message of messages) {
    hash.update(JSON.stringify(message)).update("\n");
    anchors.push(hash.copy().digest("hex"));
  }
  const current = journal.filter(s => s.epoch === epoch);
  let start = 0;
  for (let i = current.length - 1; i >= 0; i--) if (current[i]!.reset) { start = i; break; }
  const candidates = current.slice(start);
  const matches = candidates.filter(s => Number.isSafeInteger(s.position) &&
    s.position >= 0 && s.position <= messages.length && anchors[s.position] === s.anchor &&
    typeof s.key === "string" && typeof s.content === "string" && Number.isFinite(s.timestamp));
  // If another component rewrites/trims context, abandon this projection as a
  // unit. Persist the reset so restoring the old input cannot resurrect stale
  // snapshots after a newer one at a shorter boundary.
  const reset = matches.length !== candidates.length;
  const valid = reset ? [] : matches;
  const last = valid.at(-1);
  const reminder = !!last && !!refreshTokens &&
    messages.slice(last.position).reduce((total, m) => total + estimateTokens(m), 0) >= refreshTokens;
  if (desired && (!last || last.key !== desired.key || reminder)) {
    const snapshot: Snapshot = {
      epoch, position: messages.length, anchor: anchors[messages.length]!,
      key: desired.key,
      content: `${namespace?.prefix ?? (last?.key === desired.key ? "Workpad reminder (same revision). " : "Workpad state update. ")}${desired.content}`,
      timestamp: Date.now(), reset,
    };
    save(snapshot); // Persist before returning the projection, including retries.
    valid.push(snapshot);
  }
  const at = new Map<number, Snapshot[]>();
  for (const snapshot of valid) {
    const group = at.get(snapshot.position) ?? [];
    group.push(snapshot); at.set(snapshot.position, group);
  }
  const result: AgentMessage[] = [];
  for (let i = 0; i <= messages.length; i++) {
    for (const snapshot of at.get(i) ?? []) result.push({
      role: "custom", customType, content: snapshot.content,
      timestamp: snapshot.timestamp, display: false,
    });
    if (i < messages.length) result.push(messages[i]!);
  }
  return result;
}
