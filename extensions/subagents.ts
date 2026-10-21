import { getAgentDir, loadProjectContextFiles, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { nextForRun, runtimeParams, subagentFailure, subagentTools, type NextCall } from "../lib/subagents/contract.ts";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { SubagentRuntime, runCard } from "../lib/subagents/runtime.ts";
import { SnapshotShelf } from "../lib/subagents/snapshot.ts";
import { LIMITS, type ContextSnapshotEvent } from "../lib/subagents/types.ts";
import { loadWorkerLimits, saveWorkerLimits, validateWorkerLimits, RESOURCE_CEILINGS } from "../lib/subagents/limits.ts";
import { outsideGrantPaths } from "../lib/subagents/files.ts";
import { openRuns } from "../lib/subagents/ui.ts";
import { provisionWorker, registerActiveRuns, retireWorker } from "../lib/subagents/bridge.ts";
import { loadModelConfig, modelKey, resolveWorkerModel, saveModelConfig } from "../lib/subagents/models.ts";
import { forcedSubagentModel, normalizeForcedSubagentModel, setForcedSubagentModel } from "../lib/subagents/model-policy.ts";

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
    const content = "Subagent status (observation, not a new assignment):\n" + runs.slice(-8).map(r => `${r.id}: ${r.taskState}, process ${r.process}${r.report ? ", report available" : ""}`).join("\n") + "\nUse subagent_status, subagent_peek or subagent_collect as needed; reports are unverified claims.";
    const previous = [...ctx.sessionManager.getBranch()].reverse().find(e => e.type === "custom_message" && e.customType === "subagents:observation:v1");
    if (previous?.type === "custom_message" && previous.content === content) return systemPrompt ? { systemPrompt } : undefined;
    return { message: { customType: "subagents:observation:v1", content, display: false }, ...(systemPrompt ? { systemPrompt } : {}) };
  });
  // Static registrations: job state changes results, never the provider tool prefix.
  for (const tool of subagentTools) pi.registerTool({ ...tool, label: tool.name, executionMode: "sequential",
    async execute(_callId, raw, signal, _update, ctx) {
      if (!Check(tool.parameters, raw)) throw new Error(JSON.stringify({ code: "invalid_arguments", message: `Invalid ${tool.name} arguments.`, effect: "none", retryUnchanged: false,
        repair: "Use only this tool's declared fields and supply all required fields. Do not repeat the rejected call unchanged.", tool: tool.name, required: tool.parameters.required ?? [], allowed: Object.keys(tool.parameters.properties), nextCalls: [] }));
      const params = runtimeParams(tool.name, tool.action, raw);
      let effect = params.action === "start" ? "not_started" : "none";
      try {
        signal?.throwIfAborted();
        if (params.action === "guide" && params.text && Buffer.byteLength(params.text) > LIMITS.guidanceBytes) throw new Error("Guidance must be at most 4096 UTF-8 bytes.");
        const r = await ready(ctx);
        const id = () => params.id!;
        let result: unknown;
        switch (params.action) {
          case "start": {
            if (!params.mode || !params.task || !params.label) throw new Error("Explicit mode, task, and label required.");
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
            const permissions = params.permissions ?? "read-only";
            let readRoots: string[] | undefined;
            if (params.roots?.length) {
              if (permissions !== "read-only") throw new Error("roots apply only to read-only workers; implement workers already have host filesystem access.");
              readRoots = [...new Set(await Promise.all(params.roots.map(async root => {
                if (!isAbsolute(root)) throw new Error(`Read root must be an absolute path: ${root}`);
                const real = await realpath(root); if (real === "/" || !(await stat(real)).isDirectory()) throw new Error(`Read root must be a directory other than /: ${root}`);
                return real;
              })))];
              if (!ctx.hasUI || !await ctx.ui.confirm("Grant extra read-only roots?", `A read-only subagent will be able to read, list and search these directories (private state and secret-named files stay denied), and file contents are sent to provider ${model.provider}:\n${readRoots.join("\n")}\nAllow for this worker?`)) throw new Error("Additional read roots not authorized. They need interactive human confirmation; otherwise inspect the files yourself or pass their contents in the task.");
              signal?.throwIfAborted(); if (runtime !== r || branchEpoch !== launchEpoch) throw new Error("Parent session/branch changed during consent.");
            }
            // Only repository/ancestor instructions, never the global personal AGENTS file.
            const instructions = loadProjectContextFiles({ cwd, agentDir }).filter(file => {
              const rel = relative(agentDir, file.path); return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
            });
            signal?.throwIfAborted(); if (runtime !== r || branchEpoch !== launchEpoch) throw new Error("Parent session/branch changed during launch.");
            const inspectRoots = [cwd, ...(readRoots ?? [])];
            const grantWarnings = permissions === "read-only" ? await outsideGrantPaths(params.task, inspectRoots) : [];
            signal?.throwIfAborted(); if (runtime !== r || branchEpoch !== launchEpoch) throw new Error("Parent session/branch changed during path preflight.");
            effect = "unknown"; // Runtime may persist or spawn before rejecting; never promise no launch here.
            result = await r.start({ mode: params.mode, task: params.task, label: params.label, operation: params.operation!,
              cwd, agentDir, model, thinking, instructions, snapshot, permissions, ...(readRoots ? { readRoots } : {}),
              privatePaths: [r.options.home, ...(ctx.sessionManager.getSessionFile() ? [dirname(ctx.sessionManager.getSessionFile()!)] : [])],
              seconds: params.seconds ?? LIMITS.seconds, maxTurns: workerLimits.turns, maxTools: workerLimits.tools, maxOutputTokens: LIMITS.outputTokens }, () => {
                const available = ctx.modelRegistry.find(model.provider, model.id);
                if (!available || !ctx.modelRegistry.hasConfiguredAuth(available)) throw new Error("Selected worker model is unavailable or has no configured parent-side auth; no fallback or skipped ladder rung.");
              });
            if (permissions === "read-only") {
              result = { ...(result as object), inspectRoots, ...(grantWarnings.length ? { grantWarnings: { paths: grantWarnings,
                note: "Task paths are outside the read grant or traverse symlinks. Use canonical paths; targets outside inspectRoots need a restart with human-confirmed roots. Alternatively pass the needed content in the task or inspect it yourself." } } : {}) };
            }
            break;
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
          case "input": effect = "unknown"; result = await r.input(id(), params.question!, params.text!); break;
          case "guide": effect = "unknown"; result = await r.guide(id(), params.text!); break;
          case "collect": effect = "unknown"; result = await r.collect(id()); break;
          case "cancel": effect = "unknown"; result = await r.cancel(id()); break;
        }
        const body = result as Record<string, any>;
        const selected = params.id ? [r.status(params.id)] : params.ids ? params.ids.map(id => r.status(id))
          : params.action === "start" ? [r.status(body.id)] : params.action === "list" ? r.list().slice(-16) : [];
        const nextCalls: NextCall[] = selected.flatMap(nextForRun);
        if (params.action === "peek" && body.more) nextCalls.unshift({ tool: "subagent_peek", arguments: { runId: params.id, after: body.next } });
        const payload = { ...body, ...(body.id || params.id ? { runId: body.id ?? params.id } : {}),
          ...(body.operation ? { launchKey: body.operation } : {}),
          ...(body.record ? { record: { ...body.record, runId: body.record.id, launchKey: body.record.operation } } : {}),
          ...(Array.isArray(body.runs) ? { runs: body.runs.map((run: any) => ({ ...run, runId: run.id, launchKey: run.operation })) } : {}), nextCalls };
        return { content: [{ type: "text", text: JSON.stringify(payload) }], details: { action: params.action } };
      } catch (error) { throw subagentFailure(error, effect, params, runtime?.list() ?? []); }
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
