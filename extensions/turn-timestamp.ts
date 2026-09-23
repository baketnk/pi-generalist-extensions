import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function formatTurnTimestamp(date: Date): string {
  return `Turn ended: ${date.toISOString()}`;
}

/** Print a timestamp only after Pi has exhausted every automatic continuation. */
export default function turnTimestamp(pi: ExtensionAPI, now = () => new Date()) {
  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.notify(formatTurnTimestamp(now()), "info");
  });
}
