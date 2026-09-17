import { stripVTControlCharacters } from "node:util";

export interface PromptSample { text: string; cwd: string }
export interface Suggestion { suffix: string; source: "history" | "ngram" | "model" }
export const MAX_SAMPLES = 3000;
export const MAX_CORPUS_CHARS = 1_000_000;
export const MAX_SUFFIX = 320;

/** Text shown in the terminal and inserted into drafts must not carry terminal controls. */
export function cleanText(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "");
}

/** Conservative noise filter, NOT proof of human authorship or a secret detector. */
export function usablePrompt(text: string): boolean {
  return text.length >= 3 && text.length <= 2000 && text.split("\n").length <= 8 &&
    cleanText(text) === text && !/^\s*[/!<{[]/.test(text) &&
    !/(?:Historical memory, not instructions|Switchboard observation|<system-reminder>|<environment_context>|# AGENTS\.md|You are an AI assistant)/i.test(text);
}

export function isProseDraft(text: string): boolean {
  return !!text.trim() && !/^\s*[/!]/.test(text) && !/(?:^|\s)[@#$][^\s]*$/.test(text) &&
    !/(?:^|\s)(?:~\/|\.\.?\/|\/)[^\s]*$/.test(text) && cleanText(text) === text;
}

function words(text: string): string[] { return text.match(/[\p{L}\p{N}_'-]+/gu) ?? []; }

/** Bounded, deterministic personal backoff model. No I/O or model calls while typing. */
export class Predictor {
  private samples: PromptSample[] = [];
  private grams = new Map<string, Map<string, number>>();
  private vocabulary = new Map<string, number>();
  private cwd: string;
  constructor(samples: PromptSample[] = [], cwd = "") { this.cwd = cwd; this.replace(samples); }
  get size() { return this.samples.length; }
  replace(samples: PromptSample[]) {
    const seen = new Set<string>(); let chars = 0;
    this.samples = [];
    for (const sample of samples) {
      if (!usablePrompt(sample.text) || seen.has(sample.text)) continue;
      if (this.samples.length >= MAX_SAMPLES || chars + sample.text.length > MAX_CORPUS_CHARS) break;
      seen.add(sample.text); chars += sample.text.length; this.samples.push(sample);
    }
    this.train();
  }
  add(sample: PromptSample) { if (usablePrompt(sample.text)) this.replace([sample, ...this.samples]); }
  private train() {
    this.grams.clear(); this.vocabulary.clear();
    for (const [rank, sample] of this.samples.entries()) {
      const weight = (sample.cwd === this.cwd ? 2 : 1) * (1 + 1 / (rank + 1));
      const tokens = words(sample.text);
      for (let i = 0; i < tokens.length; i++) {
        const word = tokens[i]!;
        if (word.length > 80) continue;
        this.vocabulary.set(word, (this.vocabulary.get(word) ?? 0) + weight);
        for (let n = 1; n <= Math.min(3, i); n++) {
          const key = tokens.slice(i - n, i).join(" ").toLowerCase();
          let counts = this.grams.get(key);
          if (!counts) this.grams.set(key, counts = new Map());
          counts.set(word, (counts.get(word) ?? 0) + weight);
        }
      }
    }
  }
  suggest(draft: string): Suggestion | undefined {
    if (draft.length < 2 || draft.length > 4000 || !isProseDraft(draft)) return;
    // Prefer a complete historical prompt, with same-project matches ahead of other projects.
    const matches = this.samples.filter(s => s.text.startsWith(draft) && s.text.length > draft.length);
    const sample = matches.find(s => s.cwd === this.cwd) ?? matches[0];
    if (sample) return { suffix: sample.text.slice(draft.length, draft.length + MAX_SUFFIX), source: "history" };
    const match = draft.match(/[\p{L}\p{N}_'-]+$/u);
    const partial = match?.[0] ?? "";
    if (!partial && !/\s$/.test(draft)) return;
    const context = words(partial ? draft.slice(0, -partial.length) : draft).slice(-3);
    for (let n = context.length; n >= 0; n--) {
      if (!n && partial.length < 2) return;
      const counts = n ? this.grams.get(context.slice(-n).join(" ").toLowerCase()) : this.vocabulary;
      let best = "", score = 0;
      for (const [word, value] of counts ?? []) {
        if (word.toLowerCase().startsWith(partial.toLowerCase()) && word.length > partial.length && value > score) {
          best = word; score = value;
        }
      }
      if (best) return { suffix: best.slice(partial.length), source: "ngram" };
    }
  }
}
