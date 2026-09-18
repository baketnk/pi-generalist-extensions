import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { BackgroundJobRuntime, shouldNotifyCompletion, type JobNotify, type JobRecord, type StopReason, type WaitFor } from "../lib/bg-tasks/runtime.ts";

const Actions = ["start", "list", "status", "output", "cancel", "ignore", "wait"] as const;
type Action = (typeof Actions)[number];
const ToolSchema = Type.Object({
  action: StringEnum(Actions), command: Type.Optional(Type.String({ maxLength: 16_384 })), cwd: Type.Optional(Type.String({ maxLength: 4_096 })),
  label: Type.Optional(Type.String({ maxLength: 200 })), timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 14_400 })),
  notify: Type.Optional(StringEnum(["always", "errors", "off"] as const, { description: "Completion wake policy: always (default), errors (quiet on clean exit 0), or off (never wake; result remains inspectable)." })),
  id: Type.Optional(Type.String({ maxLength: 128 })), cursor: Type.Optional(Type.String({ maxLength: 256 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 * 1024 })), tail: Type.Optional(Type.Boolean()),
  all: Type.Optional(Type.Boolean({ description: "Apply cancel or ignore to every currently running job." })),
  waitFor: Type.Optional(StringEnum(["next", "all"] as const, { description: "Wait for the next currently running job to settle, or for all jobs running at call time." })),
  seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })),
  reason: Type.Optional(StringEnum(["user_cancel"] as const)),
}, { additionalProperties: false });
type Params = { action: Action; command?: string; cwd?: string; label?: string; timeoutSeconds?: number; notify?: JobNotify; id?: string; cursor?: string; limit?: number; tail?: boolean; all?: boolean; waitFor?: WaitFor; seconds?: number; reason?: "user_cancel" };

function requireOnly(params: Params, action: Action, allowed: readonly (keyof Params)[]): void {
  for (const [key, value] of Object.entries(params)) if (key !== "action" && value !== undefined && !allowed.includes(key as keyof Params)) throw new Error(`${key} is not valid for bg_tasks ${action}.`);
}
function requireId(params: Params): string { if (!params.id) throw new Error("id is required for this action."); return params.id; }
function running(jobs: BackgroundJobRuntime): JobRecord[] { return jobs.list().filter(job => job.execution === "starting" || job.execution === "running"); }
function selectedRunning(jobs: BackgroundJobRuntime, params: Params): string[] {
  if (!!params.id === (params.all === true)) throw new Error("Specify exactly one of id or all=true.");
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
  const observedByWait = new Set<string>();
  const createRuntime = (ctx: ExtensionContext) => {
    generation++;
    const current = generation;
    const session = ctx.sessionManager.getSessionId?.() ?? "ephemeral";
    runtime = new BackgroundJobRuntime(`${getAgentDir()}/bg-tasks`, `${session}/${current}`, job => {
      if (current !== generation) return;
      pi.appendEntry("generalist:bg-tasks:result-v1", { id: job.id, execution: job.execution, exitCode: job.exitCode, signal: job.signal, cleanup: job.cleanup, receipt: job.receipt, persistenceError: job.persistenceError });
      if (job.stopReason === "session_shutdown" || observedByWait.has(job.id) || !shouldNotifyCompletion(job)) return;
      pi.sendMessage({ customType: "generalist:bg-tasks:completion-v1", content: `Background job completed: ${formatJob(job)}. Use bg_tasks status or output with its ID for details.`, display: true, details: { id: job.id } }, { deliverAs: "followUp", triggerTurn: true });
    });
  };
  const getRuntime = (ctx: ExtensionContext) => runtime ?? (createRuntime(ctx), runtime!);

  pi.on("session_start", (_event, ctx) => createRuntime(ctx));
  pi.on("session_shutdown", async (_event, _ctx) => { generation++; observedByWait.clear(); const old = runtime; runtime = undefined; await old?.shutdown(); });
  pi.on("turn_end", event => {
    if (event.message.role !== "assistant" || event.message.stopReason !== "stop" || !runtime) return;
    const unattended = running(runtime).filter(job => job.notify !== "off");
    if (!unattended.length) return;
    const summary = unattended.map(job => `${job.id}${job.label ? ` (${job.label})` : ""}`).join(", ");
    pi.sendMessage({
      customType: "generalist:bg-tasks:turn-end-v1",
      content: `You are trying to end the turn while background jobs still require a disposition: ${summary}. Before ending, use bg_tasks to do one of: cancel them (id or all=true); ignore them (id or all=true), which leaves them running but permanently sets notifications off regardless of outcome; or wait with waitFor=next/all. Do not merely acknowledge this message and end while an attended job is still running.`,
      display: true,
      details: { ids: unattended.map(job => job.id) },
    }, { deliverAs: "followUp", triggerTurn: true });
  });

  pi.registerTool({
    name: "bg_tasks", label: "Background tasks",
    description: "Start, inspect, wait for, ignore completion notifications from, or cancel finite Linux commands owned by this Pi session runtime. wait waitFor=next/all observes jobs active at call time. ignore leaves work running and permanently sets notify=off. start notify=errors suppresses clean exit-0 completions; notify=off suppresses every completion wake while retaining status/output. An attended running job must be cancelled, ignored, or waited for before ending a turn. Jobs stop on reload, session replacement, and graceful exit; they do not survive a crash. No services, interactive stdin, schedules, remote execution, or automatic retries.",
    promptSnippet: "Run a finite local command in the background and inspect it with bounded output cursors.",
    promptGuidelines: ["Use bg_tasks only for finite local work the user has authorized. Inspect status/output before interpreting completion, and do not treat completion as permission to start more work."],
    parameters: ToolSchema, executionMode: "sequential",
    async execute(_call, raw, signal, _update, ctx) {
      const params = raw as Params;
      const jobs = getRuntime(ctx);
      switch (params.action) {
        case "start": {
          if (ctx.mode === "print" || ctx.mode === "json") throw new Error("bg_tasks start is unavailable in print and JSON mode.");
          requireOnly(params, "start", ["command", "cwd", "label", "timeoutSeconds", "notify"]);
          if (!params.command) throw new Error("command is required for bg_tasks start.");
          const job = await jobs.start({ command: params.command, cwd: params.cwd ?? ctx.cwd, label: params.label, timeoutSeconds: params.timeoutSeconds, notify: params.notify }, signal);
          return { content: [{ type: "text", text: `Started background job.\n${formatJob(job)}` }], details: { job } };
        }
        case "list": requireOnly(params, "list", []); return { content: [{ type: "text", text: jobs.list().map(formatJob).join("\n") || "No background jobs in this runtime." }], details: { jobs: jobs.list() } };
        case "status": { requireOnly(params, "status", ["id"]); const job = jobs.status(requireId(params)); return { content: [{ type: "text", text: formatStatus(job) }], details: { job } }; }
        case "output": { requireOnly(params, "output", ["id", "cursor", "limit", "tail"]); const output = await jobs.output(requireId(params), params.cursor, params.limit, params.tail); return { content: [{ type: "text", text: output.text || "(no retained output)" }], details: output }; }
        case "cancel": {
          requireOnly(params, "cancel", ["id", "all", "reason"]); const ids = selectedRunning(jobs, params);
          ids.forEach(id => observedByWait.add(id));
          try {
            const cancelled = await Promise.all(ids.map(id => jobs.cancel(id, "user_cancel" as StopReason)));
            return { content: [{ type: "text", text: cancelled.map(formatJob).join("\n") || "No running background jobs." }], details: { jobs: cancelled } };
          } finally { ids.forEach(id => observedByWait.delete(id)); }
        }
        case "ignore": {
          requireOnly(params, "ignore", ["id", "all"]); const ids = selectedRunning(jobs, params); const ignored = await jobs.ignore(ids);
          return { content: [{ type: "text", text: ignored.map(formatJob).join("\n") || "No running background jobs; nothing to ignore." }], details: { jobs: ignored } };
        }
        case "wait": {
          requireOnly(params, "wait", ["waitFor", "seconds"]);
          if (!params.waitFor) throw new Error("waitFor is required for bg_tasks wait.");
          const ids = running(jobs).map(job => job.id); ids.forEach(id => observedByWait.add(id));
          try {
            const result = await jobs.wait(params.waitFor, params.seconds, signal);
            const lines = [`Wait ${result.reason} (${result.waitFor}); completed=${result.completed.length}; still running=${result.running.length}.`, ...result.completed.map(formatJob), ...result.running.map(formatJob)];
            return { content: [{ type: "text", text: lines.join("\n") }], details: result };
          } finally { ids.forEach(id => observedByWait.delete(id)); }
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
