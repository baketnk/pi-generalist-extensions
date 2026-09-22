import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MAX_REPORT_BYTES = 16 * 1024;
export const feedbackCategories = ["unexpected-behavior", "usability", "limitation", "design-feedback", "other"] as const;
export type FeedbackCategory = typeof feedbackCategories[number];

export interface ToolFeedbackInput {
  tool: string;
  category?: FeedbackCategory;
  summary: string;
  details: string;
  observed?: string;
  expected?: string;
  impact?: string;
  suggestion?: string;
}

export interface ToolFeedback extends ToolFeedbackInput {
  version: 1;
  id: string;
  reportedAt: string;
}

function validateText(value: unknown, name: string, maxBytes: number, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be nonempty text.`);
  if (Buffer.byteLength(value) > maxBytes) throw new Error(`${name} exceeds ${maxBytes} UTF-8 bytes.`);
  return value;
}

function validateInput(input: ToolFeedbackInput): ToolFeedbackInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Feedback report must be an object.");
  const allowed = new Set(["tool", "category", "summary", "details", "observed", "expected", "impact", "suggestion"]);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new Error("Feedback report has unsupported fields.");
  if (input.category !== undefined && !feedbackCategories.includes(input.category)) throw new Error("Unsupported feedback category.");
  const value: ToolFeedbackInput = {
    tool: validateText(input.tool, "tool", 120)!,
    summary: validateText(input.summary, "summary", 240)!,
    details: validateText(input.details, "details", 6 * 1024)!,
    ...(input.category === undefined ? {} : { category: input.category }),
    ...(input.observed === undefined ? {} : { observed: validateText(input.observed, "observed", 2500, true) }),
    ...(input.expected === undefined ? {} : { expected: validateText(input.expected, "expected", 2500, true) }),
    ...(input.impact === undefined ? {} : { impact: validateText(input.impact, "impact", 1200, true) }),
    ...(input.suggestion === undefined ? {} : { suggestion: validateText(input.suggestion, "suggestion", 1800, true) }),
  };
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_REPORT_BYTES - 1024) throw new Error(`Feedback fields exceed ${MAX_REPORT_BYTES - 1024} UTF-8 bytes in total.`);
  return value;
}

function directory(path: string, create: boolean): void {
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid()) || (stat.mode & 0o077))
    throw new Error("Tool feedback storage must be a private directory owned by this user.");
}

/** Each explicitly submitted report is published as a separate immutable JSON record. */
export class ToolFeedbackStore {
  constructor(readonly root: string) {}

  save(input: ToolFeedbackInput): ToolFeedback & { path: string } {
    const supplied = validateInput(input);
    directory(this.root, true);
    const id = randomUUID();
    const record: ToolFeedback = { version: 1, id, reportedAt: new Date().toISOString(), ...supplied };
    const serialized = `${JSON.stringify(record, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_REPORT_BYTES) throw new Error(`Feedback report exceeds ${MAX_REPORT_BYTES} UTF-8 bytes.`);
    const path = join(this.root, `${id}.json`);
    const temporary = join(this.root, `.pending-${id}`);
    try {
      const fd = openSync(temporary, "wx", 0o600);
      try { writeFileSync(fd, serialized, "utf8"); fsyncSync(fd); }
      finally { closeSync(fd); }
      try { linkSync(temporary, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Feedback report ID already exists; no report was replaced.");
        throw error;
      }
    } finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
    try {
      const dir = openSync(this.root, constants.O_RDONLY);
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } catch { /* Directory fsync is not supported on every filesystem. */ }
    return { ...record, path };
  }
}
