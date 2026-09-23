import { existsSync } from "node:fs";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { registerToggle } from "./toggle.ts";
import { pickModel } from "./model-picker.ts";
import { presetLabel, readHistory, rememberPreset, type ModelPreset, type ThinkingLevel } from "./model-history.ts";

const marker = "generalist:session-setup";
const personalities = [
  { label: "Plain coding — personality off, memory off", meitan: false, memory: false },
  { label: "Coding + native memory — requires /memory configure", meitan: false, memory: true },
  { label: "Meitan — personality on, memory off", meitan: true, memory: false },
  { label: "Meitan + native memory — requires /memory configure", meitan: true, memory: true },
];

/** Only bare interactive launches (plus UI/resource options) get unsolicited UI.
 * Unknown switches are conservatively treated as launcher-owned configuration.
 * Never mistake an option's value, or text after --, for a model flag.
 */
export function hasLaunchOverrides(argv: string[]) {
  const booleans = new Set(["--no-session", "--offline", "--approve", "-a", "--no-approve", "-na",
    "--verbose", "--no-skills", "-ns", "--no-prompt-templates", "-np", "--no-themes", "--no-context-files", "-nc"]);
  const values = new Set(["--name", "-n", "--session-dir", "--extension", "-e", "--skill",
    "--prompt-template", "--theme", "--use-theme", "--tui-mode"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") return i + 1 < argv.length; // positional startup prompt/files
    const name = arg.split("=", 1)[0];
    if (booleans.has(name)) continue;
    if (values.has(name)) {
      if (!arg.includes("=")) i++;
      continue;
    }
    return true; // model/provider/thinking/preset/toggles, resume, automation, or initial prompt
  }
  return false;
}

type Toggles = Record<"meitan" | "memory", ReturnType<typeof registerToggle>> & {
  memory: ReturnType<typeof registerToggle> & { prefersCompanion?: () => boolean };
};

export function registerSessionSetup(pi: ExtensionAPI, toggles: Toggles,
  options: { argv?: string[]; historyPath?: string } = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const historyPath = options.historyPath ?? join(getAgentDir(), "generalist-model-history.json");
  let busy = false;
  let historyWarning = false;
  pi.registerFlag("no-session-setup", { description: "Skip generalist startup questions", type: "boolean", default: false });

  function warnHistory(ctx: ExtensionContext, error: unknown) {
    if (historyWarning) return;
    historyWarning = true;
    ctx.ui.notify(`Model history unavailable (${historyPath}): ${String(error)}. Session choices still work.`, "warning");
  }
  function remember(ctx: ExtensionContext, preset: ModelPreset) {
    try { rememberPreset(historyPath, preset); }
    catch (error) { warnHistory(ctx, error); }
  }
  function current(ctx: ExtensionContext): ModelPreset | undefined {
    return ctx.model && { provider: ctx.model.provider, model: ctx.model.id, thinking: pi.getThinkingLevel() };
  }

  async function choosePreset(ctx: ExtensionContext) {
    const available = ctx.modelRegistry.getAvailable();
    const models = ctx.scopedModels.length
      ? ctx.scopedModels.map(s => s.model).filter(m => available.some(a => a.provider === m.provider && a.id === m.id))
      : available;
    const find = (p: ModelPreset) => models.find(m => m.provider === p.provider && m.id === p.model);
    let history: ModelPreset[] = [];
    try { history = readHistory(historyPath); }
    catch (error) { warnHistory(ctx, error); }
    const recent = history.filter(p => {
      const model = find(p);
      return model && getSupportedThinkingLevels(model).includes(p.thinking);
    });
    const existing = current(ctx);
    const keep = existing ? `Keep current — ${presetLabel(existing)}` : "Keep current (no model selected)";
    const browse = "Choose another model / thinking level…";
    const labels = recent.map(p => `Recent — ${presetLabel(p)}`);
    const selected = await ctx.ui.select("2/2 · Model / thinking preset (most recent first)", [...labels, keep, browse]);
    if (!selected) return;
    if (selected === keep) {
      if (existing) remember(ctx, existing);
      return;
    }
    let preset = recent[labels.indexOf(selected)];
    if (selected === browse) {
      if (!models.length) {
        ctx.ui.notify("No available models. Configure a provider with /login, then use /session-setup.", "warning");
        return;
      }
      const sorted = [...models].sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
      const id = await pickModel(ctx, sorted.map((m, index) => ({ value: String(index), label: `${m.provider}/${m.id}`, description: m.name })));
      if (id === undefined) return;
      const model = sorted[Number(id)];
      if (!model) return;
      const levels = getSupportedThinkingLevels(model);
      const preferred = ctx.scopedModels.find(s => s.model.provider === model.provider && s.model.id === model.id)?.thinkingLevel
        ?? pi.getThinkingLevel();
      const ordered = levels.includes(preferred) ? [preferred, ...levels.filter(l => l !== preferred)] : levels;
      const thinking = await ctx.ui.select(`Thinking · ${model.provider}/${model.id}`, ordered);
      if (!thinking || !levels.includes(thinking as ThinkingLevel)) return;
      preset = { provider: model.provider, model: model.id, thinking: thinking as ThinkingLevel };
    }
    if (!preset) return;
    const model = find(preset);
    if (!model) return;
    try {
      if (!await pi.setModel(model)) {
        ctx.ui.notify(`Could not select ${preset.provider}/${preset.model}: authentication unavailable. Kept current model/thinking.`, "warning");
        return;
      }
      pi.setThinkingLevel(preset.thinking);
      // Pi clamps unsupported levels; save the effective pair, not the requested one.
      const effective = { ...preset, thinking: pi.getThinkingLevel() };
      remember(ctx, effective);
      ctx.ui.notify(`Selected ${presetLabel(effective)}`, "info");
    } catch (error) {
      ctx.ui.notify(`Could not apply model/thinking preset: ${String(error)}`, "error");
    }
  }

  async function setup(ctx: ExtensionContext) {
    if (busy || ctx.mode !== "tui") return;
    busy = true;
    try {
      pi.appendEntry(marker, { offered: true });
      let choices = personalities;
      try {
        if (toggles.memory.prefersCompanion?.()) choices = [
          { ...personalities[3], label: `Preferred — ${personalities[3].label}` }, ...personalities.slice(0, 3),
        ];
      } catch { ctx.ui.notify("Memory preference unavailable; no automatic activation. Showing standard choices.", "warning"); }
      const selected = await ctx.ui.select("1/2 · Personality / memory", choices.map(p => p.label));
      const personality = choices.find(p => p.label === selected);
      if (!personality) return; // Cancel leaves everything unchanged; no second question.
      toggles.meitan.set(personality.meitan, ctx);
      try { toggles.memory.set(personality.memory, ctx); }
      catch (error) { ctx.ui.notify(`Native memory unchanged: ${String(error)}`, "warning"); }
      await choosePreset(ctx); // Cancel here retains the personality choice and current model.
    } finally { busy = false; }
  }

  pi.on("session_start", async (event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (event.reason === "reload") {
      // UI-only: do not append a session entry or change provider context.
      ctx.ui.notify(`Reloaded UI at ${new Date().toLocaleString(undefined, {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short", hour12: false,
      })}`, "info");
      return;
    }
    if (!["startup", "new"].includes(event.reason)) return;
    if (pi.getFlag("no-session-setup") || pi.getFlag("meitan") || pi.getFlag("memory-config") || hasLaunchOverrides(argv)) return;
    // Fresh sessions already contain initial model/thinking entries. Any saved
    // session, conversation, or extension decision should not be reconfigured.
    const file = ctx.sessionManager.getSessionFile();
    if ((file && existsSync(file)) || ctx.sessionManager.getHeader()?.parentSession) return;
    if (ctx.sessionManager.getEntries().some(e => !["model_change", "thinking_level_change", "session_info"].includes(e.type))) return;
    await setup(ctx);
  });
  pi.registerCommand("session-setup", {
    description: "Choose personality/memory, then a recent or new model/thinking preset",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") return;
      await ctx.waitForIdle();
      await setup(ctx);
    },
  });
  // Also learn combinations actually used after /model or thinking changes.
  // Do not track startup restores or intermediate model-change/clamping events.
  pi.on("before_agent_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const preset = current(ctx);
    if (preset) remember(ctx, preset);
  });
}
