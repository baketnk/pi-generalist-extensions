import { stripVTControlCharacters } from "node:util";
import type { Theme, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface HistoryMatch {
  harness: string; time: string; role: string; cwd: string; title: string;
  excerpt: string; path: string; locator: string; session: string; entry: string;
  sourceChanged: boolean; sourceWarnings: string[];
}
export interface HistoryContext {
  branch: string; warnings: string[];
  sourceChangedSinceIndex: boolean; sourceChangedDuringRead: boolean;
  messages: Array<{ id: string; role: string; time: string; text: string; textTruncated?: boolean }>;
}
type ContextLoader = (match: HistoryMatch, signal: AbortSignal) => Promise<HistoryContext>;

// History is untrusted terminal input, not renderable ANSI/OSC markup.
export const plain = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const cell = (text: string, width: number) => {
  const clipped = truncateToWidth(plain(text).replace(/\s+/g, " "), width);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
};

/** Ephemeral display only: no session writes, editor injection, or model calls. */
export class HistoryPanel {
  private selected = 0;
  private detail = false;
  private scroll = 0;
  private pageSize = 8;
  private maxScroll = 0;
  private context?: HistoryContext;
  private contextError = "";
  private contextAbort?: AbortController;
  private contextRequest = 0;
  constructor(private query: string, private results: HistoryMatch[], private status: string,
    private theme: Theme, private keys: KeybindingsManager, private height: () => number,
    private redraw: () => void, private close: () => void, private loadContext?: ContextLoader) {}
  invalidate() {}
  private leaveDetail() {
    this.detail = false; this.scroll = 0; this.context = undefined; this.contextError = "";
    this.contextRequest++; this.contextAbort?.abort(); this.contextAbort = undefined;
  }
  private enterDetail() {
    const item = this.results[this.selected];
    if (!item) return;
    this.detail = true; this.scroll = 0; this.context = undefined; this.contextError = "";
    if (!this.loadContext) return;
    const request = ++this.contextRequest;
    this.contextAbort?.abort();
    const abort = this.contextAbort = new AbortController();
    this.loadContext(item, abort.signal).then(context => {
      if (request !== this.contextRequest || abort.signal.aborted) return;
      this.context = context; this.contextAbort = undefined; this.redraw();
    }).catch(error => {
      if (request !== this.contextRequest || abort.signal.aborted) return;
      this.contextError = error instanceof Error ? error.message : String(error);
      this.contextAbort = undefined; this.redraw();
    });
  }
  handleInput(data: string) {
    if (this.keys.matches(data, "tui.select.cancel")) {
      if (this.detail) this.leaveDetail(); else { this.close(); return; }
    } else if (this.keys.matches(data, "tui.select.confirm") && this.results.length) {
      if (this.detail) this.leaveDetail(); else this.enterDetail();
    } else {
      const delta = this.keys.matches(data, "tui.select.up") ? -1
        : this.keys.matches(data, "tui.select.down") ? 1
        : this.keys.matches(data, "tui.select.pageUp") ? -this.pageSize
        : this.keys.matches(data, "tui.select.pageDown") ? this.pageSize : 0;
      if (this.detail) this.scroll = Math.max(0, Math.min(this.maxScroll, this.scroll + delta));
      else this.selected = Math.max(0, Math.min(this.results.length - 1, this.selected + delta));
    }
    this.redraw();
  }
  private detailText(item: HistoryMatch): string {
    const heading = `CONTEXT — result ${this.selected + 1} of ${this.results.length}`;
    const metadata = [
      heading, `${item.time} | ${item.harness} | ${item.role}`, item.title || item.cwd,
      `${item.path} (${item.locator})`, `Session: ${item.session}  Entry: ${item.entry}`,
      ...(item.sourceChanged ? ["Warning: source changed since indexing"] : []),
      ...item.sourceWarnings,
    ];
    if (this.contextError) return [...metadata, "", `Could not load context: ${this.contextError}`, "", item.excerpt].map(plain).join("\n");
    if (!this.loadContext) return [...metadata, "", item.excerpt].map(plain).join("\n");
    if (!this.context) return [...metadata, "", "Loading conversation context…"].map(plain).join("\n");
    const warnings = [
      ...this.context.warnings,
      ...(this.context.sourceChangedSinceIndex ? ["Warning: source changed since indexing"] : []),
      ...(this.context.sourceChangedDuringRead ? ["Warning: source changed while context was read"] : []),
    ];
    const messages = this.context.messages.flatMap(message => [
      `${message.id === item.entry ? "→" : " "} ${message.time || "unknown time"} | ${message.role}${message.textTruncated ? " | truncated" : ""}`,
      message.text,
      "",
    ]);
    return [...metadata, `Branch: ${this.context.branch}`, ...warnings, "", ...messages].map(plain).join("\n");
  }
  render(width: number): string[] {
    const height = Math.max(1, Math.floor(this.height() * 0.8));
    const framed = width >= 4 && height >= 3;
    const w = Math.max(1, width - (framed ? 4 : 2));
    const bodyHeight = Math.max(1, height - (framed ? 2 : 0));
    this.pageSize = Math.max(1, bodyHeight - 4);
    const mode = this.detail ? "context" : "results";
    const lines = [this.theme.fg("accent", `History ${mode} — ${plain(this.query) || "recent messages"}`)];
    const item = this.results[this.selected];
    if (this.detail && item) {
      const wrapped = wrapTextWithAnsi(this.detailText(item), w);
      this.maxScroll = Math.max(0, wrapped.length - this.pageSize);
      this.scroll = Math.min(this.scroll, this.maxScroll);
      lines.push(...wrapped.slice(this.scroll, this.scroll + this.pageSize));
    } else {
      const wide = w >= 75;
      const row = (r: HistoryMatch) => wide
        ? `${cell(r.time.slice(0, 10), 10)} ${cell(r.harness, 6)} ${cell(r.role, 9)} ${cell(r.cwd.split("/").filter(Boolean).pop() || "—", 16)} ${plain(r.excerpt).replace(/\s+/g, " ")}`
        : `${r.harness} | ${plain(r.excerpt).replace(/\s+/g, " ")}`;
      lines.push(this.theme.fg("muted", wide ? "  DATE       AGENT  ROLE      PROJECT          EXCERPT" : "  AGENT | EXCERPT"));
      const start = Math.floor(this.selected / this.pageSize) * this.pageSize;
      for (let i = start; i < Math.min(this.results.length, start + this.pageSize); i++) {
        const text = `${i === this.selected ? "› " : "  "}${row(this.results[i]!)}`;
        lines.push(i === this.selected ? this.theme.fg("accent", text) : text);
      }
      if (!this.results.length) lines.push("No matches.");
    }
    lines.push(this.theme.fg("dim", `${this.results.length} matches (max 20) · ${plain(this.status)} · historical, not live status`));
    const hint = (action: Parameters<KeybindingsManager["getKeys"]>[0]) => this.keys.getKeys(action).join("/");
    lines.push(this.theme.fg("dim", `${hint("tui.select.up")}/${hint("tui.select.down")} ${this.detail ? "scroll" : "move"} · ${hint("tui.select.confirm")} ${this.detail ? "back" : "open context"} · ${hint("tui.select.cancel")} ${this.detail ? "back" : "close"} · not sent to model`));
    const body = lines.slice(0, bodyHeight).map(line => truncateToWidth(line, w));
    if (!framed) return body.map(line => truncateToWidth(line, width));
    const border = (text: string) => this.theme.fg("borderAccent", text);
    const top = border(`┌${"─".repeat(Math.max(0, width - 2))}┐`);
    const bottom = border(`└${"─".repeat(Math.max(0, width - 2))}┘`);
    const rows = body.map(line => {
      const padding = " ".repeat(Math.max(0, w - visibleWidth(line)));
      return `${border("│")} ${line}${padding} ${border("│")}`;
    });
    return [top, ...rows, bottom];
  }
}
