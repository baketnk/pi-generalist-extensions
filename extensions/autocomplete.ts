import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../lib/history/config.ts";
import { readCorpus } from "../lib/autocomplete/corpus.ts";
import { defaults, loadAutocompleteConfig, saveAutocompleteConfig, validateConfig, type AutocompleteConfig } from "../lib/autocomplete/config.ts";
import { GhostEditor } from "../lib/autocomplete/editor.ts";
import { completeWithPi, selectedModel } from "../lib/autocomplete/provider.ts";
import { cleanText, Predictor } from "../lib/autocomplete/predictor.ts";
import { pickModel } from "../lib/model-picker.ts";

type EditorFactory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;
type Stats = { requests: number; completed: number; errors: number; cancelled: number; totalMs: number };
const usage = "Usage: /autocomplete on|off|status|stats|reload|model [provider/id]|llm on/off|conversation on/off|repo on/off|scope all/project";

/** UI-only, opt-in. No tools, context projection hooks, injected messages, or automatic model requests. */
export default function autocomplete(pi: ExtensionAPI) {
  let config: AutocompleteConfig = { ...defaults };
  let predictor = new Predictor(), editor: GhostEditor | undefined, factory: EditorFactory | undefined;
  const stats = new Map<string, Stats>();
  const report = (ctx: ExtensionContext, error: unknown) => ctx.ui.notify(
    cleanText(error instanceof Error ? error.message : "Autocomplete failed").slice(0, 240), "warning");
  const reloadCorpus = (ctx: ExtensionContext) => {
    predictor.replace([]); editor?.completion.edited();
    predictor.replace(readCorpus(loadConfig(), ctx.cwd, config.scope));
  };
  const stop = (ctx: ExtensionContext) => {
    editor?.dispose(); editor = undefined; predictor.replace([]);
    if (factory && ctx.ui.getEditorComponent() === factory) ctx.ui.setEditorComponent(undefined);
    factory = undefined;
  };
  const install = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") throw new Error("Autocomplete requires the terminal UI");
    if (factory && ctx.ui.getEditorComponent() === factory) return;
    if (ctx.ui.getEditorComponent()) throw new Error("Another extension owns the editor; disable it before enabling autocomplete");
    predictor = new Predictor([], ctx.cwd);
    try { reloadCorpus(ctx); } catch (error) { report(ctx, error); }
    factory = (tui, theme, keys) => {
      editor?.dispose();
      editor = new GhostEditor(tui, theme, keys, predictor,
        async (draft, signal) => {
          const snapshot = { ...config }, key = snapshot.model ?? "(unselected)";
          if (!stats.has(key)) {
            if (stats.size >= 32) stats.delete(stats.keys().next().value!);
            stats.set(key, { requests: 0, completed: 0, errors: 0, cancelled: 0, totalMs: 0 });
          }
          const record = stats.get(key)!, start = performance.now(); record.requests++;
          try {
            const text = await completeWithPi(draft, snapshot, ctx, signal);
            record.completed++; record.totalMs += performance.now() - start; return text;
          } catch (error) { if (signal.aborted) record.cancelled++; else record.errors++; throw error; }
        }, () => config.modelEnabled,
        () => ctx.ui.getEditorComponent() === factory,
        message => ctx.ui.notify(message, "warning"));
      return editor;
    };
    ctx.ui.setEditorComponent(factory);
  };
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    stop(ctx); stats.clear(); config = { ...defaults };
    try { config = loadAutocompleteConfig(); if (config.enabled) install(ctx); }
    catch (error) { report(ctx, error); }
  });
  pi.on("session_shutdown", (_event, ctx) => { if (ctx.mode === "tui") stop(ctx); });
  pi.on("session_tree", () => editor?.completion.edited());
  pi.on("message_end", event => {
    if (event.message.role === "user" || event.message.role === "assistant") editor?.completion.edited();
  });
  pi.on("input", (event, ctx) => {
    editor?.completion.edited();
    if (ctx.mode === "tui" && config.enabled && event.source === "interactive") predictor.add({ text: event.text, cwd: ctx.cwd });
  });
  pi.registerCommand("autocomplete", {
    description: "Ghost completion: on/off, model picker, conversation/repo context, stats, history reload",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") { if (ctx.hasUI) ctx.ui.notify("Autocomplete requires the terminal UI", "warning"); return; }
      const [action = "status", initialValue, ...extra] = args.trim().split(/\s+/).filter(Boolean);
      let value: string | undefined = initialValue;
      try {
        if (extra.length) throw new Error("Too many autocomplete arguments");
        if (action === "status") {
          if (value) throw new Error(usage);
          ctx.ui.notify(`Autocomplete ${factory && ctx.ui.getEditorComponent() === factory ? "on" : "off"}; ${predictor.size} prompts; scope=${config.scope}; model=${config.modelEnabled ? config.model ?? "unselected — /autocomplete model" : "off"}; conversation=${config.conversation}; repo=${config.repository}. Ctrl+Tab/Ctrl+Space: model; Tab: word + space; →: all. Selected providers may be remote and incur charges.`, "info"); return;
        }
        if (action === "stats") {
          if (value) throw new Error(usage);
          ctx.ui.notify([...stats].map(([model, s]) => `${model}: ${s.requests} attempts, ${s.completed} completed, ${s.errors} errors, ${s.cancelled} cancelled; mean completed latency ${s.completed ? Math.round(s.totalMs / s.completed) : 0}ms`).join("\n") || "No autocomplete requests this session. Counters are in-memory; not Pi's session token/cost accounting.", "info"); return;
        }
        if (action === "reload") {
          if (value) throw new Error(usage);
          if (!factory || ctx.ui.getEditorComponent() !== factory) throw new Error("Enable autocomplete first");
          reloadCorpus(ctx); ctx.ui.notify(`Loaded ${predictor.size} prompts from the history index (no source refresh).`, "info"); return;
        }
        if (action === "cpu") throw new Error("Device control now belongs to the selected Pi provider/local server; /autocomplete cpu is retired.");
        if (action === "model" && !value) {
          // Same configured, provider-filtered catalogue as the scoped picker: no refresh or request on open.
          const models = ctx.modelRegistry.getAvailable()
            .filter(model => ctx.modelRegistry.hasConfiguredAuth(model))
            .filter(model => cleanText(`${model.provider}/${model.id}`) === `${model.provider}/${model.id}`)
            .sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
          const choices = [{ value: "none", label: "none", description: "Disable model completions" },
            ...models.map(model => ({ value: `${model.provider}/${model.id}`, label: `${model.provider}/${model.id}`, description: model.name }))];
          value = await pickModel(ctx, choices);
          if (value === undefined) return;
        }
        let next = { ...config };
        if (["on", "off"].includes(action) && !value) next.enabled = action === "on";
        else if (action === "model" && value) {
          next.model = value === "none" ? null : value;
          if (next.model) selectedModel(ctx.modelRegistry, next.model);
        } else if (["llm", "conversation", "repo"].includes(action) && ["on", "off"].includes(value ?? "")) {
          if (action === "llm") next.modelEnabled = value === "on";
          else if (action === "conversation") next.conversation = value === "on";
          else next.repository = value === "on";
        } else if (action === "scope" && (value === "all" || value === "project")) next.scope = value;
        else throw new Error(usage);
        next = validateConfig(next);
        if (action === "repo" && next.repository && !ctx.isProjectTrusted()) throw new Error("Repository autocomplete context requires a trusted project");
        if (next.enabled && !factory && ctx.ui.getEditorComponent()) throw new Error("Another extension owns the editor");
        const previous = config; config = next;
        try {
          if (config.enabled) install(ctx);
          saveAutocompleteConfig(config);
        } catch (error) { config = previous; if (!previous.enabled) stop(ctx); throw error; }
        editor?.completion.edited();
        if (!config.enabled) stop(ctx);
        else if (previous.scope !== config.scope) reloadCorpus(ctx);
        ctx.ui.notify(`Autocomplete: ${action}${value ? ` ${value}` : ""} (saved).${action === "model" && next.model ? " Manual requests send your draft and enabled context to this provider; it may be remote." : ""}${action === "on" && !next.model ? " Select a Pi model with /autocomplete model; history completion is ready." : ""}`, "info");
      } catch (error) { report(ctx, error); }
    },
  });
}
