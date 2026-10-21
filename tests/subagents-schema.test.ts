import { expect, test } from "bun:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import subagents from "../extensions/subagents.ts";
import { nextForRun, subagentFailure, subagentTools } from "../lib/subagents/contract.ts";
import type { RunRecord } from "../lib/subagents/types.ts";

function harness() {
  const tools: Record<string, any> = {};
  subagents({ registerFlag() {}, on() {}, registerCommand() {}, registerTool: (tool: any) => { tools[tool.name] = tool; } } as any);
  const validate = (name: string, args: any) => validateToolArguments(tools[name], { type: "toolCall", id: "schema-test", name, arguments: args });
  const execute = (name: string, args: any) => tools[name].execute("schema-test", args, undefined, undefined, {});
  return { tools, validate, execute };
}
const launch = { launchKey: "review-1", task: "Review src/validation.ts", label: "review" };
const calls: [string, Record<string, any>][] = [
  ["subagent_start", launch], ["subagent_fork", { ...launch, checkpointId: "ANCHOR", permissions: "implement" }],
  ["subagent_list", {}], ["subagent_models", {}], ["subagent_checkpoints", {}],
  ["subagent_status", { runId: "RUN_ID" }], ["subagent_peek", { runId: "RUN_ID", after: 0, limit: 100 }],
  ["subagent_wait", { runIds: ["RUN_ID"], waitMode: "all", waitTimeoutSeconds: 300 }],
  ["subagent_answer", { runId: "RUN_ID", questionId: "QUESTION_ID", text: "Answer" }],
  ["subagent_guide", { runId: "RUN_ID", text: "Advice" }],
  ["subagent_collect", { runId: "RUN_ID" }], ["subagent_cancel", { runId: "RUN_ID" }],
];

test("action-specific schemas are flat, required, documented, and have no legacy wrapper", () => {
  const h = harness();
  expect(h.tools.subagents).toBeUndefined();
  expect(Object.keys(h.tools).sort()).toEqual(calls.map(([name]) => name).sort());
  for (const tool of Object.values(h.tools)) {
    const schema = JSON.parse(JSON.stringify(tool.parameters));
    expect(schema.type).toBe("object"); expect(schema.additionalProperties).toBe(false);
    for (const property of Object.values(schema.properties) as any[]) expect(property.description.length).toBeGreaterThan(20);
    for (const keyword of ["anyOf", "oneOf", "allOf", "$ref"]) expect(JSON.stringify(schema)).not.toContain(`"${keyword}"`);
    for (const field of ["action", "id", "ids", "all", "seconds", "operation", "from"]) expect(schema.properties[field]).toBeUndefined();
  }
  expect(h.tools.subagent_start.parameters.properties.runId).toBeUndefined();
  expect(h.tools.subagent_start.parameters.properties.checkpointId).toBeUndefined();
  expect(h.tools.subagent_fork.parameters.required).toContain("checkpointId");
  expect(h.tools.subagent_wait.parameters.required).toEqual(["runIds", "waitMode"]);
  expect(h.tools.subagent_start.description.startsWith("Start independent work")).toBe(true);
});

test("documented shapes pass SDK validation and reach runtime admission", async () => {
  const h = harness();
  for (const [name, args] of calls) {
    expect(h.validate(name, args)).toEqual(args);
    await expect(h.execute(name, args)).rejects.toThrow("Subagent runtime unavailable");
  }
});

test("all missing required fields and unrelated fields fail before runtime effects", async () => {
  const h = harness();
  for (const [name, args] of calls) {
    for (const field of h.tools[name].parameters.required ?? []) {
      const missing = { ...args }; delete missing[field];
      expect(() => h.validate(name, missing)).toThrow("Validation failed");
      await expect(h.execute(name, missing)).rejects.toThrow('"code":"invalid_arguments"');
    }
    expect(() => h.validate(name, { ...args, unrelated: true })).toThrow("Validation failed");
    await expect(h.execute(name, { ...args, unrelated: true })).rejects.toThrow('"retryUnchanged":false');
  }
});

test("SDK rejects implicit selection, overloaded names, missing keys, and invalid bounds", () => {
  const h = harness();
  for (const [name, args] of [
    ["subagent_start", { task: "Review", label: "review" }],
    ["subagent_start", { ...launch, id: "invented" }],
    ["subagent_start", { ...launch, checkpointId: "ANCHOR" }],
    ["subagent_fork", launch],
    ["subagent_wait", {}], ["subagent_wait", { runIds: [], waitMode: "all" }],
    ["subagent_wait", { runIds: ["x", "x"], waitMode: "all" }],
    ["subagent_wait", { runIds: ["x"], waitMode: "all", waitTimeoutSeconds: 301 }],
    ["subagent_cancel", { all: true }], ["subagent_status", { runId: "" }],
    ["subagent_guide", { runId: "x", text: "x".repeat(4097) }],
  ] as [string, any][]) expect(() => h.validate(name, args)).toThrow("Validation failed");
});

test("byte limits remain enforced where JSON string lengths differ", async () => {
  await expect(harness().execute("subagent_guide", { runId: "x", text: "é".repeat(2049) })).rejects.toThrow("4096 UTF-8 bytes");
});

test("next calls use real IDs, do not fabricate answers, and terminate after collection", () => {
  const h = harness();
  const record = { id: "run-1", taskState: "running" } as RunRecord;
  const wait = nextForRun(record)[0]!;
  expect(h.validate(wait.tool, wait.arguments)).toEqual({ runIds: ["run-1"], waitMode: "all", waitTimeoutSeconds: 60 });
  const answer = nextForRun({ ...record, taskState: "needs-input", question: { id: "q-1", text: "Which file?" } })[0]!;
  expect(answer).toEqual({ tool: "subagent_answer", arguments: { runId: "run-1", questionId: "q-1" }, requiredInput: { text: "Which file?" } });
  expect(h.validate(answer.tool, { ...answer.arguments, text: "src/a.ts" }).questionId).toBe("q-1");
  for (const taskState of ["reported", "failed", "budget-exceeded", "cancelled"] as const) {
    const collect = nextForRun({ ...record, taskState })[0]!;
    expect(h.validate(collect.tool, collect.arguments)).toEqual({ runId: record.id });
    expect(nextForRun({ ...record, taskState, collectedAt: 1 })).toEqual([]);
  }
});

test("runtime errors have actionable repairs without implicit retries or permission escalation", () => {
  const h = harness();
  for (const [message, code, tool] of [
    ["Unknown owned run ID.", "unknown_run", "subagent_list"],
    ["Start operation reused with different intent.", "launch_key_conflict", "subagent_list"],
    ["Subagent model is human-locked to next-smaller", "model_policy", "subagent_models"],
    ["Fork history sharing not authorized", "permission_required", undefined],
    ["Worker has not finished its task.", "invalid_state", "subagent_status"],
    ["No safe checkpoint", "checkpoint_unavailable", "subagent_checkpoints"],
  ]) {
    const error = JSON.parse(subagentFailure(new Error(message), "unknown", { action: "start", id: "run-1" }, []).message);
    expect(error.code).toBe(code); expect(error.retryUnchanged).toBe(false); expect(error.effect).toBe("unknown");
    expect(error.repair.length).toBeGreaterThan(20); expect(error.nextCalls[0]?.tool).toBe(tool);
    for (const next of error.nextCalls) h.validate(next.tool, next.arguments);
  }
});

test("tool definitions stay fixed across validation and state-derived recommendations", () => {
  const a = harness(), b = harness(), before = JSON.stringify(subagentTools);
  for (const [name, args] of calls) a.validate(name, args);
  nextForRun({ id: "new-run", taskState: "running" } as RunRecord);
  expect(JSON.stringify(subagentTools)).toBe(before);
  for (const name of Object.keys(a.tools)) {
    expect(b.tools[name].description).toBe(a.tools[name].description);
    expect(JSON.stringify(b.tools[name].parameters)).toBe(JSON.stringify(a.tools[name].parameters));
  }
});
