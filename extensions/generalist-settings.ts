import { getAgentDir, getSettingsListTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { BACKGROUND_MODEL_ENTRY, backgroundModel, backgroundModelLabel, configureBackgroundModel } from "../lib/background-model.ts";
import type { ToggleController } from "../lib/toggle.ts";
import { requestDashboard } from "../lib/switchboard/dashboard.ts";
import { OUTPUT_CONFIG_ENTRY, rawJsonOutput } from "../lib/output.ts";
import { saveGeneralistDefaults, type GeneralistDefaults } from "../lib/generalist-config.ts";
import { configureForcedSubagentModel, forcedSubagentModel, forcedSubagentModelLabel, setForcedSubagentModel, SUBAGENT_MODEL_POLICY_ENTRY } from "../lib/subagents/model-policy.ts";
import { loadWorkerLimits, saveWorkerLimits, validateWorkerLimits, RESOURCE_CEILINGS } from "../lib/subagents/limits.ts";
import { LOOP_LIMIT_ENTRY, loopLimit, validLoopLimit } from "../lib/loop-config.ts";

type FeatureId = "meitan" | "memory" | "output" | "patch" | "icons";
type Features = Record<"meitan" | "memory", ToggleController> & {
  patch?: ToggleController;
  icons?: ToggleController;
  memory: ToggleController & {
    configureHousekeeping?: (ctx: ExtensionContext) => Promise<void>;
    configurePersonal?: (ctx: ExtensionContext) => Promise<void>;
    configurePairing?: (ctx: ExtensionContext) => Promise<void>;
    enableDefault?: (ctx: ExtensionContext) => void;
  };
};

const labels: Record<FeatureId, string> = {
  meitan: "Meitan personality",
  memory: "Native memory (configure with /memory first)",
  output: "Raw JSON debug output",
  patch: "Apply patch tool (local project files)",
  icons: "Emoji footer status icons",
};

// Every selectable setting has a description so SettingsList reserves the same area on selection changes.
const descriptions: Record<FeatureId, string> = {
  meitan: "Optional personality context.",
  memory: "Configured scoped memory.",
  output: "Readable text or raw JSON.",
  patch: "Optional local apply_patch tool.",
  icons: "Labelled footer booleans.",
};

const featureIds = (features: Features) => (Object.keys(labels) as FeatureId[]).filter(id =>
  (id !== "patch" || features.patch) && (id !== "icons" || features.icons));

function status(features: Features, ctx: ExtensionContext) {
  return featureIds(features)
    .map(id => `${id}: ${(id === "output" ? rawJsonOutput(ctx) : features[id]!()) ? "on" : "off"}`)
    .join(" · ");
}

function setFeature(feature: Exclude<FeatureId, "output">, value: boolean, features: Features, ctx: ExtensionContext) {
  if (!features[feature]) throw new Error(`${feature} is unavailable in this bundle`);
  features[feature]!.set(value, ctx);
  if (ctx.hasUI) ctx.ui.notify(`${labels[feature]}: ${value ? "on" : "off"}`, "info");
}

function setRawJson(value: boolean, pi: ExtensionAPI, ctx: ExtensionContext) {
  pi.appendEntry(OUTPUT_CONFIG_ENTRY, { rawJson: value });
  if (ctx.hasUI) ctx.ui.notify(`Raw JSON debug output: ${value ? "on" : "off"}`, "info");
}

function hasBranchSetting(ctx: ExtensionContext, customType: string): boolean {
  return ctx.sessionManager.getBranch().some(entry => entry.type === "custom" && entry.customType === customType);
}

export function isGeneralistSaveKey(keys: { matches?(data: string, action: string): boolean }, data: string): boolean {
  // Exact Ctrl+S keeps compatibility with older/custom hosts that do not supply a keybinding manager.
  return keys.matches?.(data, "app.models.save") === true || keys.matches?.(data, "app.thinking.save") === true || data === "\x13";
}

export async function configureWorkerLimits(ctx: ExtensionContext, agentDir = getAgentDir()): Promise<void> {
  if (!ctx.hasUI) throw new Error("Subagent limits configuration requires TUI or RPC UI.");
  const current = loadWorkerLimits(agentDir);
  const turns = await ctx.ui.input(`Max subagent turns (1–${RESOURCE_CEILINGS.turns})`, String(current.turns));
  if (turns === undefined) return;
  const tools = await ctx.ui.input(`Max subagent tool calls (1–${RESOURCE_CEILINGS.tools})`, String(current.tools));
  if (tools === undefined) return;
  const parse = (value: string) => /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  const selected = validateWorkerLimits({ version: 1, turns: parse(turns), tools: parse(tools) });
  saveWorkerLimits(agentDir, selected);
  ctx.ui.notify(`New subagent runs: ${selected.turns} turns, ${selected.tools} tool calls. Existing runs are unchanged.`, "info");
}

export async function configureLoopLimit(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) throw new Error("Loop limit configuration requires TUI or RPC UI.");
  const answer = await ctx.ui.input("Default /loop count (1–1000)", String(loopLimit(ctx)));
  if (answer === undefined) return;
  const value = answer.trim();
  const limit = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!validLoopLimit(limit)) { ctx.ui.notify("Loop count must be an integer from 1 to 1000.", "warning"); return; }
  pi.appendEntry(LOOP_LIMIT_ENTRY, limit);
  ctx.ui.notify(`Default /loop count: ${limit}. Ctrl+S in /generalist saves it for new sessions.`, "info");
}

export function generalistDefaults(features: Features, ctx: ExtensionContext): GeneralistDefaults {
  return {
    version: 1,
    meitan: features.meitan(),
    memory: features.memory(),
    output: rawJsonOutput(ctx),
    backgroundModel: backgroundModel(ctx),
    forcedSubagentModel: forcedSubagentModel(ctx),
    loopLimit: loopLimit(ctx),
    ...(features.patch ? { patch: features.patch() } : {}),
    ...(features.icons ? { icons: features.icons() } : {}),
  };
}

/** Unified bundle controls; feature state remains branch-local until Ctrl+S saves global defaults. */
export function registerGeneralistSettings(pi: ExtensionAPI, features: Features, defaults?: GeneralistDefaults, options: { agentDir?: string } = {}) {
  const persist = (ctx: ExtensionContext) => {
    try {
      saveGeneralistDefaults(generalistDefaults(features, ctx));
      ctx.ui.notify("Generalist defaults saved for new sessions.", "info");
    } catch (error) { ctx.ui.notify(`Could not save Generalist defaults: ${String(error)}`, "error"); }
  };
  pi.on("session_start", (_event, ctx) => {
    if (defaults?.backgroundModel !== undefined && !hasBranchSetting(ctx, BACKGROUND_MODEL_ENTRY)) {
      pi.appendEntry(BACKGROUND_MODEL_ENTRY, defaults.backgroundModel);
    }
    if (defaults?.forcedSubagentModel !== undefined && !hasBranchSetting(ctx, SUBAGENT_MODEL_POLICY_ENTRY)) {
      setForcedSubagentModel(pi, defaults.forcedSubagentModel);
    }
    if (defaults?.loopLimit !== undefined && !hasBranchSetting(ctx, LOOP_LIMIT_ENTRY)) pi.appendEntry(LOOP_LIMIT_ENTRY, defaults.loopLimit);
    // Output has no controller; saved defaults seed only a branch with no explicit choice.
    if (defaults && !hasBranchSetting(ctx, OUTPUT_CONFIG_ENTRY)) pi.appendEntry(OUTPUT_CONFIG_ENTRY, { rawJson: defaults.output });
  });
  pi.registerCommand("generalist", {
    description: "Configure Generalist features and output: /generalist [status|meitan|memory|output|patch|icons] [on|off|toggle]; personal|pairing|companion|housekeeping|background|subagents|subagent-limits|loop|dashboard",
    getArgumentCompletions: prefix => ["status", ...featureIds(features), "personal", "pairing", "companion", "housekeeping", "background", "subagents", "subagent-limits", "loop", "dashboard", "on", "off", "toggle"]
      .filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      const [target, action, ...extra] = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (extra.length) { ctx.ui.notify("Too many /generalist arguments", "warning"); return; }
      if (target === "background" && action === "status") {
        ctx.ui.notify(`Small/background model: ${backgroundModelLabel(ctx)} (configuration only; no consumers)`, "info");
        return;
      }
      if (target === "background" && action === "clear") {
        await ctx.waitForIdle();
        pi.appendEntry(BACKGROUND_MODEL_ENTRY, null);
        ctx.ui.notify("Small/background model cleared for this branch; Ctrl+S in /generalist saves defaults.", "info");
        return;
      }
      const settings = {
        background: (context: ExtensionContext) => configureBackgroundModel(pi, context),
        subagents: (context: ExtensionContext) => configureForcedSubagentModel(pi, context),
        "subagent-limits": (context: ExtensionContext) => configureWorkerLimits(context, options.agentDir ?? getAgentDir()),
        loop: (context: ExtensionContext) => configureLoopLimit(pi, context),
        dashboard: (context: ExtensionContext) => requestDashboard(pi, context),
        housekeeping: features.memory.configureHousekeeping,
        personal: features.memory.configurePersonal,
        pairing: features.memory.configurePairing,
      };
      if (target && Object.hasOwn(settings, target) && !action) {
        if (target !== "dashboard") await ctx.waitForIdle();
        const configure = settings[target as keyof typeof settings];
        if (!configure) throw new Error("Native memory settings unavailable");
        await configure(ctx);
        return;
      }
      if (target === "companion" && !action) {
        await ctx.waitForIdle();
        if (!features.memory.enableDefault) throw new Error("Default memory profile unavailable");
        features.memory.enableDefault(ctx); // Failure must not silently enable personality alone.
        features.meitan.set(true, ctx);
        ctx.ui.notify("Meitan + default memory enabled. Personal context may be sent to your current provider; mapped project exceptions take precedence.", "info");
        return;
      }
      if (!target && ctx.mode === "tui") {
        await ctx.waitForIdle();
        const selected = await ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
          const items: SettingItem[] = featureIds(features).map(id => ({
            id,
            label: labels[id],
            currentValue: (id === "output" ? rawJsonOutput(ctx) : features[id]!()) ? "on" : "off",
            values: ["on", "off"],
            description: descriptions[id],
          }));
          if (features.memory.configureHousekeeping) items.push({
            id: "housekeeping", label: "Memory housekeeping model", currentValue: "configure…",
            values: ["configure…", "open"], description: "Optional separate review model.",
          });
          if (features.memory.configurePersonal) items.push({
            id: "personal", label: "Default personal memory", currentValue: "configure…", values: ["configure…", "open"],
            description: "Optional personal context.",
          });
          if (features.memory.configurePairing) items.push({
            id: "pairing", label: "Prefer Meitan + memory", currentValue: "configure…", values: ["configure…", "open"],
            description: "Startup picker preference.",
          });
          items.push({ id: "background", label: "Small/background model", currentValue: backgroundModelLabel(ctx),
            values: [backgroundModelLabel(ctx), "configure…"], description: "Configuration only; no consumers enabled." });
          items.push({ id: "subagents", label: "Force subagent model", currentValue: forcedSubagentModelLabel(ctx),
            values: [forcedSubagentModelLabel(ctx), "configure…"], description: "Human lock; the agent cannot override it." });
          const workerLimits = loadWorkerLimits(options.agentDir ?? getAgentDir());
          items.push({ id: "subagent-limits", label: "Subagent turn/tool limits", currentValue: `${workerLimits.turns}/${workerLimits.tools}`,
            values: [`${workerLimits.turns}/${workerLimits.tools}`, "configure…"], description: "Saved immediately; applies to new runs only." });
          items.push({ id: "loop", label: "Default /loop count", currentValue: String(loopLimit(ctx)),
            values: [String(loopLimit(ctx)), "configure…"], description: "Branch setting; Ctrl+S saves for new sessions." });
          items.push({ id: "dashboard", label: "Switchboard dashboard", currentValue: "open…", values: ["open…", "open"],
            description: "Model-free registered roster/inbox." });
          const container = new Container();
          container.addChild(new Text(theme.fg("accent", theme.bold("Generalist settings · Ctrl+S saves defaults")), 1, 1));
          const list = new SettingsList(items, items.length + 2, getSettingsListTheme(), (id, value) => {
            if (Object.hasOwn(settings, id)) { done(id); return; }
            try {
              if (id === "output") setRawJson(value === "on", pi, ctx);
              else setFeature(id as Exclude<FeatureId, "output">, value === "on", features, ctx);
            }
            catch (error) { ctx.ui.notify(String(error), "warning"); done(undefined); }
          }, () => done(undefined), { enableSearch: true });
          container.addChild(list);
          return {
            render: (width: number) => container.render(width),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => {
              if (isGeneralistSaveKey(keys, data)) persist(ctx);
              else list.handleInput?.(data);
              tui.requestRender();
            },
          };
        });
        if (selected && Object.hasOwn(settings, selected)) await settings[selected as keyof typeof settings]!(ctx);
        return;
      }
      if (target === "status" && !action) {
        if (ctx.hasUI) ctx.ui.notify(status(features, ctx), "info");
        return;
      }
      if (!target || !featureIds(features).includes(target as FeatureId) || !["on", "off", "toggle"].includes(action ?? "")) {
        if (ctx.hasUI) ctx.ui.notify(`Usage: /generalist [status|${featureIds(features).join("|")}] [on|off|toggle]`, "warning");
        return;
      }
      await ctx.waitForIdle();
      const feature = target as FeatureId;
      if (feature === "output") setRawJson(action === "toggle" ? !rawJsonOutput(ctx) : action === "on", pi, ctx);
      else setFeature(feature, action === "toggle" ? !features[feature]!() : action === "on", features, ctx);
    },
  });
}
