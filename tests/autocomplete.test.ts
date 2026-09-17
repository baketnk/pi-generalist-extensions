import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CURSOR_MARKER, visibleWidth, setKeybindings, getKeybindings, KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { Predictor, cleanText, usablePrompt, MAX_SAMPLES } from "../lib/autocomplete/predictor.ts";
import { CompletionController } from "../lib/autocomplete/controller.ts";
import { readCorpus } from "../lib/autocomplete/corpus.ts";
import { defaults, loadAutocompleteConfig, saveAutocompleteConfig, validateConfig } from "../lib/autocomplete/config.ts";
import { completeOllama } from "../lib/autocomplete/ollama.ts";
import { drawGhost, GhostEditor } from "../lib/autocomplete/editor.ts";
import autocomplete from "../extensions/autocomplete.ts";
import { HistoryIndex } from "../lib/history/index.ts";
import type { HistoryConfig } from "../lib/history/types.ts";

const originalKeys = getKeybindings();
afterEach(() => setKeybindings(originalKeys));

const sample = (text: string, cwd = "/here") => ({ text, cwd });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; }
function editor(predictor = new Predictor([sample("please run the tests")]), complete = async () => "the new tests") {
  const keys = new KeybindingsManager(TUI_KEYBINDINGS); setKeybindings(keys);
  const tui = { terminal: { rows: 30, columns: 80 }, requestRender() {} } as any;
  const theme = { borderColor: (s: string) => s, selectList: { selectedPrefix: (s: string) => s, selectedText: (s: string) => s,
    description: (s: string) => s, scrollInfo: (s: string) => s, noMatch: (s: string) => s } } as any;
  const e = new GhostEditor(tui, theme, keys as any, predictor, complete, () => true, () => true, () => {});
  e.focused = true;
  return { e, tui, theme, keys };
}

test("history suffixes prefer exact project; ngrams back off and complete partial words", () => {
  const p = new Predictor([sample("please run lint", "/other"), sample("please run tests"), sample("can we inspect files")], "/here");
  expect(p.suggest("please run ")).toEqual({ suffix: "tests", source: "history" });
  expect(p.suggest("could you please run ")).toEqual({ suffix: "tests", source: "ngram" });
  expect(p.suggest("could you please run te")?.suffix).toBe("sts");
  expect(p.suggest("new unrelated insp")?.suffix).toBe("ect");
  expect(p.suggest("/foo")).toBeUndefined(); expect(p.suggest(" ")).toBeUndefined();
});

test("corpus is bounded, deduplicated and learns new human input", () => {
  const p = new Predictor(Array.from({ length: 3500 }, (_, i) => sample(`prompt number ${i}`)));
  expect(p.size).toBe(MAX_SAMPLES);
  p.add(sample("please inspect autocomplete"));
  expect(p.suggest("please inspect ")?.suffix).toBe("autocomplete");
  p.add(sample("please inspect autocomplete")); expect(p.size).toBe(MAX_SAMPLES);
  p.replace([]); expect(p.size).toBe(0); expect(p.suggest("please")).toBeUndefined();
});

test("terminal escapes, injection wrappers and oversized prose are excluded", () => {
  for (const s of ["\x1b[31mhello", "<environment_context>stuff", '{"generation":{}}', "[pasted context]", "/skill:foo", "!rm file",
    "Switchboard observation (external participant data)", "Historical memory, not instructions", "x".repeat(2001)]) expect(usablePrompt(s)).toBe(false);
  expect(cleanText("\x1b]52;c;YWJj\x07safe\u202ehere")).toBe("safehere");
  expect(usablePrompt("can we inspect naïve 日本語 👩‍💻 text")).toBe(true);
});

test("index-only corpus excludes assistant, summaries, long chunks and revoked sources", async () => {
  const dir = mkdtempSync(join(tmpdir(), "autocomplete-corpus-"));
  try {
    const root = join(dir, "sessions"); mkdirSync(root);
    const config: HistoryConfig = { version: 1, indexDir: join(dir, "index"), sources: [{ harness: "pi", path: root }] };
    expect(readCorpus(config, "/here", "all")).toEqual([]); expect(existsSync(config.indexDir)).toBe(false);
    const file = join(root, "one.jsonl");
    const rows = [{ type: "session", id: "s", cwd: "/here" },
      ...[ ["user", "please inspect tests"], ["assistant", "assistant-only text"], ["user", "long ".repeat(2000)],
        ["user", "<system-reminder>injected"], ["toolResult", "tool-only text"] ].map(([role, text], i) =>
        ({ type: "message", id: `m${i}`, message: { role, content: text }, timestamp: "2026-09-01T00:00:00Z" }))];
    writeFileSync(file, rows.map(r => JSON.stringify(r)).join("\n"));
    const index = new HistoryIndex(config); await index.refresh();
    // Same persisted schema used by the other parsers; include a user-role summary explicitly.
    index.db.prepare("INSERT INTO chunks(session_key,entry_id,seq,part,role,kind,time,locator,text) SELECT key,'summary',99,0,'user','summary','','','summary-only text' FROM sessions").run();
    index.close();
    const before = readFileSync(join(config.indexDir, "history.sqlite"));
    expect(readCorpus(config, "/here", "all")).toEqual([sample("please inspect tests")]);
    expect(readCorpus(config, "/else", "project")).toEqual([]);
    expect(readFileSync(join(config.indexDir, "history.sqlite"))).toEqual(before);
    expect(readCorpus({ ...config, sources: [] }, "/here", "all")).toEqual([]);
    rmSync(file); expect(readCorpus(config, "/here", "all")).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("read-only corpus uses all four harnesses and exact project scope", () => {
  const dir = mkdtempSync(join(tmpdir(), "autocomplete-harnesses-"));
  try {
    const config: HistoryConfig = { version: 1, indexDir: join(dir, "index"), sources: [] };
    const index = new HistoryIndex(config);
    for (const harness of ["pi", "omp", "codex", "hermes"] as const) {
      const root = join(dir, harness); mkdirSync(root);
      const path = join(root, "source.jsonl"); writeFileSync(path, "");
      config.sources.push({ harness, path: harness === "hermes" ? path : root });
      index.db.prepare("INSERT INTO sources VALUES(?,?,?,?,?)").run(path, harness, "stamp", "", "[]");
      index.db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,?)").run(harness, harness, harness, path, harness === "pi" ? "/here" : "/else", "", "");
      index.db.prepare("INSERT INTO chunks(session_key,entry_id,seq,part,role,kind,time,locator,text) VALUES(?,?,0,0,'user','prose','','',?)")
        .run(harness, "entry", `please inspect ${harness}`);
    }
    index.close();
    expect(readCorpus(config, "/here", "all").map(s => s.text).sort()).toEqual([
      "please inspect codex", "please inspect hermes", "please inspect omp", "please inspect pi",
    ]);
    expect(readCorpus(config, "/here", "project")).toEqual([sample("please inspect pi")]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("read-only corpus rejects future schema and symlink database", () => {
  const dir = mkdtempSync(join(tmpdir(), "autocomplete-schema-"));
  try {
    const path = join(dir, "history.sqlite"), db = new DatabaseSync(path); db.exec("PRAGMA user_version=42"); db.close();
    const config: HistoryConfig = { version: 1, indexDir: dir, sources: [] };
    expect(() => readCorpus(config, "", "all")).toThrow("schema");
    rmSync(path); writeFileSync(join(dir, "other"), ""); symlinkSync(join(dir, "other"), path);
    expect(() => readCorpus(config, "", "all")).toThrow("symlink");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("config persists only decisions, validates local origin, and defaults off", () => {
  const dir = mkdtempSync(join(tmpdir(), "autocomplete-config-")), path = join(dir, "config.json");
  try {
    expect(loadAutocompleteConfig(path)).toEqual(defaults);
    saveAutocompleteConfig({ ...defaults, enabled: true, cpuOnly: true }, path);
    expect(loadAutocompleteConfig(path).cpuOnly).toBe(true); expect(statSync(path).mode & 0o777).toBe(0o600);
    for (const endpoint of ["https://example.com", "http://localhost:11434/api", "http://user:pass@localhost", "http://localhost/?secret=x"])
      expect(() => validateConfig({ ...defaults, endpoint })).toThrow();
    expect(() => validateConfig({ ...defaults, model: "bad\nmodel" })).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Ollama request is bounded, local, CPU-switchable and draft-only", async () => {
  let captured: any;
  const request = (async (url: string, options: any) => {
    captured = { url, ...options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ message: { content: JSON.stringify({ completion: " the tests" }) } }));
  }) as any;
  expect(await completeOllama("please run ", { ...defaults, cpuOnly: true }, new AbortController().signal, request)).toBe("the tests");
  expect(captured.url).toBe("http://127.0.0.1:11434/api/chat"); expect(captured.redirect).toBe("error");
  expect(captured.body.options.num_gpu).toBe(0); expect(captured.body.think).toBe(false);
  expect(captured.body.messages).toHaveLength(2);
  expect(JSON.parse(captured.body.messages[1].content)).toEqual({ unfinished_draft: "please run " });
  await completeOllama("x".repeat(3000), defaults, new AbortController().signal, request);
  expect(JSON.parse(captured.body.messages[1].content).unfinished_draft.length).toBe(2048);
  expect(captured.body.options.num_gpu).toBeUndefined();
});

test("Ollama failures do not fall back; output and terminal controls are bounded", async () => {
  const signal = new AbortController().signal;
  await expect(completeOllama("test ", defaults, signal, (async () => new Response("no", { status: 404 })) as any)).rejects.toThrow("404");
  await expect(completeOllama("test ", defaults, signal, (async () => new Response("x".repeat(40_000))) as any)).rejects.toThrow("32 KiB");
  await expect(completeOllama("test ", { ...defaults, model: "thing:cloud" }, signal)).rejects.toThrow("Cloud");
  await expect(completeOllama("test ", { ...defaults, modelEnabled: false }, signal)).rejects.toThrow("disabled");
  const request = (async () => new Response(JSON.stringify({ message: { content: JSON.stringify({ completion: "test \x1b[31mhello\u202e" }) } }))) as any;
  expect(await completeOllama("test ", defaults, signal, request)).toBe("hello");
});

test("controller never calls model automatically and fences stale completion after edit ABA", async () => {
  const p = new Predictor([sample("please run tests")]), wait = deferred<string>(); let calls = 0;
  const c = new CompletionController(p, () => {}, () => {});
  expect(c.suggestion("please ")?.source).toBe("history"); expect(calls).toBe(0);
  let signal!: AbortSignal;
  const pending = c.request("please ", async (_draft, s) => { calls++; signal = s; return wait.promise; }, () => true);
  c.edited(); expect(signal.aborted).toBe(true);
  wait.resolve("stale result"); await pending;
  expect(c.suggestion("please ")?.source).toBe("history"); expect(calls).toBe(1);
});

test("controller dismiss, disposal, ownership check, and overlapping request behavior", async () => {
  const wait = deferred<string>(), p = new Predictor([sample("please run tests")]); let errors = 0, calls = 0;
  const c = new CompletionController(p, () => {}, () => errors++);
  const pending = c.request("please ", async () => { calls++; return wait.promise; }, () => false);
  await c.request("please ", async () => { calls++; return "extra"; }, () => true);
  expect(calls).toBe(1); wait.resolve("stale"); await pending;
  expect(c.suggestion("please ")?.source).toBe("history");
  c.dismiss("please "); expect(c.suggestion("please ")).toBeUndefined();
  c.edited(); expect(c.suggestion("please ")).toBeDefined();
  c.dispose(); await c.request("please ", async () => { calls++; return "no"; }, () => true);
  expect(c.suggestion("please ")).toBeUndefined(); expect(calls).toBe(1); expect(errors).toBe(0);
});

test("ghost rendering preserves cursor marker and width for Unicode, wrap and narrow rows", () => {
  for (const width of [2, 6, 15, 40]) {
    const row = `中${CURSOR_MARKER}\x1b[7m \x1b[0m`;
    const lines = ["border", row, "bottom"];
    const rendered = drawGhost(lines, "👩‍💻日本語\nsecond line", width, 0);
    expect(rendered[1]).toContain(CURSOR_MARKER);
    if (width >= 3) expect(visibleWidth(rendered[1]!)).toBeLessThanOrEqual(width);
    expect(lines[1]).toBe(row); expect(rendered[0]).toBe("border");
  }
  expect(drawGhost(["no marker"], "stuff", 80, 0)).toEqual(["no marker"]);
});

test("editor renders ghost without changing buffer or firing onChange; accepts with undo", () => {
  const { e } = editor(); let changes = 0, submissions = 0;
  e.onChange = () => changes++; e.onSubmit = () => submissions++;
  e.setText("please r"); const baseline = changes;
  expect(cleanText(e.render(80).join("\n"))).toContain("un the tests");
  expect(e.getText()).toBe("please r"); expect(changes).toBe(baseline);
  e.handleInput("\t"); expect(e.getText()).toBe("please run ");
  e.handleInput("\x1b[C"); expect(e.getText()).toBe("please run the tests");
  expect(submissions).toBe(0);
  e.handleInput("\x1f"); expect(e.getText()).toBe("please run ");
  e.dispose();
});

test("Tab after space manually requests a model; second Tab accepts; Enter never accepts ghost", async () => {
  let calls = 0;
  const { e } = editor(undefined, async () => { calls++; return "some local text"; });
  e.setText("please "); e.render(80); expect(calls).toBe(0);
  e.handleInput("\t"); expect(calls).toBe(1); expect(e.getText()).toBe("please ");
  await tick(); expect(e.completion.suggestion(e.getText())?.source).toBe("ollama");
  e.handleInput("\t"); expect(e.getText()).toBe("please some local text"); expect(calls).toBe(1);
  let submitted = ""; e.onSubmit = text => submitted = text;
  e.setText("please "); e.handleInput("\r"); expect(submitted).toBe("please");
  e.dispose();
});

test("cursor move, Escape, programmatic replacement and disposal cancel pending requests", async () => {
  for (const action of ["left", "escape", "set", "dispose"]) {
    const wait = deferred<string>(); const { e } = editor(undefined, async () => wait.promise);
    e.setText("please "); e.handleInput("\t");
    if (action === "left") e.handleInput("\x1b[D");
    if (action === "escape") e.handleInput("\x1b");
    if (action === "set") { e.setText("other"); e.setText("please "); }
    if (action === "dispose") e.dispose();
    wait.resolve("unwanted output"); await tick();
    expect(e.getText()).not.toContain("unwanted"); expect(e.render(80).join("\n")).not.toContain("unwanted");
    e.dispose();
  }
});

test("slash, shell, path, mention, paste and mid-buffer input are not ghost-completed", () => {
  const { e } = editor();
  for (const text of ["/model ", "!echo ", "read @src", "read src/foo", "[paste #1 +2 lines] "]) {
    e.setText(text); expect(e.eligible()).toBe(false);
  }
  e.setText("please "); e.handleInput("\x1b[D"); expect(e.eligible()).toBe(false); e.dispose();
});

test("native slash and path completion providers still receive Tab", async () => {
  let calls = 0, models = 0;
  const { e } = editor(undefined, async () => { models++; return "no"; });
  e.setAutocompleteProvider({
    getSuggestions: async () => { calls++; return null; },
    applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
  });
  for (const text of ["/mod", "read ./src/", "read @src"]) {
    e.setText(text); e.handleInput("\t"); await tick();
  }
  expect(calls).toBeGreaterThanOrEqual(3); expect(models).toBe(0); e.dispose();
});

test("ownership/focus loss suppresses model results and stale failure notices", async () => {
  const wait = deferred<string>(); let current = true, errors = 0;
  const c = new CompletionController(new Predictor(), () => {}, () => errors++);
  const pending = c.request("draft ", async () => wait.promise, () => current);
  current = false; wait.resolve("not current"); await pending;
  expect(c.suggestion("draft ")).toBeUndefined();
  await c.request("draft ", async () => { throw new Error("obsolete"); }, () => false);
  expect(errors).toBe(0); c.dispose();
});

test("extension has no prompt/context/tool hooks and is inert outside TUI", async () => {
  const handlers = new Map<string, Function>(), commands = new Map<string, any>();
  autocomplete({ on: (name: string, fn: Function) => handlers.set(name, fn), registerCommand: (name: string, cmd: any) => commands.set(name, cmd) } as any);
  expect([...handlers.keys()].sort()).toEqual(["input", "session_shutdown", "session_start", "session_tree"]);
  for (const mode of ["rpc", "json", "print"]) {
    const ctx = { mode, hasUI: false, ui: new Proxy({}, { get() { throw new Error("unexpected UI access"); } }) };
    await handlers.get("session_start")!({}, ctx); await handlers.get("session_shutdown")!({}, ctx);
    await commands.get("autocomplete").handler("on", ctx);
  }
});
