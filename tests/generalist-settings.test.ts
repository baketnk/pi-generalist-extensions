import { expect, test } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { isGeneralistSaveKey, registerGeneralistSettings } from "../extensions/generalist-settings.ts";

function harness(configureHousekeeping?: (ctx: any) => Promise<void>, memoryMethods: object = {}, defaults?: any) {
  const commands: Record<string, any> = {};
  const events: Record<string, any> = {};
  const changes: Array<[string, boolean]> = [];
  const enabled = { meitan: false, memory: false };
  const feature = (name: "meitan" | "memory") => Object.assign(
    () => enabled[name],
    { set(value: boolean) { enabled[name] = value; changes.push([name, value]); } },
  );
  const notices: Array<[string, string]> = [];
  const entries: any[] = [];
  const ctx: any = {
    hasUI: true,
    mode: "rpc",
    sessionManager: { getBranch: () => entries },
    waitForIdle: async () => {},
    ui: { notify: (text: string, level: string) => notices.push([text, level]) },
  };
  registerGeneralistSettings({
    on: (event: string, handler: any) => events[event] = handler,
    registerCommand: (name: string, command: any) => commands[name] = command,
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
  } as any, { meitan: feature("meitan"), memory: Object.assign(feature("memory"), { configureHousekeeping }, memoryMethods) }, defaults);
  return { commands, changes, enabled, notices, entries, events, ctx };
}

test("/generalist manages the bundle's branch-local feature controllers", async () => {
  const h = harness();
  await h.commands.generalist.handler("meitan on", h.ctx);
  await h.commands.generalist.handler("memory toggle", h.ctx);
  expect(h.enabled).toEqual({ meitan: true, memory: true });
  expect(h.changes).toEqual([["meitan", true], ["memory", true]]);

  await h.commands.generalist.handler("status", h.ctx);
  expect(h.notices.at(-1)).toEqual(["meitan: on · memory: on · output: off", "info"]);
});

test("/generalist rejects malformed non-TUI input without changing settings", async () => {
  const h = harness();
  await h.commands.generalist.handler("meitan", h.ctx);
  await h.commands.generalist.handler("history on", h.ctx);
  expect(h.changes).toEqual([]);
  expect(h.notices.map(([text]) => text)).toEqual([
    "Usage: /generalist [status|meitan|memory|output] [on|off|toggle]",
    "Usage: /generalist [status|meitan|memory|output] [on|off|toggle]",
  ]);
});

test("Generalist recognizes Pi's configurable Ctrl+S save binding", () => {
  const keys = { matches: (data: string, action: string) => data === "save" && action === "app.models.save" };
  expect(isGeneralistSaveKey(keys, "save")).toBe(true);
  expect(isGeneralistSaveKey(keys, "other")).toBe(false);
});

test("saved defaults seed output only when the branch has no explicit choice", async () => {
  const defaults = { version: 1, meitan: false, output: true } as const;
  const h = harness(undefined, {}, defaults);
  h.events.session_start({}, h.ctx);
  expect(h.entries.at(-1)).toEqual({ type: "custom", customType: "generalist:output-config-v1", data: { rawJson: true } });
  h.entries.length = 0;
  h.entries.push({ type: "custom", customType: "generalist:output-config-v1", data: { rawJson: false } });
  h.events.session_start({}, h.ctx);
  expect(h.entries).toHaveLength(1);
});

test("/generalist output toggles branch-local raw JSON diagnostics", async () => {
  const h = harness();
  await h.commands.generalist.handler("output on", h.ctx);
  expect(h.entries.at(-1)).toEqual({ type: "custom", customType: "generalist:output-config-v1", data: { rawJson: true } });
  await h.commands.generalist.handler("output toggle", h.ctx);
  expect(h.entries.at(-1)?.data).toEqual({ rawJson: false });
});

test("/generalist housekeeping delegates to native settings without enabling memory", async () => {
  let called = 0;
  const h = harness(async ctx => { expect(ctx).toBe(h.ctx); called++; });
  await h.commands.generalist.handler("housekeeping", h.ctx);
  expect(called).toBe(1); expect(h.changes).toEqual([]);
  await h.commands.generalist.handler("memory on garbage", h.ctx);
  expect(h.changes).toEqual([]);
});

test("TUI settings contain a real housekeeping entry and open it after closing the list", async () => {
  initTheme("dark", false);
  let configured = false;
  const h = harness(async () => { configured = true; }); h.ctx.mode = "tui";
  h.ctx.ui.custom = async (factory: any) => {
    let selected: string | undefined;
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const component = factory({ requestRender() {} }, theme, { matches: () => false }, (value: string) => selected = value);
    expect(component.render(100).join("\n")).toContain("Memory housekeeping model");
    const heights = [component.render(40).length];
    component.handleInput("\x1b[B"); heights.push(component.render(40).length);
    component.handleInput("\x1b[B"); heights.push(component.render(40).length);
    expect(new Set(heights).size).toBe(1);
    component.handleInput("\x1b[B"); component.handleInput("\r");
    expect(configured).toBe(false); return selected;
  };
  await h.commands.generalist.handler("", h.ctx);
  expect(configured).toBe(true);
});

test("personal/pairing settings are independent; companion is an explicit combined action", async () => {
  const opened: string[] = [];
  const h = harness(undefined, {
    configurePersonal: async () => { opened.push("personal"); },
    configurePairing: async () => { opened.push("pairing"); },
    enableDefault: () => { h.enabled.memory = true; },
  });
  await h.commands.generalist.handler("personal", h.ctx); await h.commands.generalist.handler("pairing", h.ctx);
  expect(opened).toEqual(["personal", "pairing"]); expect(h.enabled).toEqual({ meitan: false, memory: false });
  await h.commands.generalist.handler("meitan on", h.ctx); expect(h.enabled.memory).toBe(false);
  await h.commands.generalist.handler("companion", h.ctx); expect(h.enabled).toEqual({ meitan: true, memory: true });
  const failing = harness(undefined, { enableDefault: () => { throw new Error("No personal config"); } });
  await expect(failing.commands.generalist.handler("companion", failing.ctx)).rejects.toThrow("No personal config");
  expect(failing.enabled).toEqual({ meitan: false, memory: false });
});
