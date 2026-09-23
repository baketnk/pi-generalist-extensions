import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loopLimit, validLoopLimit } from "../lib/loop-config.ts";

function parseLoop(args: string | string[], defaultLimit: number): { prompt: string; limit: number } | undefined {
  const text = (Array.isArray(args) ? args.join(" ") : args).trim();
  const match = /^([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return undefined;
  const first = match[1];
  const numbered = /^[+-]?\d+(?:\.\d+)?$/.test(first);
  const limit = numbered ? Number(first) : defaultLimit;
  const prompt = (numbered ? match[2] ?? "" : text).trim();
  if (!prompt || !validLoopLimit(limit)) return undefined;
  return { prompt, limit };
}

const LOOP_STATUS = "generalist-loop";

function showProgress(ctx: ExtensionContext, current: number, total: number): void {
  if (ctx.hasUI) ctx.ui.setStatus(LOOP_STATUS, `loop:${current}/${total}`);
}

/** One awaited prompt per fresh session; never send through a stale extension API after a switch. */
export default function loop(pi: ExtensionAPI) {
  pi.registerCommand("loop", {
    description: "Repeat a prompt in fresh sessions: /loop [count] <prompt> (default count set in /generalist loop)",
    handler: async (args, ctx) => {
      const parsed = parseLoop(args, loopLimit(ctx));
      if (!parsed) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /loop [count 1–1000] <prompt>", "warning");
        return;
      }
      if (!ctx.isIdle()) {
        if (ctx.hasUI) ctx.ui.notify("Wait for the current response before starting /loop.", "warning");
        return;
      }
      let current: ExtensionCommandContext = ctx;
      try {
        for (let i = 0; i < parsed.limit; i++) {
          showProgress(current, i + 1, parsed.limit);
          const parentSession = current.sessionManager.getSessionFile();
          let completed = false;
          const result = await current.newSession({
            ...(parentSession ? { parentSession } : {}),
            withSession: async replacement => {
              current = replacement;
              showProgress(replacement, i + 1, parsed.limit); // Session replacement rebinds the UI.
              await replacement.sendUserMessage(parsed.prompt);
              const lastAssistant = replacement.sessionManager.getBranch().filter(entry =>
                entry.type === "message" && entry.message.role === "assistant").at(-1);
              completed = lastAssistant?.type === "message" && lastAssistant.message.role === "assistant"
                && lastAssistant.message.stopReason === "stop";
            },
          });
          if (result.cancelled || !completed) {
            if (current.hasUI) current.ui.notify(`Loop stopped after ${i + (result.cancelled ? 0 : 1)} of ${parsed.limit} sessions.`, "warning");
            return;
          }
        }
        if (current.hasUI) current.ui.notify(`Loop finished: ${parsed.limit} sessions.`, "info");
      } finally {
        // A failed replacement can make the last context stale; do not mask that error.
        try { if (current.hasUI) current.ui.setStatus(LOOP_STATUS, undefined); } catch {}
      }
    },
  });
}
