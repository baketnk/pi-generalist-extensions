import { expect, test } from "bun:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import subagents from "../extensions/subagents.ts";

function harness() {
  let tool: any;
  subagents({ registerFlag() {}, on() {}, registerCommand() {}, registerTool: (value: any) => { tool = value; } } as any);
  const validate = (args: any) => validateToolArguments(tool, { type: "toolCall", id: "schema-test", name: "subagents", arguments: args });
  // No session runtime: valid arguments reach ready(), invalid action contracts
  // must fail earlier, before locks, disk reads, consent or launch effects.
  const execute = (args: any) => tool.execute("schema-test", validate(args), undefined, undefined, {});
  return { tool, validate, execute };
}

const calls = [
  { action: "start", mode: "fresh", task: "Review src/validation.ts", label: "review" },
  { action: "start", mode: "fork", task: "Review", label: "review", from: "ANCHOR", permissions: "implement" },
  { action: "list" }, { action: "models" }, { action: "checkpoints" },
  { action: "status", id: "RUN_ID" }, { action: "peek", id: "RUN_ID", after: 0, limit: 100 },
  { action: "join" }, { action: "join", ids: ["RUN_ID"], seconds: 300, all: true },
  { action: "input", id: "RUN_ID", question: "QUESTION_ID", text: "Answer" },
  { action: "guide", id: "RUN_ID", text: "Advice" },
  { action: "collect", id: "RUN_ID" }, { action: "cancel", id: "RUN_ID" }, { action: "cancel", all: true },
];

test("schema stays flat, describes every field, and exposes each action's call shape", () => {
  const { tool } = harness(), schema = JSON.parse(JSON.stringify(tool.parameters));
  expect(schema.type).toBe("object");
  expect(schema.required).toEqual(["action"]);
  expect(schema.additionalProperties).toBe(false);
  for (const property of Object.values(schema.properties) as any[]) expect(property.description.length).toBeGreaterThan(20);
  for (const action of schema.properties.action.enum) {
    expect(tool.description).toContain(`${action}:`);
    expect(tool.description).toContain(`"action":"${action}"`);
  }
  for (const keyword of ["anyOf", "oneOf", "allOf", "$ref"]) expect(JSON.stringify(schema)).not.toContain(`"${keyword}"`);
  expect(schema.properties.seconds.description).toContain("1..300");
  expect(schema.properties.text.description).toContain("4 KiB");
  expect(schema.properties.from.description).toContain("anchor");
  expect(schema.properties.id.description).toContain("Do NOT supply id for start/new workers");
});

test("documented call shapes pass SDK validation and action checks", async () => {
  const h = harness();
  for (const args of calls) {
    expect(h.validate(args)).toEqual(args);
    await expect(h.execute(args)).rejects.toThrow("Subagent runtime unavailable");
  }
  // SDKs may send null placeholders for unused optional properties.
  expect(h.validate({ action: "list", id: null, mode: null, task: null })).toEqual({ action: "list" });
});

test("missing required action fields identify the action and expected arguments", async () => {
  const h = harness();
  for (const [action, fields] of Object.entries({ start: ["mode", "task", "label"], status: ["id"], peek: ["id"],
    input: ["id", "question", "text"], guide: ["id", "text"], collect: ["id"], cancel: ["id"] })) {
    const valid = calls.find(call => call.action === action)!;
    for (const field of fields) {
      const args: any = { ...valid }; delete args[field];
      await expect(h.execute(args)).rejects.toThrow(`Missing required ${field}. For ${action},`);
    }
  }
});

test("invalid combinations give repairable errors before runtime initialization", async () => {
  const h = harness();
  for (const [args, message] of [
    [{ ...calls[0], id: "invented-new-worker-id" }, "Do not pass id: the host generates and returns the new worker run ID"],
    [{ action: "join", id: "RUN_ID" }, "use ids, not id"],
    [{ action: "list", task: "Review" }, 'pass only {"action":"list"}'],
    [{ action: "cancel", id: "RUN_ID", all: true }, "Choose id or all, not both"],
    [{ action: "cancel", all: false }, "Missing required id"],
    [{ ...calls[0], from: "ANCHOR" }, "Omit from"],
    [{ action: "join", seconds: 301 }, "Join timeout must be 1–300 seconds"],
    [{ action: "guide", id: "RUN_ID", text: "é".repeat(2049) }, "4096 UTF-8 bytes"],
  ] as const) await expect(h.execute(args)).rejects.toThrow(message);
  await expect(h.tool.execute("test", { action: "spawn" }, undefined, undefined, {})).rejects.toThrow("Unknown subagents action");
});

test("every action rejects unrelated fields with action-specific repair guidance", async () => {
  const h = harness();
  for (const args of calls) {
    await expect(h.tool.execute("test", { ...args, unrelated: true }, undefined, undefined, {})).rejects.toThrow(`For ${args.action},`);
  }
});

test("SDK schema validation rejects unknown keys, empty identifiers and out-of-range values", () => {
  const h = harness();
  for (const args of [{ action: "spawn" }, { action: "list", unexpected: true }, { action: "status", id: "" },
    { action: "start", mode: "fresh", task: "", label: "review" }, { action: "join", ids: [""] },
    { action: "peek", id: "RUN_ID", limit: 101 }, { action: "start", seconds: 1801 }]) expect(() => h.validate(args)).toThrow("Validation failed");
});

test("tool schema and description are stable across registration and validation", () => {
  const a = harness(), b = harness(), before = JSON.stringify(a.tool.parameters);
  for (const call of calls) a.validate(call);
  expect(JSON.stringify(a.tool.parameters)).toBe(before);
  expect(JSON.stringify(b.tool.parameters)).toBe(before);
  expect(b.tool.description).toBe(a.tool.description);
});
