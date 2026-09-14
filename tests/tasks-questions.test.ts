import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import questions, { QUESTION_STATE_ENTRY, QuestionOverlay } from "../extensions/questions.ts";
import tasks, { TASK_STATE_ENTRY, validateTaskState } from "../extensions/tasks.ts";

function harness(register: (pi: any) => void, initialEntries: any[] = []) {
  const events: Record<string, Function[]> = {};
  const tools: Record<string, any> = {};
  const commands: Record<string, any> = {};
  const shortcuts: Record<string, any> = {};
  const entries = initialEntries;
  const statuses: Record<string, unknown> = {};
  const widgets: Record<string, unknown> = {};
  const notices: string[] = [];
  const sent: Array<{ text: string; options?: { deliverAs: "steer" } }> = [];
  const selections: Array<string | undefined> = [];
  const inputs: Array<string | undefined> = [];
  let waits = 0;
  let idle = true;
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const pi: any = {
    on: (name: string, fn: Function) => (events[name] ??= []).push(fn),
    registerTool: (tool: any) => tools[tool.name] = tool,
    registerCommand: (name: string, command: any) => commands[name] = command,
    registerShortcut: (key: string, shortcut: any) => shortcuts[key] = shortcut,
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    sendUserMessage: (text: string, options?: { deliverAs: "steer" }) => sent.push({ text, options }),
  };
  const ctx: any = {
    hasUI: true,
    mode: "tui",
    isIdle: () => idle,
    waitForIdle: async () => { waits++; },
    sessionManager: { getBranch: () => entries },
    ui: {
      theme,
      setStatus: (key: string, value: unknown) => statuses[key] = value,
      setWidget: (key: string, value: unknown) => widgets[key] = value,
      notify: (text: string) => notices.push(text),
      select: async (_title: string, choices: string[]) => selections.length ? selections.shift() : choices[0],
      input: async () => inputs.shift(),
      custom: async () => undefined,
    },
  };
  register(pi);
  const emit = async (name: string, event = {}) => {
    for (const fn of events[name] ?? []) await fn(event, ctx);
  };
  return { pi, ctx, events, tools, commands, shortcuts, entries, statuses, widgets, notices, sent, selections, inputs, emit,
    waits: () => waits, setIdle: (value: boolean) => idle = value };
}

const resultEntry = (toolName: string, details: unknown) => ({
  type: "message",
  message: { role: "toolResult", toolName, details, content: [{ type: "text", text: "ok" }] },
});

test("update_plan replaces state atomically, validates progress, restores branches and clears", async () => {
  const h = harness(tasks);
  await h.emit("session_start");
  expect(h.statuses["generalist-tasks"]).toBeUndefined();
  const first = await h.tools.update_plan.execute("call", {
    explanation: "Starting implementation",
    plan: [
      { step: "Inspect", status: "completed" },
      { step: "Implement", status: "in_progress" },
      { step: "Test", status: "pending" },
    ],
  }, undefined, undefined, h.ctx);
  expect(first.content[0].text).toContain("Plan updated");
  expect(h.statuses["generalist-tasks"]).toBe("tasks: 1/3");
  expect((h.widgets["generalist-tasks"] as string[]).join("\n")).toContain("Implement");
  expect(() => validateTaskState({ plan: [
    { step: "One", status: "in_progress" }, { step: "Two", status: "in_progress" },
  ] })).toThrow("At most one");
  await expect(h.tools.update_plan.execute("call", { plan: [
    { step: "One", status: "in_progress" }, { step: "Two", status: "in_progress" },
  ] }, undefined, undefined, h.ctx)).rejects.toThrow("At most one");

  h.entries.push(resultEntry("update_plan", first.details));
  const second = await h.tools.update_plan.execute("call", { plan: [{ step: "Test", status: "completed" }] }, undefined, undefined, h.ctx);
  h.entries.push(resultEntry("update_plan", second.details));
  await h.emit("session_tree");
  expect(h.statuses["generalist-tasks"]).toBe("tasks: 1/1");
  h.entries.pop();
  await h.emit("session_tree");
  expect(h.statuses["generalist-tasks"]).toBe("tasks: 1/3");

  await h.commands.tasks.handler("clear", h.ctx);
  expect(h.entries.at(-1).customType).toBe(TASK_STATE_ENTRY);
  expect(h.widgets["generalist-tasks"]).toBeUndefined();
  expect(h.waits()).toBe(1);
});

test("ask_user handles choices, free text and cancellation as a blocking tool", async () => {
  const h = harness(questions); h.ctx.mode = "rpc";
  h.selections.push("2. Small — Lower risk", "Write another answer…");
  h.inputs.push("SQLite");
  const result = await h.tools.ask_user.execute("call", { questions: [
    { id: "scope", title: "How large?", options: [{ label: "Large" }, { label: "Small", description: "Lower risk" }] },
    { id: "store", title: "Which store?", options: [{ label: "Files" }] },
  ] }, undefined, undefined, h.ctx);
  expect(result.content[0].text).toContain("[scope]");
  expect(result.content[0].text).toContain("Answer: Small");
  expect(result.content[0].text).toContain("Answer: SQLite");

  h.selections.push(undefined);
  const cancelled = await h.tools.ask_user.execute("call", { questions: [
    { id: "again", title: "Continue?", options: [{ label: "Yes" }] },
  ] }, undefined, undefined, h.ctx);
  expect(cancelled.details.cancelled).toBe(true);
});

test("queue_questions returns immediately; /questions answers later as a user message", async () => {
  const h = harness(questions);
  await h.emit("session_start");
  const queued = await h.tools.queue_questions.execute("call", { questions: [
    { id: "color", title: "Which color?", options: [{ label: "Blue" }, { label: "Green" }] },
  ] }, undefined, undefined, h.ctx);
  expect(queued.content[0].text).toContain("Continue useful work");
  expect(h.sent).toEqual([]);
  expect(h.statuses["generalist-questions"]).toBe("questions: 1");
  expect((h.widgets["generalist-questions"] as string[]).join("\n")).toContain("/questions");

  h.entries.push(resultEntry("queue_questions", queued.details));
  h.ctx.mode = "rpc";
  h.selections.push("2. Green");
  await h.commands.questions.handler("", h.ctx);
  expect(h.waits()).toBe(0);
  expect(h.entries.at(-1).customType).toBe(QUESTION_STATE_ENTRY);
  expect(h.statuses["generalist-questions"]).toBeUndefined();
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]!.text).toContain("batch 1");
  expect(h.sent[0]!.text).toContain("Answer: Green");
  expect(h.sent[0]!.options).toBeUndefined();
});

test("queued questions survive reload and cancellation, and branch state rewinds", async () => {
  const h = harness(questions);
  const first = await h.tools.queue_questions.execute("call", { questions: [
    { id: "one", title: "First?", options: [{ label: "A" }] },
  ] }, undefined, undefined, h.ctx);
  h.entries.push(resultEntry("queue_questions", first.details));
  const second = await h.tools.queue_questions.execute("call", { questions: [
    { id: "two", title: "Second?", options: [{ label: "B" }] },
  ] }, undefined, undefined, h.ctx);
  h.entries.push(resultEntry("queue_questions", second.details));

  const restored = harness(questions, JSON.parse(JSON.stringify(h.entries)));
  await restored.emit("session_start");
  expect(restored.statuses["generalist-questions"]).toBe("questions: 2");
  restored.ctx.mode = "rpc";
  restored.selections.push("Batch 2 · Second?", undefined);
  await restored.commands.questions.handler("", restored.ctx);
  expect(restored.sent).toEqual([]);
  expect(restored.statuses["generalist-questions"]).toBe("questions: 2");

  restored.entries.pop();
  await restored.emit("session_tree");
  expect(restored.statuses["generalist-questions"]).toBe("questions: 1");
  await restored.commands.questions.handler("clear", restored.ctx);
  expect(restored.statuses["generalist-questions"]).toBeUndefined();
});

test("question overlay is compact, keyboard-driven, and retains multi-question answers", async () => {
  let finish!: (value: any) => void;
  const result = new Promise(resolve => finish = resolve);
  const tui: any = { terminal: { rows: 30 }, requestRender() {} };
  const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const keys: any = { matches: (data: string, action: string) => data === "\x1b" && action === "tui.select.cancel" };
  const component = new QuestionOverlay(tui, theme, keys, [
    { id: "size", title: "Choose a scope", options: [{ label: "Large" }, { label: "Small", description: "Lower risk" }] },
    { id: "store", title: "Name the storage backend" },
  ], finish, 7);
  component.focused = true;
  expect(component.render(60).join("\n")).toContain("╭──────────────────────────────────────────────────────────╮");
  expect(component.render(60).join("\n")).toContain("Questions · batch 7");
  expect(component.render(60).join("\n")).toContain("Lower risk");
  for (const line of component.render(24)) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
  component.handleInput("2");
  expect(component.render(60).join("\n")).toContain("Name the storage backend");
  for (const char of "SQLite") component.handleInput(char);
  component.handleInput("\r");
  expect(await result).toEqual([
    { id: "size", title: "Choose a scope", answer: "Small" },
    { id: "store", title: "Name the storage backend", answer: "SQLite" },
  ]);
});

test("the question shortcut opens the oldest batch and preserves cancellation", async () => {
  const h = harness(questions);
  const queued = await h.tools.queue_questions.execute("call", { questions: [
    { id: "choice", title: "Choose?", options: [{ label: "A" }] },
  ] }, undefined, undefined, h.ctx);
  h.entries.push(resultEntry("queue_questions", queued.details));
  expect(h.shortcuts["ctrl+shift+q"].description).toContain("oldest");
  await h.shortcuts["ctrl+shift+q"].handler(h.ctx); // mocked custom UI cancels
  expect(h.sent).toEqual([]);
  expect(h.statuses["generalist-questions"]).toBe("questions: 1");
});

test("answers to queued questions steer an active turn instead of waiting for idle", async () => {
  const h = harness(questions);
  const queued = await h.tools.queue_questions.execute("call", { questions: [
    { id: "priority", title: "Which first?", options: [{ label: "Tests" }] },
  ] }, undefined, undefined, h.ctx);
  h.entries.push(resultEntry("queue_questions", queued.details));
  h.ctx.mode = "rpc";
  h.setIdle(false);
  h.selections.push("1. Tests");
  await h.commands.questions.handler("", h.ctx);
  expect(h.waits()).toBe(0);
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]!.options).toEqual({ deliverAs: "steer" });
  expect(h.sent[0]!.text).toContain("Answer: Tests");
});
