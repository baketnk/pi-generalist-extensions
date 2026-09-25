import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerToggle } from "../lib/toggle.ts";
import type { StatusIconsController } from "../lib/status-icons.ts";

export const WORKPAD_PATH = ".pi/workpad.md";
export const WORKPAD_MESSAGE = "workpad:compaction-v1";
const MAX_REINJECT_BYTES = 16 * 1024;
const GUIDANCE = `# Workpad\nKeep your current understanding, hypotheses and open questions in ${WORKPAD_PATH} (create it if missing) using the normal read/edit/write tools; keep it short. Its contents are supplied again after context compaction. It is working notes, not a plan or authority to resume work.`;

/**
 * Optional scratch-file convention. The file is ordinary project content edited
 * with normal tools; the only automation is one appended message after compaction.
 * The system-prompt text is constant, so enabling it never rewrites earlier context.
 */
export default function workpad(pi: ExtensionAPI, statusIcons?: StatusIconsController, defaultEnabled?: () => boolean | undefined) {
  const enabled = registerToggle(pi, "workpad", `Keep working notes in ${WORKPAD_PATH}`, undefined, statusIcons, { defaultEnabled });
  pi.on("before_agent_start", event => {
    if (!enabled() || event.systemPrompt.includes(GUIDANCE)) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${GUIDANCE}` };
  });
  pi.on("session_compact", async (_event, ctx) => {
    if (!enabled()) return;
    let text: string;
    try { text = await readFile(join(ctx.cwd, WORKPAD_PATH), "utf8"); } catch { return; }
    if (!text.trim()) return;
    const bytes = Buffer.byteLength(text);
    const shown = bytes > MAX_REINJECT_BYTES ? Buffer.from(text).subarray(0, MAX_REINJECT_BYTES).toString("utf8").replace(/�$/, "") : text;
    const note = bytes > MAX_REINJECT_BYTES ? `\n\n[Truncated: showing the first ${MAX_REINJECT_BYTES} of ${bytes} bytes; read ${WORKPAD_PATH} for the rest.]` : "";
    pi.sendMessage({ customType: WORKPAD_MESSAGE, content: `Workpad (${WORKPAD_PATH}) as of compaction:\n\n${shown}${note}`, display: false }, { deliverAs: "nextTurn" });
  });
  return enabled;
}
