import { stripVTControlCharacters } from "node:util";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { DEFAULT_PAGE_BYTES, type Page } from "./store.ts";
export const plain = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

/** Read-only snapshot, not a live watcher. Reopen to refresh. */
export class WorkpadView {
  private offset = 0;
  private pageSize = 1;
  private maximum = 0;
  constructor(private page: Page, private theme: Theme, private keys: KeybindingsManager,
    private rows: () => number, private redraw: () => void, private close: () => void,
    private settings = { pageBytes: DEFAULT_PAGE_BYTES, refreshPercent: 0 }) {}
  invalidate() {}
  handleInput(data: string) {
    if (this.keys.matches(data, "tui.select.cancel")) { this.close(); return; }
    const delta = this.keys.matches(data, "tui.select.up") ? -1
      : this.keys.matches(data, "tui.select.down") ? 1
      : this.keys.matches(data, "tui.select.pageUp") ? -this.pageSize
      : this.keys.matches(data, "tui.select.pageDown") ? this.pageSize : 0;
    this.offset = Math.max(0, Math.min(this.maximum, this.offset + delta));
    this.redraw();
  }
  render(width: number): string[] {
    const height = Math.max(1, Math.floor(this.rows() * 0.8));
    this.pageSize = Math.max(1, height - 4);
    const lines = wrapTextWithAnsi(plain(this.page.content), Math.max(1, width));
    this.maximum = Math.max(0, lines.length - this.pageSize);
    this.offset = Math.min(this.offset, this.maximum);
    const key = (action: Parameters<KeybindingsManager["getKeys"]>[0]) => this.keys.getKeys(action).join("/");
    return [
      this.theme.fg("accent", `Workpad ${this.page.id} · revision ${this.page.revision} · attached to model context`),
      this.theme.fg("dim", `${Buffer.byteLength(this.page.content, "utf8")}/${this.settings.pageBytes} UTF-8 bytes · refresh ${this.settings.refreshPercent ? `${this.settings.refreshPercent}% context growth (estimated)` : "off"}`),
      ...lines.slice(this.offset, this.offset + this.pageSize),
      this.theme.fg("dim", `Lines ${this.offset + 1}–${Math.min(lines.length, this.offset + this.pageSize)}/${lines.length} · snapshot; reopen to refresh`),
      this.theme.fg("dim", `${key("tui.select.up")}/${key("tui.select.down")} scroll · ${key("tui.select.pageUp")}/${key("tui.select.pageDown")} page · ${key("tui.select.cancel")} close`),
    ].slice(0, height).map(line => truncateToWidth(line, width));
  }
}
