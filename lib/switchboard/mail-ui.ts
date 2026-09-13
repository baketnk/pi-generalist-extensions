import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BoardRuntime } from "./runtime.ts";
import { plain, type Mail } from "./shared.ts";

export function mailLabel(m: Mail, now = Date.now()): string {
  const status = m.ackAt != null ? "acknowledged" : m.expiresAt <= now ? "expired" : m.fetchedAt != null ? "fetched · pending" : "unread";
  return plain(`${status} · ${m.kind} · from ${m.senderHandle ?? m.sender} · ${new Date(m.createdAt).toISOString()} · ${m.id}`);
}

/** No history entries, model delivery, fetched receipts, or acknowledgements. */
export async function openMail(ctx: ExtensionContext, runtime: BoardRuntime, recent: number,
  current: () => boolean, show: (mail: Mail) => Promise<void>) {
  if (!ctx.hasUI) return;
  while (current() && !runtime.closed) {
    const client = runtime.requireClient();
    const page = await client.call<{ pending: number; recent: number; messages: Mail[] }>("mail", { recent });
    if (!current() || runtime.closed) return;
    const choices = page.messages.map(m => mailLabel(m));
    const selected = await ctx.ui.select(`Mail — ${page.pending} pending + ${page.recent} recent (peek only)`, [...choices, "Refresh", "Close"]);
    if (!current() || runtime.closed || selected === undefined || selected === "Close") return;
    if (selected === "Refresh") continue;
    const mail = page.messages[choices.indexOf(selected)];
    if (!mail) return;
    const detail = await client.call<Mail>("peek", { id: mail.id });
    if (!current() || runtime.closed) return;
    await show(detail);
  }
}
