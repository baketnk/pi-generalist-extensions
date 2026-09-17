import { cleanText, MAX_SUFFIX, type Predictor, type Suggestion } from "./predictor.ts";
import type { Complete } from "./provider.ts";

/** Owns cancellation/ABA fencing independently of the editor and provider. */
export class CompletionController {
  private epoch = 0;
  private abort?: AbortController;
  private model?: { draft: string; suggestion: Suggestion };
  private dismissed?: string;
  private cached?: { draft: string; suggestion?: Suggestion };
  private closed = false;
  get pending() { return !!this.abort; }
  constructor(private predictor: Predictor, private changed: () => void, private error: (message: string) => void) {}
  suggestion(draft: string): Suggestion | undefined {
    if (this.closed || this.dismissed === draft || this.pending) return;
    if (this.model?.draft === draft) return this.model.suggestion;
    if (this.cached?.draft !== draft) this.cached = { draft, suggestion: this.predictor.suggest(draft) };
    return this.cached.suggestion;
  }
  invalidate() {
    this.epoch++; this.abort?.abort(); this.abort = undefined; this.model = undefined; this.cached = undefined;
  }
  dismiss(draft: string) { this.invalidate(); this.dismissed = draft; this.changed(); }
  edited() { this.invalidate(); this.dismissed = undefined; }
  retain(draft: string, suggestion: Suggestion) {
    this.invalidate(); this.dismissed = undefined;
    if (suggestion.suffix) this.model = { draft, suggestion };
  }
  async request(draft: string, complete: Complete, stillCurrent: () => boolean) {
    if (this.closed || this.pending) return;
    this.invalidate(); this.dismissed = undefined;
    const epoch = this.epoch, abort = new AbortController(); this.abort = abort; this.changed();
    try {
      const suffix = cleanText(await complete(draft, abort.signal)).slice(0, MAX_SUFFIX);
      if (this.closed || abort.signal.aborted || epoch !== this.epoch || !stillCurrent()) return;
      if (suffix.trim()) this.model = { draft, suggestion: { suffix, source: "model" } };
      else this.dismissed = draft;
    } catch (error) {
      if (!abort.signal.aborted && epoch === this.epoch && !this.closed && stillCurrent()) {
        this.dismissed = draft;
        this.error(cleanText(error instanceof Error ? error.message : "Local completion failed").slice(0, 240));
      }
    } finally {
      if (epoch === this.epoch && !this.closed) { this.abort = undefined; this.changed(); }
    }
  }
  dispose() { this.closed = true; this.invalidate(); }
}
