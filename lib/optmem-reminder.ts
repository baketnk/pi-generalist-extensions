import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const REMINDER_KEY = "generalist:optmem:reviewed";
export const REMINDER_TEXT = "OptMem reminder (extension-authored, not a new user request): Review this exchange for useful, durable, nonduplicate facts, preferences or decisions. If warranted, save them using memo note and complete any requested nap. Saving nothing is valid; do not invent a memory just to satisfy this reminder. Do not save secrets or routine tool logs. If you are a subagent, do not use memo. Do not resume project work, repeat the answer, or add a user-facing memory summary. Finish after this memory-only review.";

/** Full active branch, not compacted model context. Only the latest request counts.
 * Any note attempt suppresses reminders: a failed/timed-out write may have landed.
 */
export function reminderRequest(entries: readonly SessionEntry[]): string | undefined {
  let start = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "message" && entry.message.role === "user") {
      start = i;
      break;
    }
  }
  if (start < 0) return;
  const requestId = entries[start].id;
  for (const entry of entries.slice(start + 1)) {
    if (entry.type === "custom" && entry.customType === REMINDER_KEY &&
        (entry.data as { requestId?: unknown } | undefined)?.requestId === requestId) return;
    if (entry.type === "message" && entry.message.role === "assistant" &&
        entry.message.content.some(block => block.type === "toolCall" &&
          block.name === "memo" && Array.isArray(block.arguments.args) &&
          block.arguments.args[0] === "note")) return;
  }
  return requestId;
}
