import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { plain, type Card, type Mail } from "./shared.ts";

export interface SwitchboardDetails { action: string; result: unknown }

const text = (value: unknown) => plain(value === null || value === undefined || value === "" ? "—" : String(value)).replace(/\s+/g, " ");
const stamp = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? new Date(value).toLocaleString() : text(value);

function table(headers: string[], rows: unknown[][], caps: number[]): string {
  const widths = headers.map((header, column) => Math.min(caps[column]!, Math.max(visibleWidth(header), ...rows.map(row => visibleWidth(text(row[column]))))));
  const row = (cells: unknown[]) => cells.map((cell, column) => {
    const clipped = truncateToWidth(text(cell), widths[column]!, "…");
    return clipped + " ".repeat(Math.max(0, widths[column]! - visibleWidth(clipped)));
  }).join("  ").trimEnd();
  return [row(headers), widths.map(width => "─".repeat(width)).join("  "), ...rows.map(row)].join("\n");
}

function cards(items: Card[]): string {
  if (!items.length) return "No registered peers";
  return table(["Handle", "Name", "Model", "Activity", "Location"], items.map(card => [card.handle ?? card.id, card.name === card.handle ? "" : card.name, card.model, card.activity, (card as Card & { location?: string }).location ?? card.worktree]), [35, 24, 36, 18, 30]);
}

function messages(items: Mail[]): string {
  if (!items.length) return "No messages";
  return table(["ID", "Kind", "From", "Received", "State"], items.map(mail => [mail.id, mail.kind, mail.senderHandle ?? mail.sender, stamp(mail.createdAt), mail.ackAt ? "acknowledged" : mail.fetchedAt ? "read" : "new"]), [24, 10, 35, 22, 14]);
}

function card(value: Card): string {
  return [
    `${value.handle ?? value.id}${value.name && value.name !== value.handle ? ` · ${value.name}` : ""}  (${value.id})`,
    `${value.activity} · ${value.type}${value.parentId ? ` · parent ${value.parentId}` : ""}`,
    `Model: ${value.model || "not reported"}`,
    value.summary || "No status summary",
    `Project: ${value.project}`,
    `Working directory: ${value.cwd}`,
  ].join("\n");
}

function mail(value: Mail): string {
  const lines = [
    `${value.kind.toUpperCase()}  ${value.id}`,
    `From: ${value.senderHandle ?? value.sender}`,
    `To: ${value.recipientHandle ?? value.recipient}`,
    `Sent: ${stamp(value.createdAt)}`,
    `State: ${value.ackAt ? "acknowledged" : value.fetchedAt ? "read" : "new"}`,
  ];
  if (value.replyTo) lines.push(`Reply to: ${value.replyTo}`);
  if ("body" in value) lines.push("", value.body === null ? "Message body expired" : value.body || "(empty message)");
  return lines.join("\n");
}

function fields(value: Record<string, unknown>): string {
  const entries = Object.entries(value);
  if (!entries.length) return "Done";
  return entries.map(([key, item]) => `${key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ")}: ${text(item)}`).join("\n");
}

export function formatSwitchboard(action: string, value: unknown): string {
  if (action === "read" && value && typeof value === "object" && "empty" in value && value.empty === true) return "No pending messages";
  if (action === "diagnostic" && typeof value === "string") return plain(value);
  if (action === "peers" && value && typeof value === "object") {
    const result = value as { peers?: Card[]; total?: number; omitted?: number };
    const heading = `${result.total ?? result.peers?.length ?? 0} registered peer(s)${result.omitted ? ` · ${result.omitted} omitted` : ""}`;
    return `${heading}\n\n${cards(result.peers ?? [])}`;
  }
  if (action === "roster" && value && typeof value === "object") {
    const result = value as { self?: Card; peers?: Card[]; total?: number };
    return [`This session`, result.self ? card(result.self) : "Unavailable", "", `${result.total ?? result.peers?.length ?? 0} registered peer(s)`, cards(result.peers ?? [])].join("\n");
  }
  if ((action === "inbox" || action === "mail-list") && value && typeof value === "object") {
    const list = Array.isArray(value) ? value as Mail[] : (value as { messages?: Mail[] }).messages ?? [];
    return messages(list);
  }
  if (["inspect", "status"].includes(action) && value && typeof value === "object" && "name" in value) return card(value as Card);
  if (["read", "ack", "delivery", "send", "reply", "retry"].includes(action) && value && typeof value === "object" && "sender" in value) return mail(value as Mail);
  if (action === "wait" && value && typeof value === "object") {
    const result = value as { reason?: unknown; pending?: unknown; note?: unknown };
    return `Wait ended: ${text(result.reason)}\nPending messages: ${text(result.pending)}${result.note ? `\n${text(result.note)}` : ""}`;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) return fields(value as Record<string, unknown>);
  return text(value);
}
