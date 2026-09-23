import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import toolFeedback, { formatToolFeedback } from "../extensions/tool-feedback.ts";

function harness() {
  const root = mkdtempSync(join(tmpdir(), "tool-feedback-test-"));
  const events: Record<string, Function[]> = {};
  const notices: { message: string; type: string }[] = [];
  let tool: any;
  const pi: any = {
    on: (name: string, callback: Function) => (events[name] ??= []).push(callback),
    registerTool: (definition: any) => { tool = definition; },
  };
  toolFeedback(pi, () => root);
  const ctx: any = { hasUI: true, ui: { notify: (message: string, type: string) => notices.push({ message, type }) } };
  const emit = async (name: string, context = ctx) => { for (const callback of events[name] ?? []) await callback({}, context); };
  return { root, notices, tool: () => tool, ctx, emit, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("feedback is saved privately and displayed in full only after final settlement", async () => {
  const h = harness();
  try {
    const input = { tool: "exec", category: "usability", summary: "Confusing preview", details: "A complete result looked truncated.\nHard to tell why.",
      observed: "The output showed a tail.", expected: "Mark the boundary.", impact: "I retried.", suggestion: "Add a count." };
    await h.tool().execute("call", input);
    expect(readdirSync(h.root).filter(name => name.endsWith(".json"))).toHaveLength(1);
    const stored = JSON.parse(readFileSync(join(h.root, readdirSync(h.root).find(name => name.endsWith(".json"))!), "utf8"));
    expect(stored.details).toBe(input.details);
    expect(h.notices).toHaveLength(0);
    await h.emit("agent_end");
    expect(h.notices).toHaveLength(0);
    await h.emit("agent_settled");
    expect(h.notices).toEqual([{ message: "New tool feedback for exec (usability):\nSummary: Confusing preview\nDetails: A complete result looked truncated.\n  Hard to tell why.\nObserved: The output showed a tail.\nExpected: Mark the boundary.\nImpact: I retried.\nSuggestion: Add a count.", type: "warning" }]);
    expect(h.notices[0]!.message).not.toContain('"summary"');
    await h.emit("agent_settled");
    await h.emit("session_shutdown");
    expect(h.notices).toHaveLength(1);
  } finally { h.cleanup(); }
});

test("each report gets its own notice; aborted saves are not announced", async () => {
  const h = harness();
  try {
    const first = { tool: "read", summary: "First report", details: "First detail" };
    const second = { tool: "bash", summary: "Second report", details: "Second detail" };
    await h.tool().execute("1", first);
    await h.tool().execute("2", second);
    await h.emit("agent_settled");
    expect(h.notices.map(n => n.message)).toEqual([formatToolFeedback({ ...first, id: "", version: 1, reportedAt: "" }), formatToolFeedback({ ...second, id: "", version: 1, reportedAt: "" })]);
    await expect(h.tool().execute("3", first, { throwIfAborted: () => { throw Error("aborted"); } })).rejects.toThrow("aborted");
    await h.emit("agent_settled");
    expect(h.notices).toHaveLength(2);
  } finally { h.cleanup(); }
});

test("pending reports are announced on shutdown before a reload, but not without UI", async () => {
  const h = harness();
  try {
    await h.tool().execute("1", { tool: "write", summary: "Saved", details: "Persisted report" });
    await h.emit("agent_settled", { hasUI: false });
    expect(h.notices).toHaveLength(0);
    await h.emit("session_shutdown");
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]!.message).toContain("Details: Persisted report");
  } finally { h.cleanup(); }
});

test("feedback display removes terminal escapes without removing the prose", () => {
  const result = formatToolFeedback({ version: 1, id: "id", reportedAt: "date", tool: "read", summary: "Concern", details: "before\x1b[31mred\x1b[0m after" });
  expect(result).toContain("Details: beforered after");
  expect(result).not.toContain("\x1b");
});
