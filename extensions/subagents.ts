import { getAgentDir, loadProjectContextFiles, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
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

const actionUsage: Record<string, string> = {
  start: 'pass mode:"fresh"|"fork", task, label; optionally permissions, model, operation, seconds, roots, and from (fork only). Do not pass id: the host generates and returns the new worker run ID',
  list: 'pass only {"action":"list"}',
  models: 'pass only {"action":"models"}',
  checkpoints: 'pass only {"action":"checkpoints"}',
  status: 'pass {"action":"status","id":"RUN_ID"}',
  peek: 'pass id; optionally after (default 0) and limit (default 40, max 100)',
  join: 'pass optional ids:["RUN_ID"], seconds (default 60, max 300), all (default false); use ids, not id',
  input: 'pass id, question (pending question ID), text (answer)',
  guide: 'pass id, text (advice, max 4 KiB UTF-8)',
  collect: 'pass {"action":"collect","id":"RUN_ID"}',
  cancel: 'pass {"action":"cancel","id":"RUN_ID"} OR {"action":"cancel","all":true}',
};
const actionHelp = "Call one action at a time; omit unrelated fields.\n" + Object.entries(actionUsage).map(([action, usage]) => `${action}: ${usage}.`).join("\n")
  + '\nExamples: {"action":"start","mode":"fresh","task":"Review src/validation.ts; cite findings","label":"validation-review"}; {"action":"join","ids":["RUN_ID"],"seconds":60}; {"action":"collect","id":"RUN_ID"}.\n';

// Keep a flat object + StringEnum: action unions/conditional schemas are not
// supported consistently by providers. Required fields are action-specific below.
const schema = Type.Object({
  action: StringEnum(["start", "list", "status", "peek", "join", "input", "guide", "collect", "cancel", "checkpoints", "models"] as const, { description: "Operation to perform. start requires mode/task/label; status/peek/collect require id; input requires id/question/text; guide requires id/text; cancel requires id OR all:true. list/checkpoints/models take no other fields. join optionally takes ids/seconds/all. Omit fields that do not apply to the selected action." }),
  id: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: "Do NOT supply id for start/new workers: the host generates and returns it. Only use an existing worker run ID returned by start/list for status, peek, input, guide, collect, or cancel (required unless all:true). Not a label, checkpoint, or operation key. For join use ids instead." })),
  ids: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 16, description: "join only: worker run IDs to wait for. Omit to select the latest 16 uncollected runs; [] selects none. Use this array even for one worker." })),
  mode: Type.Optional(StringEnum(["fresh", "fork"] as const, { description: "Required for start. fresh receives only the assignment and repository instructions; fork also receives a captured parent-history checkpoint and needs human history-sharing consent. No default or fallback." })),
  task: Type.Optional(Type.String({ minLength: 1, maxLength: LIMITS.taskBytes, description: "Required for start: self-contained worker assignment (<=32 KiB UTF-8). Include constraints, expected output, and disjoint file ownership for implement workers. Does not grant permissions." })),
  permissions: Type.Optional(StringEnum(["read-only", "implement"] as const, { description: "start only: read-only (default): scoped inspection, no shell or edits. implement: normal coding tools including shell, edits and writes in the shared checkout; not sandboxed. Independent of fresh/fork origin; task text alone cannot grant tools." })),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: 160, description: "Required for start: short human-readable worker name. Later actions use the returned run id, not this label." })),
  from: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: "start with mode:fork only: exact anchor from checkpoints on the current branch. Omit to use the latest safe captured checkpoint. Not a worker run ID or arbitrary session/file path; forbidden for fresh." })),
  operation: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "start only: optional retry/idempotency key; defaults to this tool-call ID. Reuse only for identical launch intent to retrieve the existing run, including failures. Changed intent is rejected; later actions use run id instead." })),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "start only: self (default; same is an alias), next-smaller (immediate configured ladder successor), or exact provider/model ID. No fallback. A human-configured model lock cannot be overridden." })),
  roots: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 4, description: "read-only start only: extra absolute directories the worker may read/ls/grep, beyond the checkout. Needs interactive human confirmation; private paths stay denied." })),
  seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMITS.secondsMax, description: "start: worker wall-clock deadline, 1..1800 seconds (default 600), including clarification time. join: wait timeout, 1..300 seconds (default 60); does not change worker deadlines. No other action accepts seconds." })),
  all: Type.Optional(Type.Boolean({ description: "join: wait for all selected runs (default false/wait-any); still yields for blockers, failure or user input. cancel: all:true cancels every owned worker; omit id. Does not collect reports. No other action accepts all." })),
  after: Type.Optional(Type.Integer({ minimum: 0, description: "peek only: public-event cursor (default 0). For the next page pass the previous peek result's next value." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "peek only: maximum events per page, 1..100 (default 40); output is also byte-bounded." })),
  question: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: "Required for input: exact pending clarification question ID from status/peek/join. Not the question text or worker ID. Use guide for unsolicited advice." })),
  text: Type.Optional(Type.String({ minLength: 1, maxLength: LIMITS.taskBytes, description: "Required for input or guide only. input: answer to the pending question (<=32 KiB UTF-8). guide: advice to a running worker (<=4 KiB UTF-8, at most 8/run), delivered at its next model boundary; does not change permissions, ownership, scope or budget." })),
}, { additionalProperties: false });
const allowed: Record<string, string[]> = {
  start: ["mode", "permissions", "task", "label", "from", "operation", "seconds", "model", "roots"], models: [], list: [], status: ["id"], peek: ["id", "after", "limit"],
  join: ["ids", "seconds", "all"], input: ["id", "question", "text"], guide: ["id", "text"], collect: ["id"], cancel: ["id", "all"], checkpoints: [],
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
    description: "Delegate independent work to owned SDK workers. Choose zero, one or several; concurrency ceilings are not staffing targets.\n\n" + actionHelp
      + "\nStart returns immediately. Do useful parent work before join. Workflow: start -> status/peek or join -> answer blockers with input -> collect -> verify findings and changes. join waits without collecting; collect returns an unverified report claim, not a transcript merge. list/status/peek/models/checkpoints inspect without inference or acknowledgement."
      + "\n\nPermissions: read-only (default) has scoped read/ls/grep, no shell or edits. implement is explicit unsandboxed host access with normal coding tools including bash/edit/write in the shared live checkout; no rollback. Assign disjoint files and review actual diffs/checks. Neither profile can recursively delegate or use personal memory/history tools. Extra roots need interactive human confirmation and apply only to read-only; start returns inspectRoots and any grantWarnings for outside/symlink task paths."
      + "\n\nModels/history: model defaults to self; next-smaller uses exactly the next configured ladder rung; provider/model selects an exact identity. No fallback or skipped rung. Human model locks cannot be overridden; models reports the ladder/lock. Thinking inherits the parent; model choice grants no permissions. fork requires a captured checkpoint plus human history-sharing grant, excludes the whole delegating tool batch, and never inherits permissions. checkpoints lists available anchors for from; fresh needs no history grant."
      + "\n\nGuidance: guide sends parent advice to a running worker (max 8/run), appended at its next model boundary without rewriting context; peek shows guidance-delivered. It is not user authority and grants no permissions, ownership, scope or budget. Use input instead when the worker has a pending clarification."
      + "\n\nLifetime/limits: cancel requests process shutdown; cleanup is observed separately. Parent turn-end and closing peek leave workers running; global stop/reload/session change/quit cancels them. No idle-parent model wake. Linux/Node24+. Default 24 work turns/80 tool calls (human /subagents limits), plus one report-only synthesis on turn/tool exhaustion; collect retains findings with budget-exceeded status. Cancellation, deadlines and hard failures do not grant synthesis. 4096 output tokens/request; 8 MiB public log. Private host artifacts persist.",
    async execute(callId, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const fields = allowed[params.action];
      if (!fields) throw new Error(`Unknown subagents action: ${params.action}. Choose ${Object.keys(allowed).join(", ")}.`);
      const usage = `For ${params.action}, ${actionUsage[params.action]}. Omit unrelated fields.`;
      for (const [key, value] of Object.entries(params)) if (key !== "action" && value !== undefined && !fields.includes(key)) throw new Error(`${key} is not valid for ${params.action}. ${usage}`);
      const required = params.action === "start" ? ["mode", "task", "label"]
        : params.action === "input" ? ["id", "question", "text"]
        : params.action === "guide" ? ["id", "text"]
        : ["status", "peek", "collect"].includes(params.action) || (params.action === "cancel" && params.all !== true) ? ["id"] : [];
      const missing = required.filter(key => !params[key as keyof typeof params]);
      if (missing.length) throw new Error(`Missing required ${missing.join(", ")}. ${usage}`);
      if (params.action === "cancel" && params.all === true && params.id) throw new Error(`Choose id or all, not both. ${usage}`);
      if (params.action === "start" && params.mode === "fresh" && params.from !== undefined) throw new Error("Fresh workers cannot specify a fork checkpoint. Omit from, or use mode:fork with an anchor returned by checkpoints.");
      if (params.action === "join" && params.seconds !== undefined && params.seconds > 300) throw new Error(`Join timeout must be 1–300 seconds (default 60). ${usage}`);
      if (params.action === "guide" && params.text && Buffer.byteLength(params.text) > LIMITS.guidanceBytes) throw new Error(`guide text must be at most ${LIMITS.guidanceBytes} UTF-8 bytes; input answers allow ${LIMITS.taskBytes} bytes.`);
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
          result = await r.start({ mode: params.mode, task: params.task, label: params.label, operation: params.operation ?? callId,
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
        case "input": if (!params.question || !params.text) throw new Error("question and text required."); result = await r.input(id(), params.question, params.text); break;
        case "guide": if (!params.text) throw new Error("text required."); result = await r.guide(id(), params.text); break;
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
