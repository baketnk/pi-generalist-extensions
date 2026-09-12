import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import meitan from "../extensions/meitan.ts";
import optmem from "../extensions/optmem.ts";
import { hasLaunchOverrides, registerSessionSetup } from "../lib/session-setup.ts";
import { HISTORY_LIMIT, readHistory, rememberPreset, type ModelPreset } from "../lib/model-history.ts";
import { pickModel } from "../lib/model-picker.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp() { const dir = mkdtempSync(join(tmpdir(), "generalist-setup-")); dirs.push(dir); return dir; }
const alpha: any = { provider: "test", id: "alpha", name: "Alpha", reasoning: true };
const beta: any = { provider: "test", id: "beta", name: "Beta", reasoning: true,
  thinkingLevelMap: { minimal: null, low: null, medium: null, xhigh: null, max: "max" } };
const plain: any = { provider: "test", id: "plain", name: "Plain", reasoning: false };
const preset = (model = "alpha", thinking: ModelPreset["thinking"] = "medium"): ModelPreset => ({ provider: "test", model, thinking });

type Answer = number | string | undefined;
function harness(argv: string[] = [], historyPath = join(temp(), "history.json")) {
  const events: Record<string, Function[]> = {};
  const commands: Record<string, any> = {};
  const entries: any[] = [{ type: "model_change" }, { type: "thinking_level_change" }];
  const flags: Record<string, unknown> = {};
  const answers: Answer[] = [];
  const prompts: { title: string; options: string[] }[] = [];
  const notices: string[] = [];
  const changes: string[] = [];
  let active = ["read", "bash", "other"];
  let model = alpha;
  let thinking: ModelPreset["thinking"] = "medium";
  const ctx: any = {
    mode: "tui", hasUI: true, scopedModels: [],
    get model() { return model; },
    modelRegistry: { getAvailable: () => [alpha, beta, plain] },
    sessionManager: { getBranch: () => entries, getEntries: () => entries, getHeader: () => ({}), getSessionFile: () => undefined },
    waitForIdle: async () => { changes.push("idle"); },
    ui: {
      setStatus() {}, notify: (text: string) => notices.push(text),
      select: async (title: string, options: string[]) => {
        prompts.push({ title, options });
        const answer = answers.shift();
        return typeof answer === "number" ? options[answer] : answer;
      },
      custom: async () => {
        prompts.push({ title: "Browse models", options: [] });
        return answers.shift();
      },
    },
  };
  const pi: any = {
    on: (name: string, fn: Function) => (events[name] ??= []).push(fn),
    registerFlag: (name: string, def: any) => { flags[name] ??= def.default; }, getFlag: (name: string) => flags[name],
    registerCommand: (name: string, def: any) => commands[name] = def,
    registerTool: (def: any) => active.push(def.name),
    getActiveTools: () => active, setActiveTools: (names: string[]) => active = names,
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    getThinkingLevel: () => thinking,
    setModel: async (value: any) => { model = value; changes.push(`model:${model.id}`); return true; },
    setThinkingLevel: (level: ModelPreset["thinking"]) => { thinking = level; changes.push(`thinking:${level}`); },
  };
  const toggles = { meitan: meitan(pi), optmem: optmem(pi) };
  registerSessionSetup(pi, toggles, { argv, historyPath });
  const emit = async (name: string, event: any = { reason: "startup" }) => {
    for (const fn of events[name] ?? []) await fn(event, ctx);
  };
  return { pi, ctx, toggles, emit, commands, entries, flags, answers, prompts, notices, changes, historyPath };
}

test("fresh session asks personality first, records both off/on decisions, then keeps current preset", async () => {
  const h = harness();
  h.answers.push(3, 0);
  await h.emit("session_start");
  expect(h.prompts.map(p => p.title)).toEqual(["1/2 · Personality / memory", "2/2 · Model / thinking preset (most recent first)"]);
  expect(h.toggles.meitan()).toBe(true);
  expect(h.toggles.optmem()).toBe(true);
  expect(h.pi.getActiveTools()).toEqual(["read", "bash", "other", "memo"]);
  expect(readHistory(h.historyPath)).toEqual([preset()]);
  expect(h.changes).toEqual([]); // Keep current doesn't set model or thinking.
  await h.emit("session_start", { reason: "reload" });
  await h.emit("session_start"); // even duplicate startup delivery doesn't re-prompt
  expect(h.prompts).toHaveLength(2);
  expect(h.toggles.meitan()).toBe(true);
  await h.commands.meitan.handler("off", h.ctx);
  await h.emit("session_tree");
  expect(h.toggles.meitan()).toBe(false);
  h.entries.pop();
  await h.emit("session_tree");
  expect(h.toggles.meitan()).toBe(true);
});

test("MRU pairs appear first, selection promotes them and applies model before thinking", async () => {
  const h = harness();
  rememberPreset(h.historyPath, preset("beta", "max"));
  rememberPreset(h.historyPath, preset());
  h.answers.push(1, 1);
  await h.emit("session_start");
  expect(h.prompts[1].options.slice(0, 2)).toEqual(["Recent — test/alpha · medium", "Recent — test/beta · max"]);
  expect(h.changes).toEqual(["model:beta", "thinking:max"]);
  expect(readHistory(h.historyPath)[0]).toEqual(preset("beta", "max"));
  expect(h.toggles.meitan()).toBe(false);
  expect(h.toggles.optmem()).toBe(true);
});

test("browse creates a preset using only supported thinking levels", async () => {
  const h = harness();
  h.answers.push(0, 1, "1", "max"); // plain, browse, beta, max
  await h.emit("session_start");
  expect(h.prompts[3].options).toEqual(["off", "high", "max"]);
  expect(h.changes).toEqual(["model:beta", "thinking:max"]);
  expect(readHistory(h.historyPath)).toEqual([preset("beta", "max")]);
  expect(h.toggles.meitan()).toBe(false);
  expect(h.toggles.optmem()).toBe(false);
});

test("scoped models restrict browse/history, and scope thinking preference leads", async () => {
  const h = harness();
  h.ctx.scopedModels = [{ model: beta, thinkingLevel: "max" }];
  rememberPreset(h.historyPath, preset());
  rememberPreset(h.historyPath, preset("beta", "medium")); // no longer supported
  rememberPreset(h.historyPath, preset("missing"));
  h.answers.push(0, 1, "0", "high");
  await h.emit("session_start");
  expect(h.prompts[1].options).toHaveLength(2); // keep + browse, all stale/out-of-scope pairs hidden
  expect(h.prompts[3].options).toEqual(["max", "off", "high"]);
  expect(h.ctx.model.id).toBe("beta");
});

test("non-reasoning models offer off only", async () => {
  const h = harness();
  h.answers.push(0, 1, "2", "off");
  await h.emit("session_start");
  expect(h.prompts[3].options).toEqual(["off"]);
  expect(readHistory(h.historyPath)[0]).toEqual(preset("plain", "off"));
});

test("cancel at any stage preserves model/thinking; initial cancel changes no toggles", async () => {
  for (const answers of [[undefined], [3, undefined], [3, 1, undefined], [3, 1, "1", undefined]] as Answer[][]) {
    const h = harness(); h.answers.push(...answers);
    await h.emit("session_start");
    expect(h.changes).toEqual([]);
    expect(readHistory(h.historyPath)).toEqual([]);
    expect(h.toggles.meitan()).toBe(answers.length > 1);
    await h.emit("session_start", { reason: "reload" });
    expect(h.prompts).toHaveLength(answers.length);
  }
});

test("explicit launch configuration, prompts, and resume flags never trigger questions", async () => {
  for (const argv of [["--model", "alpha"], ["--model=alpha"], ["--provider", "test"], ["--thinking", "high"],
    ["--models", "*"], ["--meitan"], ["--optmem=false"], ["--preset", "work"], ["--no-session-setup"],
    ["-c"], ["--resume"], ["--session", "a.jsonl"], ["--fork", "a.jsonl"], ["--session-id", "id"],
    ["Help me"], ["--", "--model"], ["@prompt.md"], ["--some-launcher-flag"]]) {
    const h = harness(argv); await h.emit("session_start");
    expect(h.prompts).toEqual([]);
    expect(h.changes).toEqual([]);
    expect(readHistory(h.historyPath)).toEqual([]);
  }
  expect(hasLaunchOverrides(["-e", "/ext.ts", "--name", "--model", "--offline", "--no-session"])).toBe(false);
  expect(hasLaunchOverrides(["--name=hi", "--tui-mode", "fullscreen", "--"])).toBe(false);
});

test("saved sessions, forks, reload/resume and non-TUI modes are untouched", async () => {
  for (const reason of ["reload", "resume", "fork"]) {
    const h = harness(); await h.emit("session_start", { reason }); expect(h.prompts).toEqual([]);
  }
  for (const mode of ["print", "json", "rpc"]) {
    const h = harness(); h.ctx.mode = mode; // RPC hasUI=true must still not prompt
    await h.emit("session_start");
    await h.commands["session-setup"].handler("", h.ctx);
    await h.emit("before_agent_start", { systemPrompt: "base" });
    expect(h.prompts).toEqual([]); expect(readHistory(h.historyPath)).toEqual([]);
  }
  for (const entry of [{ type: "message" }, { type: "custom", customType: "generalist:meitan:enabled", data: { enabled: false } }]) {
    const h = harness(); h.entries.push(entry); await h.emit("session_start"); expect(h.prompts).toEqual([]);
  }
  const persisted = harness();
  const file = join(temp(), "session.jsonl"); writeFileSync(file, "");
  persisted.ctx.sessionManager.getSessionFile = () => file;
  await persisted.emit("session_start"); expect(persisted.prompts).toEqual([]);
  const forked = harness(); forked.ctx.sessionManager.getHeader = () => ({ parentSession: "old.jsonl" });
  await forked.emit("session_start"); expect(forked.prompts).toEqual([]);
});

test("CLI flags seed independently and saved toggle decisions still win", async () => {
  const h = harness(); h.flags.meitan = true; h.flags.optmem = true;
  h.entries.push({ type: "custom", customType: "generalist:optmem:enabled", data: { enabled: false } });
  await h.emit("session_start");
  expect(h.prompts).toEqual([]);
  expect(h.toggles.meitan()).toBe(true); expect(h.toggles.optmem()).toBe(false);
});

test("/new asks again; manual command works despite launch flags and waits for idle", async () => {
  const h = harness(["--model", "alpha"]); h.answers.push(0, 0);
  await h.commands["session-setup"].handler("", h.ctx);
  expect(h.changes[0]).toBe("idle"); expect(h.prompts).toHaveLength(2);
  const fresh = harness(); fresh.answers.push(0, 0);
  await fresh.emit("session_start"); fresh.entries.length = 0;
  fresh.answers.push(1, 0); await fresh.emit("session_start", { reason: "new" });
  expect(fresh.prompts).toHaveLength(4); expect(fresh.toggles.optmem()).toBe(true);
});

test("failed authentication keeps thinking and history unchanged", async () => {
  const h = harness(); rememberPreset(h.historyPath, preset("beta", "max"));
  h.pi.setModel = async () => false;
  h.answers.push(0, 0); await h.emit("session_start");
  expect(h.changes).toEqual([]); expect(h.ctx.model.id).toBe("alpha");
  expect(h.notices[0]).toContain("authentication unavailable");
  expect(readHistory(h.historyPath)).toEqual([preset("beta", "max")]);
});

test("history is bounded, unique by full pair, persistent across instances, and malformed files survive", async () => {
  const path = join(temp(), "nested", "history.json");
  for (let i = 0; i < 12; i++) rememberPreset(path, preset(`model-${i}`));
  expect(readHistory(path)).toHaveLength(HISTORY_LIMIT);
  rememberPreset(path, preset("model-6")); expect(readHistory(path)[0].model).toBe("model-6");
  rememberPreset(path, preset("model-6", "high"));
  expect(readHistory(path).slice(0, 2).map(p => p.thinking)).toEqual(["high", "medium"]);
  const h = harness([], path); h.answers.push(0, 0); await h.emit("session_start");
  expect(readHistory(path)[0]).toEqual(preset());
  writeFileSync(path, "broken");
  const broken = harness([], path); broken.answers.push(0, 0); await broken.emit("session_start");
  expect(broken.notices).toHaveLength(1); expect(broken.notices[0]).toContain("history unavailable");
  expect(readFileSync(path, "utf8")).toBe("broken");
  expect(broken.prompts).toHaveLength(2);
});

test("empty model catalogue and unwritable history are nonfatal", async () => {
  const h = harness(); h.ctx.modelRegistry.getAvailable = () => [];
  h.answers.push(0, 1); await h.emit("session_start");
  expect(h.notices[0]).toContain("No available models");
  const bad = harness([], join(temp(), "parent", "history.json"));
  writeFileSync(join(bad.historyPath, ".."), "not a directory");
  bad.answers.push(0, 0); await bad.emit("session_start");
  expect(bad.notices).toHaveLength(1); expect(bad.prompts).toHaveLength(2);
});

test("combinations actually used after model/thinking changes are learned without startup prompts", async () => {
  const h = harness(["--model", "alpha"]);
  await h.emit("session_start");
  await h.pi.setModel(beta); h.pi.setThinkingLevel("max");
  await h.emit("before_agent_start", { systemPrompt: "base" });
  expect(readHistory(h.historyPath)[0]).toEqual(preset("beta", "max"));
  expect(h.prompts).toEqual([]);
});

test("searchable model picker handles text, selection, cancellation, focus and narrow rendering", async () => {
  let component: any;
  const ctx: any = { ui: { custom: (factory: Function) => new Promise(resolve => {
    component = factory({ requestRender() {} }, { fg: (_: string, s: string) => s },
      { matches: (data: string, key: string) => (data === "\r" && key === "tui.select.confirm") || (data === "\x1b" && key === "tui.select.cancel") }, resolve);
  }) } };
  const items = [{ value: "a", label: "test/alpha" }, { value: "b", label: "test/beta" }];
  const chosen = pickModel(ctx, items);
  component.focused = true; expect(component.focused).toBe(true);
  component.handleInput("beta");
  expect(component.render(40).join("\n")).toContain("test/beta");
  expect(component.render(40).join("\n")).not.toContain("test/alpha");
  for (const line of component.render(20)) expect(visibleWidth(line)).toBeLessThanOrEqual(20);
  component.invalidate(); component.handleInput("\r"); expect(await chosen).toBe("b");
  const cancelled = pickModel(ctx, items); component.handleInput("\x1b"); expect(await cancelled).toBeUndefined();
});
