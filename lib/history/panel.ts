import { stripVTControlCharacters } from "node:util";
import type { Theme, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface HistoryMatch {
  harness: string; time: string; role: string; cwd: string; title: string;
  excerpt: string; path: string; locator: string; session: string; entry: string;
  sourceChanged: boolean; sourceWarnings: string[];
}
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
  constructor(private query: string, private results: HistoryMatch[], private status: string,
    private theme: Theme, private keys: KeybindingsManager, private height: () => number,
    private redraw: () => void, private close: () => void) {}
  invalidate() {}
  handleInput(data: string) {
    if (this.keys.matches(data, "tui.select.cancel")) {
      if (this.detail) { this.detail = false; this.scroll = 0; } else { this.close(); return; }
    } else if (this.keys.matches(data, "tui.select.confirm") && this.results.length) {
      this.detail = !this.detail; this.scroll = 0;
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
  render(width: number): string[] {
    const w = Math.max(1, width - 2);
    const height = Math.max(1, Math.floor(this.height() * 0.8));
    this.pageSize = Math.max(1, height - 5);
    const lines = [this.theme.fg("accent", `History — ${plain(this.query) || "recent messages"}`)];
    const item = this.results[this.selected];
    if (this.detail && item) {
      const text = [
        `${item.time} | ${item.harness} | ${item.role}`, item.title || item.cwd,
        `${item.path} (${item.locator})`, `Session: ${item.session}  Entry: ${item.entry}`,
        ...(item.sourceChanged ? ["Warning: source changed since indexing"] : []),
        ...item.sourceWarnings, "", item.excerpt,
      ].map(plain).join("\n");
      const wrapped = wrapTextWithAnsi(text, w);
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
    lines.push(this.theme.fg("dim", `${hint("tui.select.up")}/${hint("tui.select.down")} move · ${hint("tui.select.confirm")} excerpt/back · ${hint("tui.select.cancel")} ${this.detail ? "back" : "close"} · not sent to model`));
    return lines.slice(0, height).map(line => truncateToWidth(line, width));
  }
}
