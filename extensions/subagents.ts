import { getAgentDir, loadProjectContextFiles, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { SubagentRuntime, runCard } from "../lib/subagents/runtime.ts";
import { SnapshotShelf } from "../lib/subagents/snapshot.ts";
import { LIMITS, type ContextSnapshotEvent } from "../lib/subagents/types.ts";
import { loadWorkerLimits, saveWorkerLimits, validateWorkerLimits, RESOURCE_CEILINGS } from "../lib/subagents/limits.ts";
import { openRuns } from "../lib/subagents/ui.ts";
import { provisionWorker, registerActiveRuns, retireWorker } from "../lib/subagents/bridge.ts";
import { loadModelConfig, modelKey, resolveWorkerModel, saveModelConfig } from "../lib/subagents/models.ts";
import { forcedSubagentModel, normalizeForcedSubagentModel, setForcedSubagentModel } from "../lib/subagents/model-policy.ts";

const schema = Type.Object({
  action: StringEnum(["start", "list", "status", "peek", "join", "input", "collect", "cancel", "checkpoints", "models"] as const),
  id: Type.Optional(Type.String({ maxLength: 64 })), ids: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 16 })),
  mode: Type.Optional(StringEnum(["fresh", "fork"] as const)), task: Type.Optional(Type.String({ maxLength: LIMITS.taskBytes })),
  permissions: Type.Optional(StringEnum(["read-only", "implement"] as const, { description: "read-only (default): scoped inspection, no shell or edits. implement: normal coding tools including shell, edits and writes in the shared checkout; not sandboxed. Independent of fresh/fork origin; task text alone cannot grant tools." })),
  label: Type.Optional(Type.String({ maxLength: 160 })), from: Type.Optional(Type.String({ maxLength: 64 })),
  operation: Type.Optional(Type.String({ maxLength: 128 })),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "self (default; same is an alias), next-smaller (immediate configured ladder successor), or exact provider/model ID. No fallback. A human-configured model lock cannot be overridden." })),
  seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMITS.secondsMax })), all: Type.Optional(Type.Boolean()),
  after: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  question: Type.Optional(Type.String({ maxLength: 64 })), text: Type.Optional(Type.String({ maxLength: LIMITS.taskBytes })),
}, { additionalProperties: false });
const allowed: Record<string, string[]> = {
  start: ["mode", "permissions", "task", "label", "from", "operation", "seconds", "model"], models: [], list: [], status: ["id"], peek: ["id", "after", "limit"],
  join: ["ids", "seconds", "all"], input: ["id", "question", "text"], collect: ["id"], cancel: ["id", "all"], checkpoints: [],
};

export default function subagents(pi: ExtensionAPI, options: { workerEntry?: string; home?: string; agentDir?: string } = {}) {
  pi.registerFlag("subagent-forks", { description: "Human grant: share entire selected projected history with workers at the parent's startup provider. Other providers require confirmation. Includes potentially private text; no inherited activation or tools.", type: "boolean", default: false });
  pi.registerFlag("subagent-limit", { description: "Maximum concurrent workers (0–16); not a staffing target.", type: "string", default: "4" });
  let runtime: SubagentRuntime | undefined, context: ExtensionContext | undefined, shelf = new SnapshotShelf();
  let sharing = new Set<string>(), waitingUI = false, removeInput: (() => void) | undefined;
  let branchEpoch = 0;
  const grantedProviders = (ctx: ExtensionContext) => new Set(pi.getFlag("subagent-forks") === true && ctx.model ? [ctx.model.provider] : []);
  let unregisterActive: (() => void) | undefined;
  const ready = async (ctx: ExtensionContext) => {
    if (!runtime || runtime.options.owner !== ctx.sessionManager.getSessionId()) throw new Error("Subagent runtime unavailable for this session.");
    const r = runtime; await r.initialize(); if (runtime !== r) throw new Error("Session changed."); return r;
  };
  const ui = () => {
    if (!context?.hasUI || !runtime) return;
    const runs = runtime.list(), blocked = runs.filter(r => r.taskState === "needs-input").length;
    const reports = runs.filter(r => r.report && !r.collectedAt).length;
    context.ui.setStatus("subagents", runs.length ? `runs: ${runtime.activeCount} live · ${blocked} blocked · ${reports} reports` : undefined);
  };
  pi.on("session_start", async (_event, ctx) => {
    await runtime?.close(); removeInput?.(); unregisterActive?.(); context = ctx; waitingUI = false; branchEpoch++; shelf = new SnapshotShelf(); sharing = grantedProviders(ctx);
    runtime = new SubagentRuntime({ workerEntry: options.workerEntry, home: options.home ?? process.env.PI_SUBAGENTS_HOME ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "pi-subagents"),
      owner: ctx.sessionManager.getSessionId(), maxActive: Number(pi.getFlag("subagent-limit") ?? "4"), onChange: ui,
      provision: (id, file) => provisionWorker(pi, id, file), retire: id => retireWorker(pi, id) });
    unregisterActive = registerActiveRuns(pi, () => (runtime?.activeCount ?? 0) + (runtime?.list().filter(r => r.process === "starting").length ?? 0), async () => { await runtime?.close(); });
    // No registration, disk reads, or processes until explicit tool/UI use.
    if (ctx.mode === "tui") removeInput = ctx.ui.onTerminalInput(data => {
      if (data === "\x1b" && !waitingUI && runtime?.activeCount) void runtime.cancelAll("Global stop (Escape).");
      return undefined;
    });
  });
  pi.on("session_shutdown", async () => { removeInput?.(); removeInput = undefined; const old = runtime; await old?.close(); unregisterActive?.(); unregisterActive = undefined; runtime = undefined; context = undefined; });
  pi.on("session_tree", async (_event, ctx) => { branchEpoch++; sharing = grantedProviders(ctx); await runtime?.cancelAll("Confirmed parent branch change."); });
  pi.on("ui_prompt_start", () => { waitingUI = true; });
  pi.on("ui_prompt_end", () => { waitingUI = false; });
  pi.on("input", event => { if (event.source !== "extension") runtime?.interruptJoin(); });
  pi.on("agent_end", async event => {
    const last = event.messages.filter(m => m.role === "assistant").at(-1);
    if (last?.stopReason === "aborted") await runtime?.cancelAll("Parent agent aborted.");
  });
  // Invalidate the default checkpoint on EVERY request. If final observation fails
  // or the host lacks the hook, never silently reuse an older successful snapshot.
  pi.on("context", () => { shelf.error = "Awaiting final Pi context_snapshot observation for this request; no safe default fork checkpoint."; });
  // Optional core hook; older Pi accepts registration but never emits it. Fork then fails explicitly.
  const observe = pi.on as unknown as (name: "context_snapshot", handler: (event: ContextSnapshotEvent, ctx: ExtensionContext) => void) => void;
  observe("context_snapshot", (event, ctx) => { shelf.capture(event, ctx.sessionManager.getSessionId(), ctx.sessionManager.getBranch()); });
  pi.on("before_agent_start", (event, ctx) => {
    const forcedModel = forcedSubagentModel(ctx);
    const guidance = forcedModel ? `Subagent model selection is human-locked to ${forcedModel}; you cannot change it. Omit model or pass exactly ${forcedModel}.` : undefined;
    const systemPrompt = guidance && !event.systemPrompt.includes(guidance) ? `${event.systemPrompt}\n\n${guidance}` : undefined;
    const runs = runtime?.list().filter(r => !r.collectedAt) ?? [];
    if (!runs.length) return systemPrompt ? { systemPrompt } : undefined;
    const content = "Subagent status (observation, not a new assignment):\n" + runs.slice(-8).map(r => `${r.id}: ${r.taskState}, process ${r.process}${r.report ? ", report available" : ""}`).join("\n") + "\nUse subagents status/peek/collect as needed; reports are unverified claims.";
    const previous = [...ctx.sessionManager.getBranch()].reverse().find(e => e.type === "custom_message" && e.customType === "subagents:observation:v1");
    if (previous?.type === "custom_message" && previous.content === content) return systemPrompt ? { systemPrompt } : undefined;
    return { message: { customType: "subagents:observation:v1", content, display: false }, ...(systemPrompt ? { systemPrompt } : {}) };
  });
  pi.registerTool({ name: "subagents", label: "Subagents", parameters: schema, executionMode: "sequential",
    description: "Owned SDK workers; permissions read-only (default) or implement (explicit opt-in). Choose zero/one/several based on independent work; ceilings are not team-size targets. start(mode fresh|fork,task,label,permissions?,model?,operation?,from?,seconds<=1800) returns immediately. model is self (default), next-smaller (immediate configured ladder successor), or exact provider/model; no fallback or skipped rungs. A human model lock, when enabled, cannot be overridden. models inspects the configured ladder and lock. Thinking inherits the parent; model choice adds no permissions. Fork needs a captured checkpoint plus human history-sharing grant, excludes the entire delegating tool batch, and never inherits permissions. Read-only has scoped read/ls/grep, no shell/edits. Implement has normal coding tools including bash/edit/write: shared live checkout, unsandboxed host access, no rollback. Assign disjoint file ownership; review changes and checks. No recursive delegation or personal memory/history tools in either profile. Prefer doing useful parent work before join. list/status(id)/peek(id,after=0,limit<=100) inspect without inference or acknowledgement; checkpoints lists captured fork origins. join(ids?,seconds<=300=60,all=false) waits for any result/blocker/failure/user input, not collection. input(id,question,text) answers only a pending clarification. collect(id) returns a report claim, not proof or transcript merge. cancel(id) or cancel(all=true) stops owned processes; cleanup is observed separately. Parent turn-end/closing peek leaves workers running; global stop/reload/session change/quit cancels. No idle-parent model wake. Linux/Node24+; default 24 turns/80 tools (human-configurable via /subagents limits), 4096 output tokens per request/8MiB public log. Private host artifacts persist.",
    async execute(callId, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      for (const [key, value] of Object.entries(params)) if (key !== "action" && value !== undefined && !allowed[params.action]!.includes(key)) throw new Error(`${key} is not valid for ${params.action}.`);
      const r = await ready(ctx);
      const id = () => { if (!params.id) throw new Error("id required."); return params.id; };
      let result: unknown;
      switch (params.action) {
        case "start": {
          if (!params.mode || !params.task || !params.label) throw new Error("Explicit mode, task, and label required.");
          if (params.mode === "fresh" && params.from) throw new Error("Fresh workers cannot specify a fork checkpoint.");
          const launchEpoch = branchEpoch, agentDir = options.agentDir ?? getAgentDir();
          const forcedModel = forcedSubagentModel(ctx);
          const requestedModel = params.model === "same" ? "self" : params.model;
          if (forcedModel && requestedModel && requestedModel !== forcedModel) throw new Error(`Subagent model is human-locked to ${forcedModel}; the agent cannot override it.`);
          const model = resolveWorkerModel(forcedModel ?? params.model, ctx.model, () => loadModelConfig(agentDir));
          const thinking = pi.getThinkingLevel();
          const workerLimits = loadWorkerLimits(agentDir);
          const snapshot = params.mode === "fork" ? shelf.select(ctx.sessionManager.getSessionId(), ctx.sessionManager.getBranch(), params.from) : undefined;
          if (snapshot?.providerRequestHooks) throw new Error("This parent has provider-payload hooks after the snapshot boundary. Faithful fork sharing is not established; use fresh explicitly.");
          if (snapshot && !sharing.has(model.provider)) {
            if (!ctx.hasUI || !await ctx.ui.confirm(`Share fork history with ${modelKey(model)}?`, `This sends the entire selected projected history to provider ${model.provider}, potentially including private memory, continuity, journals or summaries—even when now off. There is no perfect scrubber. History consent does not grant tools; this launch requests ${params.permissions ?? "read-only"} permissions. Allow sharing with this provider for this parent runtime?`)) throw new Error("Fork history sharing not authorized for the selected provider. Confirm interactively, use the parent's provider with a human --subagent-forks grant, or choose fresh explicitly.");
            signal?.throwIfAborted(); if (runtime !== r || branchEpoch !== launchEpoch) throw new Error("Parent session/branch changed during consent.");
            sharing.add(model.provider);
          }
          signal?.throwIfAborted(); if (runtime !== r) throw new Error("Parent session changed during launch.");
          const cwd = await realpath(ctx.cwd);
          // Only repository/ancestor instructions, never the global personal AGENTS file.
          const instructions = loadProjectContextFiles({ cwd, agentDir }).filter(file => {
            const rel = relative(agentDir, file.path); return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
          });
          signal?.throwIfAborted(); if (runtime !== r || branchEpoch !== launchEpoch) throw new Error("Parent session/branch changed during launch.");
          result = await r.start({ mode: params.mode, task: params.task, label: params.label, operation: params.operation ?? callId,
            cwd, agentDir, model, thinking, instructions, snapshot, permissions: params.permissions ?? "read-only",
            privatePaths: [r.options.home, ...(ctx.sessionManager.getSessionFile() ? [dirname(ctx.sessionManager.getSessionFile()!)] : [])],
            seconds: params.seconds ?? LIMITS.seconds, maxTurns: workerLimits.turns, maxTools: workerLimits.tools, maxOutputTokens: LIMITS.outputTokens }, () => {
              const available = ctx.modelRegistry.find(model.provider, model.id);
              if (!available || !ctx.modelRegistry.hasConfiguredAuth(available)) throw new Error("Selected worker model is unavailable or has no configured parent-side auth; no fallback or skipped ladder rung.");
            }); break;
        }
        case "models": {
          const config = loadModelConfig(options.agentDir ?? getAgentDir());
          result = { parent: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null, forcedModel: forcedSubagentModel(ctx),
            ladder: (config?.ladder ?? []).map(id => { const ref = resolveWorkerModel(id, undefined, () => undefined), m = ctx.modelRegistry.find(ref.provider, ref.id);
              return { model: id, parentAvailable: !!m && ctx.modelRegistry.hasConfiguredAuth(m) }; }),
            note: "Human-configured order, not measured capability. next-smaller uses exactly the immediate successor. Worker-side availability/auth are checked separately; no fallback." }; break;
        }
        case "list": result = { runs: r.list().slice(-16).map(runCard), total: r.list().length, maxActive: r.maxActive, newRunLimits: loadWorkerLimits(options.agentDir ?? getAgentDir()) }; break;
        case "status": result = r.status(id()); break;
        case "peek": result = await r.peek(id(), params.after, params.limit); break;
        case "checkpoints": result = { checkpoints: shelf.list(), lastError: shelf.error, note: "Only observed post-projection checkpoints, bounded to this runtime. Not the entire saved tree." }; break;
        case "join": result = await r.join(params.ids, params.seconds, params.all, signal); break;
        case "input": if (!params.question || !params.text) throw new Error("question and text required."); result = await r.input(id(), params.question, params.text); break;
        case "collect": result = await r.collect(id()); break;
        case "cancel": if (params.all === true) { if (params.id) throw new Error("Choose id or all, not both."); await r.cancelAll("Parent requested cancel all."); result = r.list().slice(-16).map(runCard); } else result = await r.cancel(id()); break;
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: { action: params.action } };
    },
  });
  pi.registerCommand("subagents", { description: "Worker view; stop cancels; ladder configures routing; limits [turns tools] configures new-run budgets; model [off|self|next-smaller|provider/model] sets a human lock.", async handler(args, ctx) {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    if (parts[0] === "model") {
      if (parts.length > 2) throw new Error("Use /subagents model [off|self|next-smaller|provider/model].");
      if (parts[1]) setForcedSubagentModel(pi, normalizeForcedSubagentModel(parts[1]));
      if (ctx.hasUI) {
        const selected = forcedSubagentModel(ctx);
        ctx.ui.notify(selected ? `Subagent model locked to ${selected}. The agent cannot override it.` : "Subagent model lock: off. Use /subagents model self|next-smaller|provider/model to enable it.", "info");
      }
      return;
    }
    if (parts[0] === "limits") {
      if (parts.length !== 1 && parts.length !== 3) throw new Error("Use /subagents limits [turns tools].");
      const agentDir = options.agentDir ?? getAgentDir();
      if (parts.length === 3) {
        const numbers = parts.slice(1).map(part => /^\d+$/.test(part) ? Number(part) : NaN);
        saveWorkerLimits(agentDir, validateWorkerLimits({ version: 1, turns: numbers[0], tools: numbers[1] }));
      }
      const limits = loadWorkerLimits(agentDir);
      if (ctx.hasUI) ctx.ui.notify(`New subagent runs: ${limits.turns} turns, ${limits.tools} tool calls. Existing runs are unchanged. Set with /subagents limits <1–${RESOURCE_CEILINGS.turns}> <1–${RESOURCE_CEILINGS.tools}>.`, "info");
      return;
    }
    if (parts[0] === "ladder") {
      const agentDir = options.agentDir ?? getAgentDir();
      if (parts.length > 1) saveModelConfig(agentDir, { version: 1, ladder: parts.slice(1) });
      const ladder = loadModelConfig(agentDir)?.ladder ?? [];
      if (ctx.hasUI) ctx.ui.notify(ladder.length ? `Worker model ladder (largest → smallest):\n${ladder.join(" → ")}\nOnly the immediate successor is used; availability is checked at launch.` : "No ladder configured. Use /subagents ladder provider/largest provider/smaller ... with exact Pi IDs.", "info");
      return;
    }
    const r = await ready(ctx);
    if (args.trim() === "stop") { await r.cancelAll("Human /subagents stop."); return; }
    if (args.trim()) throw new Error("Use /subagents, /subagents stop, /subagents limits [turns tools], /subagents ladder [provider/model ...], or /subagents model [off|self|next-smaller|provider/model].");
    await openRuns(ctx, r);
  } });
}
