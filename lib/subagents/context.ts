import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { estimateTokens } from "./snapshot.ts";

// Separate from the output reserve and provider-estimation margin. This covers the
// appended synthesis instruction; it is never reclaimed for ordinary tool output.
export const SYNTHESIS_PROMPT_TOKENS = 1024;
export const CONTEXT_MARGIN = 2048;
export const CLIPPED_TOOL_OUTPUT = "\n[Tool output clipped for final-report context reserve. Full result retained in the private worker session.]";

/** Only call on a newly produced result, before persistence or any provider request.
 * The caller retains the original as a private custom entry. Never re-fit history.
 * Even the minimum marker may not fit if the assistant itself exhausted capacity;
 * the hard admission check must still reject that case honestly.
 */
export function boundToolResult(message: ToolResultMessage, tokens: number): ToolResultMessage {
  if (estimateTokens(message) <= tokens) return message;
  const text = message.content.filter(c => c.type === "text").map(c => c.text).join("\n");
  const clipped = (length: number): ToolResultMessage => ({ ...message,
    content: [{ type: "text", text: text.slice(0, length) + CLIPPED_TOOL_OUTPUT }],
    details: { contextClipped: true },
  });
  let low = 0, high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(clipped(mid)) <= tokens) low = mid;
    else high = mid - 1;
  }
  // Do not split a UTF-16 surrogate pair in the retained prefix.
  if (low && /[\uD800-\uDBFF]/.test(text[low - 1]!)) low--;
  return clipped(low);
}
