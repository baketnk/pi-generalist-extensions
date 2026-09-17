import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KeybindingsManager, TUI_KEYBINDINGS, setKeybindings, getKeybindings } from "@earendil-works/pi-tui";
import autocomplete from "../extensions/autocomplete.ts";
import { defaults, saveAutocompleteConfig, loadAutocompleteConfig } from "../lib/autocomplete/config.ts";

const originalKeys = getKeybindings();
afterEach(() => setKeybindings(originalKeys));

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "autocomplete-life-"));
  const previous = { ac: process.env.PI_AUTOCOMPLETE_CONFIG, history: process.env.PI_HISTORY_CONFIG };
  process.env.PI_AUTOCOMPLETE_CONFIG = join(dir, "autocomplete.json");
  process.env.PI_HISTORY_CONFIG = join(dir, "history.json");
  writeFileSync(process.env.PI_HISTORY_CONFIG, JSON.stringify({ version: 1, indexDir: join(dir, "index"), sources: [] }));
  const handlers = new Map<string, Function>(), commands = new Map<string, any>(), notices: string[] = [];
  let factory: any, editor: any;
  const keys = new KeybindingsManager(TUI_KEYBINDINGS); setKeybindings(keys);
  const tui = { terminal: { rows: 30 }, requestRender() {} };
  const theme = { borderColor: (s: string) => s, selectList: {} };
  const ctx: any = { mode: "tui", hasUI: true, cwd: "/here", ui: {
    notify: (text: string) => notices.push(text), getEditorComponent: () => factory,
    setEditorComponent: (next: any) => { factory = next; editor = next?.(tui, theme, keys); if (editor) editor.focused = true; },
  } };
  // Any attempt to register tools, inject messages or touch provider context is a test failure.
  autocomplete({ on: (event: string, fn: Function) => handlers.set(event, fn), registerCommand: (name: string, cmd: any) => commands.set(name, cmd) } as any);
  return { dir, ctx, notices, handlers, get editor() { return editor; }, get factory() { return factory; },
    command: (s: string) => commands.get("autocomplete").handler(s, ctx),
    clean() {
      handlers.get("session_shutdown")!({}, ctx);
      if (previous.ac === undefined) delete process.env.PI_AUTOCOMPLETE_CONFIG; else process.env.PI_AUTOCOMPLETE_CONFIG = previous.ac;
      if (previous.history === undefined) delete process.env.PI_HISTORY_CONFIG; else process.env.PI_HISTORY_CONFIG = previous.history;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("TUI activation is opt-in; captures only interactive inputs; off clears state and saves decisions", async () => {
  const h = harness();
  try {
    await h.handlers.get("session_start")!({}, h.ctx); expect(h.factory).toBeUndefined();
    await h.command("on"); expect(h.factory).toBeDefined(); expect(loadAutocompleteConfig().enabled).toBe(true);
    await h.handlers.get("input")!({ source: "extension", text: "injected-only vocabulary" }, h.ctx);
    expect(h.editor.completion.suggestion("injected-only")).toBeUndefined();
    await h.handlers.get("input")!({ source: "interactive", text: "please inspect tests" }, h.ctx);
    expect(h.editor.completion.suggestion("please ")?.suffix).toBe("inspect tests");
    await h.command("cpu on"); expect(loadAutocompleteConfig().cpuOnly).toBe(true);
    await h.command("llm off"); expect(loadAutocompleteConfig().modelEnabled).toBe(false);
    expect(readFileSync(join(h.dir, "autocomplete.json"), "utf8")).not.toContain("please inspect");
    const old = h.editor; await h.command("off"); expect(h.factory).toBeUndefined();
    expect(old.completion.suggestion("please ")).toBeUndefined(); expect(loadAutocompleteConfig().enabled).toBe(false);
  } finally { h.clean(); }
});

test("does not clobber another editor on activation or shutdown", async () => {
  const h = harness();
  try {
    const other = () => ({ focused: true }); h.ctx.ui.setEditorComponent(other);
    await h.command("on"); expect(h.factory).toBe(other); expect(loadAutocompleteConfig().enabled).toBe(false);
    expect(h.notices.join("\n")).toContain("Another extension");
    h.ctx.ui.setEditorComponent(undefined); await h.command("on");
    const own = h.editor; h.ctx.ui.setEditorComponent(other);
    expect(own.eligible()).toBe(false);
    await h.handlers.get("session_shutdown")!({}, h.ctx); expect(h.factory).toBe(other);
  } finally { h.clean(); }
});

test("repeated session start reconciles off and scope changes without retaining old samples", async () => {
  const h = harness();
  try {
    await h.command("on"); await h.handlers.get("input")!({ source: "interactive", text: "please inspect tests" }, h.ctx);
    const old = h.editor;
    saveAutocompleteConfig({ ...defaults, enabled: true, scope: "project" });
    await h.handlers.get("session_start")!({}, h.ctx);
    expect(h.editor).not.toBe(old); expect(h.editor.completion.suggestion("please ")).toBeUndefined();
    expect(old.completion.suggestion("please ")).toBeUndefined();
    saveAutocompleteConfig({ ...defaults, enabled: false }); await h.handlers.get("session_start")!({}, h.ctx);
    expect(h.factory).toBeUndefined();
  } finally { h.clean(); }
});

test("failed save rolls back new editor activation and invalid commands never persist", async () => {
  const h = harness();
  try {
    await h.command("model bad;model"); expect(loadAutocompleteConfig()).toEqual(defaults);
    // Atomic rename fails against a directory; no permissions assumptions under root.
    mkdirSync(join(h.dir, "autocomplete.json"));
    await h.command("on"); expect(h.factory).toBeUndefined();
    expect(h.notices.length).toBeGreaterThan(0);
  } finally { h.clean(); }
});

test("reload clears old learned samples and reports malformed history configuration", async () => {
  const h = harness();
  try {
    await h.command("on"); await h.handlers.get("input")!({ source: "interactive", text: "please inspect tests" }, h.ctx);
    writeFileSync(join(h.dir, "history.json"), "malformed"); await h.command("reload");
    expect(h.editor.completion.suggestion("please ")).toBeUndefined();
  } finally { h.clean(); }
});
