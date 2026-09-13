import { constants } from "node:fs";
import { open } from "node:fs/promises";

export const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_LINES = 100_000;
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
}

/** Counts physical history, including all branches; never reconstructs provider context. */
export function summarizeSession(text: string) {
  if (Buffer.byteLength(text) > MAX_SESSION_BYTES) throw new Error("Session exceeds 64 MiB.");
  const lines = text.split("\n");
  if (lines.length > MAX_LINES) throw new Error("Session exceeds 100000 lines.");
  const report = {
    version: 1, scope: "whole-file-all-branches", entries: 0,
    assistantResponses: 0, assistantErrors: 0, assistantAborts: 0, userMessages: 0,
    outerToolCalls: 0, execCalls: 0, outerErrorResults: 0,
    nested: { calls: 0, starts: 0, ends: 0, succeeded: 0, failed: 0, unknown: 0, orphanEnds: 0,
      orchestrators: 0, callsPerOrchestrator: null as number | null },
    ignoredPartialFinalLine: false,
  };
  const nested = new Map<string, { start: boolean; end: boolean; failed: boolean; name: string }>();
  const parents = new Set<string>();
  let header = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error(`Line ${i + 1} exceeds 2 MiB.`);
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); }
    catch {
      if (header && i === lines.length - 1 && !text.endsWith("\n")) {
        report.ignoredPartialFinalLine = true;
        break;
      }
      throw new Error(`Invalid JSON at line ${i + 1}.`);
    }
    const entry = object(parsed);
    if (!entry || typeof entry.type !== "string") throw new Error(`Invalid entry at line ${i + 1}.`);
    if (!header) {
      if (entry.type !== "session" || ![2, 3].includes(entry.version as number))
        throw new Error("Expected a Pi v2/v3 session header.");
      header = true;
      continue;
    }
    if (entry.type === "session") throw new Error("Multiple session headers are unsupported.");
    report.entries++;
    if (entry.type === "message") {
      const message = object(entry.message);
      if (message?.role === "user") report.userMessages++;
      if (message?.role === "toolResult" && message.isError === true) report.outerErrorResults++;
      if (message?.role === "assistant") {
        report.assistantResponses++;
        if (message.stopReason === "error") report.assistantErrors++;
        if (message.stopReason === "aborted") report.assistantAborts++;
        for (const block of Array.isArray(message.content) ? message.content : []) {
          const call = object(block);
          if (call?.type !== "toolCall") continue;
          report.outerToolCalls++;
          if (call.name === "exec") report.execCalls++;
        }
      }
    }
    if (entry.type !== "custom" || entry.customType !== "pi.nested-tool.v1") continue;
    const data = object(entry.data);
    if (!data || !["start", "end"].includes(data.phase as string) ||
        typeof data.parentToolCallId !== "string" || !data.parentToolCallId ||
        typeof data.toolCallId !== "string" || !data.toolCallId ||
        typeof data.toolName !== "string" || !data.toolName ||
        (data.phase === "end" && typeof data.isError !== "boolean"))
      throw new Error(`Malformed nested trace at line ${i + 1}.`);
    const key = JSON.stringify([data.parentToolCallId, data.toolCallId]);
    const state = nested.get(key) ?? { start: false, end: false, failed: false, name: data.toolName };
    const phase = data.phase as "start" | "end";
    if (state[phase] || state.name !== data.toolName)
      throw new Error(`Duplicate or conflicting nested trace at line ${i + 1}.`);
    state[phase] = true;
    if (phase === "end") state.failed = data.isError === true;
    nested.set(key, state);
    parents.add(data.parentToolCallId);
  }
  if (!header) throw new Error("Expected a Pi v2/v3 session header.");
  for (const state of nested.values()) {
    report.nested.calls++;
    if (state.start) report.nested.starts++;
    if (state.end) {
      report.nested.ends++;
      if (!state.start) report.nested.orphanEnds++;
      if (state.failed) report.nested.failed++;
      else report.nested.succeeded++;
    } else report.nested.unknown++;
  }
  report.nested.orchestrators = parents.size;
  report.nested.callsPerOrchestrator = parents.size ? report.nested.calls / parents.size : null;
  return report;
}

/** Read a fixed-size prefix from a regular file; never follow embedded references or tail a live session. */
export async function readSessionMetrics(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Session must be a regular file.");
    if (stat.size > MAX_SESSION_BYTES) throw new Error("Session exceeds 64 MiB.");
    const bytes = Buffer.alloc(stat.size);
    let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, size);
      if (!result.bytesRead) throw new Error("Session shrank during reading.");
      size += result.bytesRead;
    }
    return { bytesRead: size, ...summarizeSession(bytes.toString("utf8")) };
  } finally { await handle.close(); }
}
