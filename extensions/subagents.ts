import { getAgentDir, loadProjectContextFiles, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { SubagentRuntime, runCard } from "../lib/subagents/runtime.ts";
import { SnapshotShelf } from "../lib/subagents/snapshot.ts";
import { LIMITS, type ContextSnapshotEvent } from "../lib/subagents/types.ts";
import { openRuns } from "../lib/subagents/ui.ts";
import { provisionWorker, registerActiveRuns, retireWorker } from "../lib/subagents/bridge.ts";

const schema = Type.Object({
  action: StringEnum(["start", "list", "status", "peek", "join", "input", "collect", "cancel", "checkpoints"] as const),
  id: Type.Optional(Type.String({ maxLength: 64 })), ids: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 16 })),
  mode: Type.Optional(StringEnum(["fresh", "fork"] as const)), task: Type.Optional(Type.String({ maxLength: LIMITS.taskBytes })),
  label: Type.Optional(Type.String({ maxLength: 160 })), from: Type.Optional(Type.String({ maxLength: 64 })),
  operation: Type.Optional(Type.String({ maxLength: 128 })),
  seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMITS.secondsMax })), all: Type.Optional(Type.Boolean()),
  after: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  question: Type.Optional(Type.String({ maxLength: 64 })), text: Type.Optional(Type.String({ maxLength: LIMITS.taskBytes })),
}, { additionalProperties: false });
const allowed: Record<string, string[]> = {
  start: ["mode", "task", "label", "from", "operation", "seconds"], list: [], status: ["id"], peek: ["id", "after", "limit"],
  join: ["ids", "seconds", "all"], input: ["id", "question", "text"], collect: ["id"], cancel: ["id", "all"], checkpoints: [],
};

export default function subagents(pi: ExtensionAPI, options: { workerEntry?: string; home?: string } = {}) {
  pi.registerFlag("subagent-forks", { description: "Human grant: share entire selected projected parent history with inspect workers, including potentially private historical text. Does not inherit activation or tools.", type: "boolean", default: false });
  pi.registerFlag("subagent-limit", { description: "Maximum concurrent inspect workers (0–16); not a staffing target.", type: "string", default: "4" });
  let runtime: SubagentRuntime | undefined, context: ExtensionContext | undefined, shelf = new SnapshotShelf();
  let sharing = false, waitingUI = false, removeInput: (() => void) | undefined;
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
    await runtime?.close(); removeInput?.(); unregisterActive?.(); context = ctx; waitingUI = false; shelf = new SnapshotShelf(); sharing = pi.getFlag("subagent-forks") === true;
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
  pi.on("session_tree", async () => { sharing = pi.getFlag("subagent-forks") === true; await runtime?.cancelAll("Confirmed parent branch change."); });
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
  pi.on("before_agent_start", (_event, ctx) => {
    const runs = runtime?.list().filter(r => !r.collectedAt) ?? [];
    if (!runs.length) return;
    const content = "Subagent status (observation, not a new assignment):\n" + runs.slice(-8).map(r => `${r.id}: ${r.taskState}, process ${r.process}${r.report ? ", report available" : ""}`).join("\n") + "\nUse subagents status/peek/collect as needed; reports are unverified claims.";
    const previous = [...ctx.sessionManager.getBranch()].reverse().find(e => e.type === "custom_message" && e.customType === "subagents:observation:v1");
    if (previous?.type === "custom_message" && previous.content === content) return;
    return { message: { customType: "subagents:observation:v1", content, display: false } };
  });
  pi.registerTool({ name: "subagents", label: "Subagents", parameters: schema, executionMode: "sequential",
    description: "Owned inspect-only SDK workers. Choose zero/one/several based on independent work; ceilings are not team-size targets. start(mode fresh|fork,task,label,operation?,from?,seconds<=1800) returns immediately; model is exactly the parent's current model, no fallback. Fork needs a captured checkpoint plus human history-sharing grant, excludes the entire delegating tool batch, and never inherits permissions. No shell/edits/recursive spawning. Prefer doing useful parent work before join. list/status(id)/peek(id,after=0,limit<=100) inspect without inference or acknowledgement; checkpoints lists captured fork origins. join(ids?,seconds<=300=60,all=false) waits for any result/blocker/failure/user input, not collection. input(id,question,text) answers only a pending clarification. collect(id) returns a report claim, not proof or transcript merge. cancel(id) or cancel(all=true) stops owned processes; cleanup is observed separately. Parent turn-end/closing peek leaves workers running; global stop/reload/session change/quit cancels. No idle-parent model wake. Linux/Node24+; max24 turns/80 tools/4096 output tokens per request/8MiB public log. Private host artifacts persist.",
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
          if (!ctx.model) throw new Error("Parent has no model; no silent worker fallback.");
          const snapshot = params.mode === "fork" ? shelf.select(ctx.sessionManager.getSessionId(), ctx.sessionManager.getBranch(), params.from) : undefined;
          if (snapshot?.providerRequestHooks) throw new Error("This parent has provider-payload hooks after the snapshot boundary. Faithful fork sharing is not established; use fresh explicitly.");
          if (snapshot && !sharing) {
            if (!ctx.hasUI || !await ctx.ui.confirm("Share fork history?", "This shares the entire selected projected history, which may include private text from memory, continuity, journals or summaries—even when those features are now off. There is no perfect scrubber. Worker tools/permissions remain inspect-only. Allow for this parent runtime?")) throw new Error("Fork history sharing not authorized. Use a human --subagent-forks grant or choose fresh explicitly.");
            sharing = true;
          }
          signal?.throwIfAborted(); if (runtime !== r) throw new Error("Parent session changed during launch.");
          const cwd = await realpath(ctx.cwd), agentDir = getAgentDir();
          // Only repository/ancestor instructions, never the global personal AGENTS file.
          const instructions = loadProjectContextFiles({ cwd, agentDir }).filter(file => {
            const rel = relative(agentDir, file.path); return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
          });
          result = await r.start({ mode: params.mode, task: params.task, label: params.label, operation: params.operation ?? callId,
            cwd, agentDir, model: { provider: ctx.model.provider, id: ctx.model.id }, thinking: pi.getThinkingLevel(), instructions, snapshot,
            privatePaths: [r.options.home, ...(ctx.sessionManager.getSessionFile() ? [dirname(ctx.sessionManager.getSessionFile()!)] : [])],
            seconds: params.seconds ?? LIMITS.seconds, maxTurns: LIMITS.turns, maxTools: LIMITS.tools, maxOutputTokens: LIMITS.outputTokens }); break;
        }
        case "list": result = { runs: r.list().slice(-16).map(runCard), total: r.list().length, maxActive: r.maxActive }; break;
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
  pi.registerCommand("subagents", { description: "Live model-free worker view; /subagents stop cancels all owned runs.", async handler(args, ctx) {
    const r = await ready(ctx);
    if (args.trim() === "stop") { await r.cancelAll("Human /subagents stop."); return; }
    if (args.trim()) throw new Error("Use /subagents or /subagents stop.");
    await openRuns(ctx, r);
  } });
}
