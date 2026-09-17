import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../lib/history/config.ts";
import { readCorpus } from "../lib/autocomplete/corpus.ts";
import { defaults, loadAutocompleteConfig, saveAutocompleteConfig, validateConfig, type AutocompleteConfig } from "../lib/autocomplete/config.ts";
import { GhostEditor } from "../lib/autocomplete/editor.ts";
import { completeOllama } from "../lib/autocomplete/ollama.ts";
import { cleanText, Predictor } from "../lib/autocomplete/predictor.ts";

type EditorFactory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;

/** UI-only, opt-in. No tools, context hooks, injected messages, or automatic model requests. */
export default function autocomplete(pi: ExtensionAPI) {
  let config: AutocompleteConfig = { ...defaults };
  let predictor = new Predictor(), editor: GhostEditor | undefined, factory: EditorFactory | undefined;
  const report = (ctx: ExtensionContext, error: unknown) => ctx.ui.notify(
    cleanText(error instanceof Error ? error.message : "Autocomplete failed").slice(0, 240), "warning");
  const reloadCorpus = (ctx: ExtensionContext) => {
    // Clear first: errors/revocation must not retain an old corpus.
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
        (draft, signal) => completeOllama(draft, config, signal), () => config.modelEnabled,
        () => ctx.ui.getEditorComponent() === factory,
        message => ctx.ui.notify(message, "warning"));
      return editor;
    };
    ctx.ui.setEditorComponent(factory);
  };
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    stop(ctx);
    config = { ...defaults };
    try { config = loadAutocompleteConfig(); if (config.enabled) install(ctx); }
    catch (error) { report(ctx, error); }
  });
  pi.on("session_shutdown", (_event, ctx) => { if (ctx.mode === "tui") stop(ctx); });
  pi.on("session_tree", () => editor?.completion.edited());
  pi.on("input", (event, ctx) => {
    editor?.completion.edited();
    if (ctx.mode === "tui" && config.enabled && event.source === "interactive")
      predictor.add({ text: event.text, cwd: ctx.cwd });
  });
  pi.registerCommand("autocomplete", {
    description: "Ghost completion: on|off|status|reload|model NAME|llm on/off|cpu on/off|scope all/project",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") { if (ctx.hasUI) ctx.ui.notify("Autocomplete requires the terminal UI", "warning"); return; }
      const [action = "status", value, ...extra] = args.trim().split(/\s+/).filter(Boolean);
      try {
        if (extra.length) throw new Error("Too many autocomplete arguments");
        if (action === "status") {
          if (value) throw new Error("Usage: /autocomplete status");
          ctx.ui.notify(`Autocomplete ${factory && ctx.ui.getEditorComponent() === factory ? "on" : "off"}; ${predictor.size} prompts; scope=${config.scope}; local model=${config.modelEnabled ? config.model : "off"}; device=${config.cpuOnly ? "CPU only" : "Ollama auto"}. Tab after space: model; →: accept all; Alt+→: word. /autocomplete reload rereads the existing history index.`, "info");
          return;
        }
        if (action === "reload") {
          if (value) throw new Error("Usage: /autocomplete reload");
          if (!factory || ctx.ui.getEditorComponent() !== factory) throw new Error("Enable autocomplete first");
          reloadCorpus(ctx); ctx.ui.notify(`Loaded ${predictor.size} prompts from the history index (no source refresh).`, "info"); return;
        }
        let next = { ...config };
        if (["on", "off"].includes(action) && !value) next.enabled = action === "on";
        else if (action === "model" && value) next.model = value;
        else if (["cpu", "llm"].includes(action) && ["on", "off"].includes(value ?? "")) {
          if (action === "cpu") next.cpuOnly = value === "on"; else next.modelEnabled = value === "on";
        } else if (action === "scope" && (value === "all" || value === "project")) next.scope = value;
        else throw new Error("Usage: /autocomplete on|off|status|reload|model NAME|llm on/off|cpu on/off|scope all/project");
        next = validateConfig(next);
        if (next.enabled && !factory && ctx.ui.getEditorComponent()) throw new Error("Another extension owns the editor");
        const previous = config;
        config = next;
        try {
          if (config.enabled) install(ctx);
          saveAutocompleteConfig(config);
        } catch (error) {
          config = previous;
          if (!previous.enabled) stop(ctx);
          throw error;
        }
        editor?.completion.edited();
        if (!config.enabled) stop(ctx);
        else if (previous.scope !== config.scope) reloadCorpus(ctx);
        ctx.ui.notify(`Autocomplete: ${action}${value ? ` ${value}` : ""} (saved).${action === "on" && !predictor.size ? " No indexed prompts yet; use /history-index refresh, then /autocomplete reload." : ""}`, "info");
      } catch (error) { report(ctx, error); }
    },
  });
}
