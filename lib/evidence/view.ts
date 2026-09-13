import { stripVTControlCharacters } from "node:util";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
export const safeText = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

/** An ephemeral inspection surface; closing it never deletes evidence. */
export class EvidenceView {
  private offset = 0;
  private pageSize = 1;
  private maximum = 0;
  constructor(private title: string, private content: string, private theme: Theme, private keys: KeybindingsManager,
    private rows: () => number, private redraw: () => void, private close: () => void) {}
  invalidate() {}
  handleInput(data: string) {
    if (this.keys.matches(data, "tui.select.cancel")) { this.close(); return; }
    const delta = this.keys.matches(data, "tui.select.up") ? -1 : this.keys.matches(data, "tui.select.down") ? 1
      : this.keys.matches(data, "tui.select.pageUp") ? -this.pageSize : this.keys.matches(data, "tui.select.pageDown") ? this.pageSize : 0;
    this.offset = Math.max(0, Math.min(this.maximum, this.offset + delta)); this.redraw();
  }
  render(width: number): string[] {
    const height = Math.max(1, Math.floor(this.rows() * .8));
    this.pageSize = Math.max(1, height - 2);
    const lines = wrapTextWithAnsi(safeText(this.content), Math.max(1, width));
    this.maximum = Math.max(0, lines.length - this.pageSize); this.offset = Math.min(this.offset, this.maximum);
    const key = (action: Parameters<KeybindingsManager["getKeys"]>[0]) => this.keys.getKeys(action).join("/");
    return [this.theme.fg("accent", safeText(this.title)), ...lines.slice(this.offset, this.offset + this.pageSize),
      this.theme.fg("dim", `${this.offset + 1}/${lines.length} · ${key("tui.select.up")}/${key("tui.select.down")} scroll · ${key("tui.select.pageDown")} page · ${key("tui.select.cancel")} close`),
    ].slice(0, height).map(line => truncateToWidth(line, width));
  }
}
