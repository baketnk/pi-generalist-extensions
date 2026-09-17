import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEventBus, SessionManager } from "@earendil-works/pi-coding-agent";
import subagents from "../extensions/subagents.ts";
import { loadModelConfig, modelRef, resolveWorkerModel, saveModelConfig, validateModelConfig } from "../lib/subagents/models.ts";

const ladder = { version: 1 as const, ladder: ["fixture/astra", "fixture/sol", "fixture/terra", "fixture/luna"] };
test("default/self/same preserve exact parent; explicit identifiers need no parent or ladder", () => {
  const parent = modelRef("fixture/astra"), noRead = () => { throw Error("must not read config"); };
  for (const choice of [undefined, "self", "same"]) {
    expect(resolveWorkerModel(choice, parent, noRead)).toEqual(parent);
    expect(resolveWorkerModel(choice, parent, noRead)).not.toBe(parent);
  }
  expect(resolveWorkerModel("other/org/fine-tuned:small", undefined, noRead)).toEqual({ provider: "other", id: "org/fine-tuned:small" });
  expect(() => resolveWorkerModel("self", undefined, noRead)).toThrow("Parent has no model");
  expect(() => modelRef("luna")).toThrow("exact"); expect(() => modelRef("fixture/a\u202e")).toThrow();
});

test("next-smaller is immediate configured successor, never guessing, wrapping or skipping", () => {
  for (let i = 0; i < 3; i++) expect(resolveWorkerModel("next-smaller", modelRef(ladder.ladder[i]!), () => ladder)).toEqual(modelRef(ladder.ladder[i + 1]!));
  expect(() => resolveWorkerModel("next-smaller", modelRef("fixture/luna"), () => ladder)).toThrow("smallest");
  expect(() => resolveWorkerModel("next-smaller", modelRef("fixture/unknown"), () => ladder)).toThrow("not in");
  expect(() => resolveWorkerModel("next-smaller", modelRef("fixture/astra"), () => undefined)).toThrow("No subagent model ladder");
  for (const value of [{ version: 1, ladder: ladder.ladder, allowedGraph: {} }, { version: 2, ladder: ladder.ladder }, { version: 1, ladder: ["fixture/a"] },
    { version: 1, ladder: ["fixture/a", "fixture/a"] }, { version: 1, ladder: ["fixture/a", "bare"] }]) expect(() => validateModelConfig(value)).toThrow();
});

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "subagent-models-"));
  const old = { agent: process.env.PI_CODING_AGENT_DIR, config: process.env.PI_SUBAGENTS_CONFIG };
  process.env.PI_CODING_AGENT_DIR = join(root, "agent"); process.env.PI_SUBAGENTS_CONFIG = join(root, "models.json");
  const manager = SessionManager.inMemory(root); manager.appendMessage({ role: "user", content: "synthetic history", timestamp: 1 });
  const handlers = new Map<string, Function>(), commands = new Map<string, any>(); let tool: any;
  const refs = ["synthetic/inspect", "synthetic/small", "other-synthetic/small"];
  const ctx: any = { cwd: root, mode: "print", hasUI: false, model: modelRef("synthetic/inspect"), sessionManager: manager,
    modelRegistry: { find: (p: string, id: string) => refs.includes(`${p}/${id}`) ? { provider: p, id } : undefined, hasConfiguredAuth: () => true },
    ui: { setStatus() {}, notify() {}, confirm: async () => true } };
  subagents({ on: (event: string, fn: Function) => handlers.set(event, fn), registerCommand: (name: string, cmd: any) => commands.set(name, cmd),
    registerTool: (t: any) => tool = t, registerFlag() {}, getFlag: (flag: string) => flag === "subagent-forks" ? true : "4", getThinkingLevel: () => "off", events: createEventBus() } as any,
    { home: join(root, "runs"), workerEntry: fileURLToPath(new URL("./fixtures/subagent-ipc.ts", import.meta.url)) });
  await handlers.get("session_start")!({}, ctx);
  const execute = async (params: any) => JSON.parse((await tool.execute(`call-${Math.random()}`, params, undefined, undefined, ctx)).content[0].text);
  return { root, ctx, manager, handlers, tool, execute, command: (args: string) => commands.get("subagents").handler(args, ctx),
    clean: async () => {
      await handlers.get("session_shutdown")!({}, ctx);
      for (const [key, value] of [["PI_CODING_AGENT_DIR", old.agent], ["PI_SUBAGENTS_CONFIG", old.config]] as const)
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      await rm(root, { recursive: true, force: true });
    } };
}

test("tool and human ladder command resolve concrete models, expose availability, and fence changed intent", async () => {
  const h = await harness();
  try {
    expect(loadModelConfig(join(h.root, "agent"))).toBeUndefined();
    await h.command("ladder synthetic/inspect synthetic/small");
    expect(loadModelConfig(join(h.root, "agent"))?.ladder).toEqual(["synthetic/inspect", "synthetic/small"]);
    expect((await h.execute({ action: "models" })).ladder).toEqual([
      { model: "synthetic/inspect", parentAvailable: true }, { model: "synthetic/small", parentAvailable: true },
    ]);
    const start = { action: "start", mode: "fresh", task: "hold", label: "fixture", operation: "same-op" };
    const run = await h.execute({ ...start, model: "next-smaller" }); expect(run.model).toEqual(modelRef("synthetic/small"));
    expect((await h.execute({ ...start, model: "synthetic/small" })).id).toBe(run.id);
    await expect(h.execute({ ...start, model: "self" })).rejects.toThrow("different intent");
    const explicit = await h.execute({ ...start, operation: "explicit", model: "other-synthetic/small" });
    expect(explicit.model).toEqual(modelRef("other-synthetic/small"));
    h.ctx.modelRegistry.find = () => undefined;
    expect((await h.execute({ ...start, operation: "explicit", model: "other-synthetic/small" })).id).toBe(explicit.id);
    await expect(h.execute({ ...start, operation: "new-unavailable", model: "other-synthetic/small" })).rejects.toThrow("unavailable");
    await expect(h.execute({ action: "list", model: "self" })).rejects.toThrow("not valid");
  } finally { await h.clean(); }
});

test("missing/unavailable next rung does not skip to an available model", async () => {
  const h = await harness();
  try {
    const start = { action: "start", mode: "fresh", task: "hold", label: "fixture", model: "next-smaller" };
    await expect(h.execute(start)).rejects.toThrow("No subagent model ladder");
    saveModelConfig(join(h.root, "agent"), { version: 1, ladder: ["synthetic/inspect", "missing/unavailable", "synthetic/small"] });
    await expect(h.execute(start)).rejects.toThrow("no fallback");
    expect((await h.execute({ action: "list" })).runs).toEqual([]);
  } finally { await h.clean(); }
});

test("fork grant is provider-scoped; explicit other-provider fork requires destination consent", async () => {
  const h = await harness();
  try {
    h.handlers.get("context_snapshot")!({ type: "context_snapshot", messages: [{ role: "user", content: "synthetic history", timestamp: 1 }],
      leafId: h.manager.getLeafId(), contextErrors: 0, providerRequestHooks: false }, h.ctx);
    const start = { action: "start", mode: "fork", task: "hold", label: "fixture", model: "other-synthetic/small" };
    await expect(h.execute(start)).rejects.toThrow("not authorized for the selected provider");
    let title = ""; h.ctx.hasUI = true; h.ctx.ui.confirm = async (text: string) => { title = text; return false; };
    await expect(h.execute(start)).rejects.toThrow("not authorized"); expect(title).toContain("other-synthetic/small");
    h.ctx.ui.confirm = async () => true;
    const run = await h.execute(start); expect(run.model).toEqual(modelRef("other-synthetic/small"));
    h.ctx.ui.confirm = async () => { throw Error("already granted this provider"); };
    await h.execute(start);
  } finally { await h.clean(); }
});

test("branch change during destination consent neither launches nor carries the grant forward", async () => {
  const h = await harness();
  try {
    h.handlers.get("context_snapshot")!({ type: "context_snapshot", messages: [{ role: "user", content: "synthetic history", timestamp: 1 }],
      leafId: h.manager.getLeafId(), contextErrors: 0, providerRequestHooks: false }, h.ctx);
    h.ctx.hasUI = true;
    h.ctx.ui.confirm = async () => { await h.handlers.get("session_tree")!({}, h.ctx); return true; };
    const start = { action: "start", mode: "fork", task: "hold", label: "fixture", model: "other-synthetic/small" };
    await expect(h.execute(start)).rejects.toThrow("changed during consent");
    expect((await h.execute({ action: "list" })).runs).toEqual([]);
    h.ctx.hasUI = false;
    await expect(h.execute(start)).rejects.toThrow("not authorized for the selected provider");
  } finally { await h.clean(); }
});
