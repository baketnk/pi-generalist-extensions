import { expect, test } from "bun:test";
import { Check } from "typebox/value";
import memory from "../extensions/memory.ts";
import continuity from "../extensions/continuity.ts";
import evidence from "../extensions/evidence.ts";
import history from "../extensions/history.ts";
import applyPatch from "../extensions/apply-patch.ts";
import webSearch from "../extensions/web-search.ts";
import { memoryTools, memoryNext } from "../lib/memory/contract.ts";
import { continuityTools, continuityNext } from "../lib/continuity/contract.ts";
import { evidenceTools, evidenceNext } from "../lib/evidence/contract.ts";
import { captureOrigin } from "../lib/memory/capture.ts";
import { freezeSnapshot } from "../lib/subagents/snapshot.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const examples: Record<string, any> = {
  memory_recall: {}, memory_read: { recordId: "synthetic-record" }, memory_sources: {}, memory_threads: {},
  memory_note: { scope: "project:synthetic", kind: "reflection", title: "Synthetic", body: "Text" },
  memory_revise: { recordId: "synthetic-record", expectedRevision: 1, title: "Synthetic", body: "New text", reason: "Correction" },
  continuity_list: {}, continuity_search: { query: "mailbox" }, continuity_read: { originalId: "anchor" }, continuity_check: { originalId: "anchor" }, continuity_context: {},
  evidence_capture: { id: "fixture", title: "Synthetic", kind: "source-observation", path: "fixture.ts", start: 1, end: 1 },
  evidence_list: {}, evidence_read: { id: "fixture" }, evidence_check: { id: "fixture" }, evidence_compare: { id: "fixture" },
};
const definitions = [...memoryTools, ...continuityTools, ...evidenceTools];

test("knowledge families have closed action-specific schemas with required inputs", () => {
  for (const tool of definitions) {
    expect(Check(tool.parameters, examples[tool.name])).toBe(true);
    expect(Check(tool.parameters, { ...examples[tool.name], action: tool.action })).toBe(false);
    expect(Check(tool.parameters, { ...examples[tool.name], unrelated: "ignored?" })).toBe(false);
    for (const key of tool.parameters.required ?? []) {
      const missing = { ...examples[tool.name] }; delete missing[key];
      expect(Check(tool.parameters, missing)).toBe(false);
    }
    for (const key of Object.keys(tool.parameters.properties)) {
      expect(Check(tool.parameters, { ...examples[tool.name], [key]: null })).toBe(false);
      if (key !== "query") expect(Check(tool.parameters, { ...examples[tool.name], [key]: "" })).toBe(false);
    }
  }
  const revise = memoryTools.find(t => t.name === "memory_revise")!;
  expect(Check(revise.parameters, { ...examples.memory_revise, scope: "personal:other" })).toBe(false);
  expect(Check(revise.parameters, { ...examples.memory_revise, kind: "fact" })).toBe(false);
});

test("single-purpose history, patch and search schemas reject ignored extra fields", () => {
  const tools: any[] = [];
  const pi: any = { registerFlag() {}, registerCommand() {}, on() {}, registerTool: (tool: any) => tools.push(tool) };
  history(pi); applyPatch(pi); webSearch(pi);
  const inputs: Record<string, any> = { history_search: {}, history_read: { session: "opaque" }, apply_patch: { patch: "*** Begin Patch\n*** End Patch" }, web_search: { query: "synthetic" } };
  for (const tool of tools) {
    expect(Check(tool.parameters, inputs[tool.name])).toBe(true);
    expect(Check(tool.parameters, { ...inputs[tool.name], unrelated: true })).toBe(false);
  }
  expect(Check(tools.find(t => t.name === "history_read").parameters, { session: "" })).toBe(false);
});

test("direct invalid calls fail before activation, stores or source reads", async () => {
  const tools: Record<string, any> = {};
  const pi: any = { registerFlag() {}, on() {}, registerCommand() {}, registerTool: (tool: any) => tools[tool.name] = tool };
  const forbidden = () => { throw new Error("Source/state access before validation"); };
  memory(pi); continuity(pi, forbidden); evidence(pi, forbidden);
  expect(tools.memory).toBeUndefined(); expect(tools.continuity).toBeUndefined(); expect(tools.evidence).toBeUndefined();
  for (const tool of definitions) {
    try { await tools[tool.name].execute("invalid", { ...examples[tool.name], wrongActionField: true }, undefined, undefined, {}); throw new Error("accepted"); }
    catch (error: any) {
      const detail = JSON.parse(error.message);
      expect(detail.code).toBe("invalid_arguments"); expect(detail.effect).toBe("none");
      expect(detail.retryUnchanged).toBe(false); expect(detail.nextCalls).toEqual([]);
    }
  }
  for (const args of [
    { ...examples.memory_note, sourceEntryId: "entry" },
    { ...examples.memory_note, excerpt: "unsupported" },
    { ...examples.memory_note, threadStatus: "open" },
    { ...examples.memory_note, body: "狸".repeat(3000) },
  ]) await expect(tools.memory_note.execute("semantic", args, undefined, undefined, {})).rejects.toThrow('"effect":"none"');
});

test("host provenance accepts only the exact new write call name and ID", () => {
  const ctx: any = { sessionManager: { getSessionId: () => "synthetic", getBranch: () => [{ type: "message", id: "entry", message: {
    role: "assistant", provider: "fake", model: "fake", content: [{ type: "toolCall", id: "call", name: "memory_note" }],
  } }] } };
  expect(captureOrigin(ctx, "call", "memory_note").toolCallId).toBe("call");
  for (const name of ["memory", "memory_read", "memory_revise"]) expect(() => captureOrigin(ctx, "call", name)).toThrow();
  expect(() => captureOrigin(ctx, "other", "memory_note")).toThrow();
});

test("fork snapshots retain privacy markers for new and historical memory/continuity results", () => {
  const manager = SessionManager.inMemory("/tmp");
  const user: any = { role: "user", content: "Synthetic", timestamp: 1 }, leafId = manager.appendMessage(user);
  const names = [...memoryTools, ...continuityTools].map(tool => tool.name).concat(["memory", "continuity"] as any);
  for (const name of names) {
    const messages: any[] = [user,
      { role: "assistant", content: [{ type: "toolCall", name, id: "call", arguments: {} }], timestamp: 2 },
      { role: "toolResult", toolCallId: "call", toolName: name, content: [{ type: "text", text: "Synthetic private result" }], timestamp: 3 },
    ];
    const snapshot = freezeSnapshot({ type: "context_snapshot", messages, leafId, contextErrors: 0, providerRequestHooks: false }, manager.getSessionId(), manager.getBranch());
    expect(snapshot.protectedKinds).toContain(name);
  }
});

test("next calls contain exact valid arguments, never repeat writes or accept candidates", () => {
  const suggestions = [
    ...memoryNext("recall", { items: [{ id: "synthetic-record" }] }),
    ...memoryNext("note", { id: "synthetic-record", status: "accepted" }),
    ...continuityNext("search", [{ id: "anchor" }]),
    ...evidenceNext("capture", { id: "fixture" }),
    ...evidenceNext("list", { nextOffset: 20 }),
  ];
  for (const call of suggestions) {
    const tool = definitions.find(t => t.name === call.tool)!;
    expect(tool).toBeDefined(); expect(Check(tool.parameters, call.arguments)).toBe(true);
    expect(["memory_note", "memory_revise", "evidence_capture"]).not.toContain(call.tool);
  }
  expect(memoryNext("note", { id: "candidate", status: "candidate" })).toEqual([]);
  expect(continuityNext("context", {})).toEqual([]);
  expect(evidenceNext("list", { nextOffset: null })).toEqual([]);
});
