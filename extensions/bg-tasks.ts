import { getAgentDir, type ExtensionAPI, type ExtensionContext, type TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { BackgroundJobRuntime, shouldNotifyCompletion, type JobNotify, type JobRecord, type WaitFor } from "../lib/bg-tasks/runtime.ts";
import { CompletionQueue, COMPLETION_DELAY_MS, COMPLETION_BATCH_SIZE, completionPacket, formatCompletions, type CompletionPacket } from "../lib/bg-tasks/completion.ts";

const Actions = ["start", "list", "status", "output", "cancel", "ignore", "wait"] as const;
type Action = (typeof Actions)[number];
const actionUsage: Record<Action, string> = {
  start: 'command required; optional cwd, label, timeoutSeconds, notify. Do NOT supply id on start. Omit id; the runtime generates and returns it. Use label to name the job. Example: {"action":"start","command":"bun test","label":"tests"}',
  list: 'action only; no other fields. Example: {"action":"list"}',
  status: 'id required (existing job ID from start/list); no other fields. Example: {"action":"status","id":"JOB_ID"}',
  output: 'id required (existing job ID); optional cursor, limit, tail; no other fields. Example: {"action":"output","id":"JOB_ID","tail":true}',
  cancel: 'exactly one of id (existing job ID) or all:true; no other fields. Example: {"action":"cancel","id":"JOB_ID"} OR {"action":"cancel","all":true}',
  ignore: 'exactly one of id (existing job ID) or all:true; no other fields. Example: {"action":"ignore","id":"JOB_ID"} OR {"action":"ignore","all":true}',
  wait: 'waitFor required; optional seconds; no id or other fields. Example: {"action":"wait","waitFor":"all","seconds":60}',
};
const actionHelp = "Call one action at a time; omit unrelated fields.\n" + Actions.map(action => `${action}: ${actionUsage[action]}.`).join("\n");
const ToolSchema = Type.Object({
  action: StringEnum(Actions, { description: actionHelp }),
  command: Type.Optional(Type.String({ maxLength: 16_384, description: "start only: required finite shell command. No other action accepts command." })),
  cwd: Type.Optional(Type.String({ maxLength: 4_096, description: "start only: working directory; defaults to the current session cwd." })),
  label: Type.Optional(Type.String({ maxLength: 200, description: "start only: optional human-readable job name, not an ID. Later actions use the returned job ID." })),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 14_400, description: "start only: job execution timeout in seconds (1..14400); not the wait timeout." })),
  notify: Type.Optional(StringEnum(["always", "errors", "off"] as const, { description: "start only: completion wake policy: always (default), errors (quiet on clean exit 0), or off (never wake; result remains inspectable)." })),
  id: Type.Optional(Type.String({ maxLength: 128, description: "Do NOT supply id on start: the runtime generates and returns the job ID. Use an existing job ID returned by start/list for status, output, cancel, or ignore only. wait uses waitFor, not id. Use label to name a new job." })), cursor: Type.Optional(Type.String({ maxLength: 256, description: "output only: opaque cursor returned by a previous output read for this job." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 * 1024, description: "output only: maximum output page bytes (1..32768)." })),
  tail: Type.Optional(Type.Boolean({ description: "output only: read the retained output tail instead of starting at the beginning." })),
  all: Type.Optional(Type.Boolean({ description: "cancel/ignore only: all:true selects every currently running job; omit id. Otherwise supply id. No other action accepts all." })),
  waitFor: Type.Optional(StringEnum(["next", "all"] as const, { description: "wait only, required: next waits for the next currently running job to settle; all waits for jobs running at call time. Do not supply id." })),
  seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 300, description: "wait only: bounded wait timeout (1..300 seconds, default 60); does not change job execution deadlines." })),
}, { additionalProperties: false });
type Params = { action: Action; command?: string; cwd?: string; label?: string; timeoutSeconds?: number; notify?: JobNotify; id?: string; cursor?: string; limit?: number; tail?: boolean; all?: boolean; waitFor?: WaitFor; seconds?: number };

function requireOnly(params: Params, action: Action, allowed: readonly (keyof Params)[]): void {
  for (const [key, value] of Object.entries(params)) if (key !== "action" && value !== undefined && !allowed.includes(key as keyof Params)) throw new Error(`${key} is not valid for bg_tasks ${action}. For ${action}, ${actionUsage[action]}. Omit unrelated fields.`);
}
function requireId(params: Params): string { if (!params.id) throw new Error(`id is required for bg_tasks ${params.action}. For ${params.action}, ${actionUsage[params.action]}.`); return params.id; }
function running(jobs: BackgroundJobRuntime): JobRecord[] { return jobs.pending(); }
function selectedRunning(jobs: BackgroundJobRuntime, params: Params): string[] {
  if (!!params.id === (params.all === true)) throw new Error(`Specify exactly one of id or all=true. For ${params.action}, ${actionUsage[params.action]}.`);
  return params.id ? [params.id] : running(jobs).map(job => job.id);
}
function formatJob(job: JobRecord): string {
  const exit = job.execution === "exited" ? ` exit=${job.exitCode ?? "null"}${job.signal ? ` signal=${job.signal}` : ""}` : "";
  return `${job.id}${job.label ? ` (${job.label})` : ""}: ${job.execution}${exit}; cleanup=${job.cleanup}; output=${job.retainedBytes}/${job.capturedBytes} bytes; notify=${job.notify}`;
}

// Only explicit status reads expose receipt metadata. Keep tool definitions,
// completion messages, and earlier context stable as artifacts accumulate.
function formatStatus(job: JobRecord): string {
  const receipt = job.receipt;
  return formatJob(job) + (receipt ? `\nReceipt: ${receipt.state}; path=${JSON.stringify(receipt.path)}${receipt.sha256 ? `; sha256=${receipt.sha256}` : ""}` : "") +
    (job.persistenceError ? "\nWarning: execution metadata persistence failed; inspect job details." : "");
}

/** Explicit session-bound background execution; ordinary bash remains unchanged. */
export default function bgTasks(pi: ExtensionAPI) {
  let runtime: BackgroundJobRuntime | undefined;
  let generation = 0;
  const completions = new CompletionQueue();
  let context: ExtensionContext | undefined;
  let busy = false, suspended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const message = (packets: CompletionPacket[], remaining: number, disposition = "") => ({
    customType: "generalist:bg-tasks:completion-v2",
    content: [formatCompletions(packets, remaining), disposition].filter(Boolean).join("\n\n"),
    display: true, details: { completions: packets, remaining },
  });
  const reportDeliveryError = (error: unknown) => { if (context?.hasUI) context.ui.notify(`Background completion delivery failed; inspect bg_tasks explicitly: ${String(error).slice(0, 300)}`, "warning"); };
  const scheduleIdle = () => {
    if (timer || busy || suspended || !completions.size) return;
    const current = generation;
    timer = setTimeout(() => {
      timer = undefined;
      const jobs = runtime;
      const allowed = () => current === generation && !busy && !suspended && (context?.isIdle?.() ?? true);
      if (!jobs || !allowed()) return; // No polling. The next lifecycle boundary drains it.
      void completions.drain(jobs, (packets, remaining) => {
        pi.sendMessage(message(packets, remaining), { deliverAs: "steer", triggerTurn: true });
      }, allowed).catch(reportDeliveryError);
    }, COMPLETION_DELAY_MS);
  };
  const createRuntime = (ctx: ExtensionContext) => {
    clearTimer(); completions.clear(); context = ctx; busy = false; suspended = false;
    generation++;
    const current = generation;
    const session = ctx.sessionManager.getSessionId?.() ?? "ephemeral";
    runtime = new BackgroundJobRuntime(`${getAgentDir()}/bg-tasks`, `${session}/${current}`, job => {
      if (current !== generation) return;
      pi.appendEntry("generalist:bg-tasks:result-v1", { id: job.id, execution: job.execution, exitCode: job.exitCode, signal: job.signal, cleanup: job.cleanup, receipt: job.receipt, persistenceError: job.persistenceError });
      if (job.stopReason === "session_shutdown" || !shouldNotifyCompletion(job)) return;
      completions.add(job);
      scheduleIdle();
    });
  };
  const getRuntime = (ctx: ExtensionContext) => runtime ?? (createRuntime(ctx), runtime!);

  pi.on("session_start", (_event, ctx) => createRuntime(ctx));
  const teardown = async () => { generation++; clearTimer(); completions.clear(); suspended = true; const old = runtime; runtime = undefined; await old?.shutdown(); };
  pi.on("session_shutdown", teardown);
  pi.on("session_tree", async (_event, ctx) => { await teardown(); createRuntime(ctx); });
  pi.on("before_agent_start", async (_event, ctx) => {
    busy = true; suspended = false; clearTimer(); context = ctx;
    const current = generation;
    let observation: ReturnType<typeof message> | undefined;
    if (runtime) await completions.drain(runtime, (packets, remaining) => { observation = message(packets, remaining); }, () => current === generation && !suspended);
    return observation ? { message: observation } : undefined;
  });
  pi.on("agent_start", () => { busy = true; clearTimer(); });
  pi.on("agent_end", event => {
    busy = false;
    const last = event.messages.filter(m => m.role === "assistant").at(-1);
    if (last?.stopReason === "aborted" || last?.stopReason === "error") { suspended = true; clearTimer(); }
    else scheduleIdle();
  });
  // Optional on older Pi; on the fork this closes the end/settle race without polling.
  const onSettled = pi.on as unknown as (name: "agent_settled", handler: () => void) => void;
  onSettled("agent_settled", () => { scheduleIdle(); });
  const onBoundary = pi.on as unknown as (name: "turn_end", handler: (event: TurnEndEvent, ctx: ExtensionContext) => Promise<unknown>) => void;
  onBoundary("turn_end", async (event, ctx) => {
    if (!runtime || event.message.role !== "assistant") return;
    if (event.message.stopReason === "aborted" || event.message.stopReason === "error" || ctx.signal?.aborted) { suspended = true; clearTimer(); return; }
    suspended = false;
    const current = generation;
    let packets: CompletionPacket[] = [], remaining = 0;
    await completions.drain(runtime, (ready, rest) => { packets = ready; remaining = rest; }, () => current === generation && !ctx.signal?.aborted);
    if (current !== generation || ctx.signal?.aborted) return;
    const unattended = event.message.stopReason === "stop" ? runtime.pending().filter(job => job.notify !== "off") : [];
    const summary = unattended.map(job => `${job.id}${job.label ? ` (${job.label})` : ""}`).join(", ");
    const disposition = unattended.length ? `Background jobs still require a disposition: ${summary}. Before ending, use bg_tasks to cancel them (id or all=true), ignore them (permanently disables notifications), or wait with waitFor=next/all. Do not merely acknowledge and end while an attended job is still running.` : "";
    if (!packets.length && !disposition) return;
    const observation = message(packets, remaining, disposition);
    // Modern fork: append at the persisted boundary; an already-required tool
    // follow-up satisfies continue. No separate follow-up queue entry per job.
    const boundary = event as typeof event & { entries?: unknown[] };
    if (Array.isArray(boundary.entries)) return { entries: [...boundary.entries, { type: "custom_message", ...observation }], continue: true };
    // Stock Pi compatibility: one steering message at the completed tool boundary.
    pi.sendMessage(observation, { deliverAs: "steer", triggerTurn: true });
  });

  pi.registerTool({
    name: "bg_tasks", label: "Background tasks",
    description: "Start, inspect, wait for, ignore completion notifications from, or cancel finite Linux commands owned by this Pi session runtime.\n\n" + actionHelp + "\n\nwait waitFor=next/all observes jobs active at call time. ignore leaves work running and permanently sets notify=off. start notify=errors suppresses clean exit-0 completions; notify=off suppresses every completion wake while retaining status/output. Completions are coalesced at model boundaries or a short idle debounce and include bounded output tails; wait also returns already-queued completions. An attended running job must be cancelled, ignored, or waited for before ending a turn. Jobs stop on reload, branch/session replacement, and graceful exit; they do not survive a crash. No services, interactive stdin, schedules, remote execution, or automatic retries.",
    promptSnippet: "Run a finite local command in the background and inspect it with bounded output cursors.",
    promptGuidelines: ["Use bg_tasks only for authorized finite work. Start independent long jobs together, continue useful work, then wait when blocked instead of polling. Inspect completion evidence before dependent operations; fetch output when its bounded tail is insufficient. Completion is not permission for more work."],
    parameters: ToolSchema, executionMode: "sequential",
    async execute(_call, raw, signal, _update, ctx) {
      const params = raw as Params;
      const jobs = getRuntime(ctx);
      switch (params.action) {
        case "start": {
          if (ctx.mode === "print" || ctx.mode === "json") throw new Error("bg_tasks start is unavailable in print and JSON mode.");
          requireOnly(params, "start", ["command", "cwd", "label", "timeoutSeconds", "notify"]);
          if (!params.command) throw new Error(`command is required for bg_tasks start. For start, ${actionUsage.start}.`);
          const job = await jobs.start({ command: params.command, cwd: params.cwd ?? ctx.cwd, label: params.label, timeoutSeconds: params.timeoutSeconds, notify: params.notify }, signal);
          return { content: [{ type: "text", text: `Started background job.\n${formatJob(job)}` }], details: { job } };
        }
        case "list": requireOnly(params, "list", []); return { content: [{ type: "text", text: jobs.list().map(formatJob).join("\n") || "No background jobs in this runtime." }], details: { jobs: jobs.list() } };
        case "status": { requireOnly(params, "status", ["id"]); const job = jobs.status(requireId(params)); return { content: [{ type: "text", text: formatStatus(job) }], details: { job } }; }
        case "output": { requireOnly(params, "output", ["id", "cursor", "limit", "tail"]); const output = await jobs.output(requireId(params), params.cursor, params.limit, params.tail); return { content: [{ type: "text", text: output.text || "(no retained output)" }], details: output }; }
        case "cancel": {
          requireOnly(params, "cancel", ["id", "all"]); const ids = selectedRunning(jobs, params);
          const cancelled = await Promise.all(ids.map(id => jobs.cancel(id)));
          completions.acknowledge(ids);
          return { content: [{ type: "text", text: cancelled.map(formatJob).join("\n") || "No running background jobs." }], details: { jobs: cancelled } };
        }
        case "ignore": {
          requireOnly(params, "ignore", ["id", "all"]); const ids = selectedRunning(jobs, params);
          completions.acknowledge(ids);
          const ignored = await jobs.ignore(ids);
          return { content: [{ type: "text", text: ignored.map(formatJob).join("\n") || "No running background jobs; nothing to ignore." }], details: { jobs: ignored } };
        }
        case "wait": {
          requireOnly(params, "wait", ["waitFor", "seconds"]);
          if (!params.waitFor) throw new Error(`waitFor is required for bg_tasks wait. For wait, ${actionUsage.wait}.`);
          // Also return eligible completions already queued when wait began.
          // Interrupted waits leave their observations queued, rather than losing them.
          const queued = completions.records();
          const result = await jobs.wait(params.waitFor, params.seconds, signal);
          const completed = [...new Map([...result.completed, ...queued].map(job => [job.id, job])).values()].slice(0, COMPLETION_BATCH_SIZE);
          const packets = await Promise.all(completed.map(job => completionPacket(jobs, job)));
          signal?.throwIfAborted();
          completions.acknowledge(completed.map(job => job.id));
          const lines = [`Wait ${result.reason} (${result.waitFor}); completed=${completed.length}; still running=${result.running.length}.`, formatCompletions(packets, completions.size), ...result.running.map(formatJob)];
          return { content: [{ type: "text", text: lines.filter(Boolean).join("\n") }], details: { ...result, completed, completions: packets } };
        }
      }
    },
  });

  pi.registerCommand("bg-tasks", {
    description: "Inspect session-bound background jobs: /bg-tasks [list|status ID|output ID|cancel ID]",
    handler: async (args, ctx) => {
      const [action = "list", id] = args.trim().split(/\s+/, 2);
      const jobs = getRuntime(ctx);
      try {
        let text: string;
        if (action === "list" && !id) text = jobs.list().map(formatJob).join("\n") || "No background jobs in this runtime.";
        else if (action === "status" && id) text = formatStatus(jobs.status(id));
        else if (action === "output" && id) text = (await jobs.output(id)).text || "(no retained output)";
        else if (action === "cancel" && id) text = formatJob(await jobs.cancel(id));
        else text = "Usage: /bg-tasks [list|status ID|output ID|cancel ID]";
        if (ctx.hasUI) ctx.ui.notify(text, "info");
      } catch (error) { if (ctx.hasUI) ctx.ui.notify(String(error), "error"); }
    },
  });
}
