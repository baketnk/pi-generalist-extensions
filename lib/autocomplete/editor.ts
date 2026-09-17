import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth, type EditorTheme, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { CompletionController } from "./controller.ts";
import { isProseDraft, type Predictor } from "./predictor.ts";
import type { Complete } from "./ollama.ts";

/** Overlay only: never put unaccepted text in the buffer, onChange, or model context. */
export function drawGhost(lines: string[], suffix: string, width: number, padding: number): string[] {
  const cursor = CURSOR_MARKER + "\x1b[7m \x1b[0m";
  const row = lines.findIndex(line => line.includes(cursor));
  if (row < 0) return lines; // Fail closed if Pi changes its cursor rendering contract.
  const at = lines[row]!.indexOf(cursor), before = lines[row]!.slice(0, at);
  const room = width - visibleWidth(before) - padding;
  if (room < 2) return lines;
  const preview = truncateToWidth(suffix.replace(/\n/g, " ↵ ").replace(/\t/g, " "), room, "…");
  const first = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(preview)][0]?.segment;
  if (!first) return lines;
  const painted = `${before}${CURSOR_MARKER}\x1b[2;7m${first}\x1b[0;2m${preview.slice(first.length)}\x1b[0m`;
  const result = [...lines]; result[row] = painted + " ".repeat(Math.max(0, width - visibleWidth(painted)));
  return result;
}

export class GhostEditor extends CustomEditor {
  readonly completion: CompletionController;
  private active = true;
  constructor(tui: TUI, theme: EditorTheme, keys: KeybindingsManager, predictor: Predictor,
    private complete: Complete, private modelEnabled: () => boolean,
    private owned: () => boolean, error: (message: string) => void) {
    super(tui, theme, keys);
    this.completion = new CompletionController(predictor, () => tui.requestRender(), error);
  }
  eligible(): boolean {
    const text = this.getText(), cursor = this.getCursor(), lines = this.getLines();
    return this.active && this.focused && this.owned() && cursor.line === lines.length - 1 && cursor.col === lines[cursor.line]!.length &&
      !this.isShowingAutocomplete() && isProseDraft(text) && !/\[paste\b/i.test(text) && !/\S*\/\S*$/.test(text);
  }
  override setText(text: string) { this.completion?.edited(); super.setText(text); }
  override insertTextAtCursor(text: string) { this.completion?.edited(); super.insertTextAtCursor(text); }
  override handleMouse(event: TuiMouseEvent) { this.completion.edited(); return super.handleMouse(event); }
  override handleInput(data: string) {
    const text = this.getText(), eligible = this.eligible();
    const suggestion = eligible ? this.completion.suggestion(text) : undefined;
    if (matchesKey(data, "escape") && (suggestion || this.completion.pending)) {
      this.completion.dismiss(text); return;
    }
    const tab = matchesKey(data, "tab");
    // A space + Tab explicitly asks the local model, even if history has an offer.
    // A second Tab accepts an already-returned model suggestion.
    if (eligible && tab && / $/.test(text) && this.modelEnabled() && suggestion?.source !== "ollama") {
      void this.completion.request(text, this.complete, () => this.eligible() && this.getText() === text);
      return;
    }
    const word = matchesKey(data, "alt+right") || matchesKey(data, "ctrl+right") || tab;
    const all = matchesKey(data, "right") || (tab && suggestion?.source === "ollama");
    if (suggestion && (all || word)) {
      const accepted = all ? suggestion.suffix : (suggestion.suffix.match(/^\s*\S+\s*/u)?.[0] ?? suggestion.suffix);
      this.insertTextAtCursor(accepted);
      this.completion.retain(this.getText(), { ...suggestion, suffix: suggestion.suffix.slice(accepted.length) });
      return;
    }
    this.completion.edited();
    // Plain-prose Tab is reserved for our completion, not Pi's filesystem picker.
    if (eligible && tab) return;
    super.handleInput(data);
  }
  protected override renderBottomBorder(width: number, hiddenLines: number): string {
    const border = super.renderBottomBorder(width, hiddenLines);
    if (!this.completion?.pending || width < 24) return border;
    const label = " local completion… Esc cancels ";
    return truncateToWidth(label, width, "") + truncateToWidth(border, Math.max(0, width - visibleWidth(label)), "");
  }
  override render(width: number): string[] {
    const lines = super.render(width);
    if (!this.focused || !this.eligible()) return lines;
    const suggestion = this.completion.suggestion(this.getText());
    return suggestion ? drawGhost(lines, suggestion.suffix, width, this.getPaddingX()) : lines;
  }
  dispose() { this.active = false; this.completion.dispose(); }
}
