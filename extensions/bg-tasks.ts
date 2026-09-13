import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { BackgroundJobRuntime, shouldNotifyCompletion, type JobNotify, type JobRecord, type StopReason } from "../lib/bg-tasks/runtime.ts";

const Actions = ["start", "list", "status", "output", "cancel"] as const;
type Action = (typeof Actions)[number];
const ToolSchema = Type.Object({
  action: StringEnum(Actions), command: Type.Optional(Type.String({ maxLength: 16_384 })), cwd: Type.Optional(Type.String({ maxLength: 4_096 })),
  label: Type.Optional(Type.String({ maxLength: 200 })), timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 14_400 })),
  notify: Type.Optional(StringEnum(["always", "errors", "off"] as const, { description: "Completion wake policy: always (default), errors (quiet on clean exit 0), or off (never wake; result remains inspectable)." })),
  id: Type.Optional(Type.String({ maxLength: 128 })), cursor: Type.Optional(Type.String({ maxLength: 256 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 * 1024 })), tail: Type.Optional(Type.Boolean()),
  reason: Type.Optional(StringEnum(["user_cancel"] as const)),
}, { additionalProperties: false });
type Params = { action: Action; command?: string; cwd?: string; label?: string; timeoutSeconds?: number; notify?: JobNotify; id?: string; cursor?: string; limit?: number; tail?: boolean; reason?: "user_cancel" };

function requireOnly(params: Params, action: Action, allowed: readonly (keyof Params)[]): void {
  for (const [key, value] of Object.entries(params)) if (key !== "action" && value !== undefined && !allowed.includes(key as keyof Params)) throw new Error(`${key} is not valid for bg_tasks ${action}.`);
}
function requireId(params: Params): string { if (!params.id) throw new Error("id is required for this action."); return params.id; }
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
  const createRuntime = (ctx: ExtensionContext) => {
    generation++;
    const current = generation;
    const session = ctx.sessionManager.getSessionId?.() ?? "ephemeral";
    runtime = new BackgroundJobRuntime(`${getAgentDir()}/bg-tasks`, `${session}/${current}`, job => {
      if (current !== generation) return;
      pi.appendEntry("generalist:bg-tasks:result-v1", { id: job.id, execution: job.execution, exitCode: job.exitCode, signal: job.signal, cleanup: job.cleanup, receipt: job.receipt, persistenceError: job.persistenceError });
      if (job.stopReason === "session_shutdown" || !shouldNotifyCompletion(job)) return;
      pi.sendMessage({ customType: "generalist:bg-tasks:completion-v1", content: `Background job completed: ${formatJob(job)}. Use bg_tasks status or output with its ID for details.`, display: true, details: { id: job.id } }, { deliverAs: "followUp", triggerTurn: true });
    });
  };
  const getRuntime = (ctx: ExtensionContext) => runtime ?? (createRuntime(ctx), runtime!);

  pi.on("session_start", (_event, ctx) => createRuntime(ctx));
  pi.on("session_shutdown", async (_event, _ctx) => { generation++; const old = runtime; runtime = undefined; await old?.shutdown(); });

  pi.registerTool({
    name: "bg_tasks", label: "Background tasks",
    description: "Start, inspect, read bounded incremental output from, or cancel finite Linux commands owned by this Pi session runtime. start notify=errors suppresses clean exit-0 completions; notify=off suppresses every completion wake while retaining status/output. Jobs stop on reload, session replacement, and graceful exit; they do not survive a crash. No services, interactive stdin, schedules, remote execution, or automatic retries.",
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
        case "cancel": { requireOnly(params, "cancel", ["id", "reason"]); const job = await jobs.cancel(requireId(params), "user_cancel" as StopReason); return { content: [{ type: "text", text: formatJob(job) }], details: { job } }; }
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
