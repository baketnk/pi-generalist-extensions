import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";
import { LIMITS, type RunRecord } from "./types.ts";

const object = (properties: Record<string, TSchema>) => Type.Object(properties, { additionalProperties: false });
const identifier = (description: string) => Type.String({ minLength: 1, maxLength: 64, description });
const runId = identifier("Owned run ID returned by subagent_start, subagent_fork or subagent_list.");
const launch = {
  launchKey: Type.String({ minLength: 1, maxLength: 128, pattern: "\\S", description: "Unique key for this launch intent. Reuse the same key only for an identical launch; changed intent is rejected. Never change the key merely to retry an uncertain launch." }),
  task: Type.String({ minLength: 1, maxLength: LIMITS.taskBytes, pattern: "\\S", description: "Self-contained assignment, constraints, expected output, and disjoint file ownership for implementation work. Maximum 32 KiB UTF-8." }),
  label: Type.String({ minLength: 1, maxLength: 160, pattern: "\\S", description: "Human-readable worker label. Subsequent calls use the returned runId, not this label." }),
  permissions: Type.Optional(StringEnum(["read-only", "implement"] as const, { description: "Default read-only: scoped read/list/search, no shell. implement grants unsandboxed shell/edit/write in the shared checkout; no rollback." })),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Omit to obey a human model lock or otherwise use self. self, next-smaller, or exact provider/model. No fallback or skipped rung; subagent_models shows policy." })),
  roots: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 4, description: "Extra absolute directories for read-only workers only; requires interactive human confirmation. Private paths remain denied." })),
  runTimeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMITS.secondsMax, description: "Worker wall-clock deadline including clarification, default 600 seconds. Does not set the parent's wait duration." })),
};
const recipe = "Start independent work → do useful parent work → subagent_wait → subagent_answer if blocked → subagent_collect → verify findings and actual changes. ";
const launchHelp = "Choose zero, one or several workers; concurrency ceilings are not staffing targets. Start returns immediately. Assign disjoint files. Neither permission profile can recursively delegate or use personal memory/history. Workers stop on reload/session replacement/global stop; no idle-parent completion wake. Launch keys deduplicate identical intents; inspect subagent_list after an uncertain launch, never blindly relaunch. Default budget is 24 work turns/80 tool calls plus one report-only synthesis on exhaustion; human settings control budgets. No automatic model fallback, compaction or retries. Results suggest nextCalls, not new assignments; when requiredInput is present, supply those argument values before calling. An empty nextCalls list needs no follow-up.";
export const subagentTools = [
  { name: "subagent_start", action: "start", parameters: object(launch), description: recipe + "Launch a fresh worker with only the assignment and repository instructions. " + launchHelp },
  { name: "subagent_fork", action: "start", parameters: object({ ...launch, checkpointId: identifier("Exact checkpoint anchor returned by subagent_checkpoints. Required; no implicit latest checkpoint.") }), description: "Launch from an explicit captured parent-history checkpoint. Requires human history-sharing consent independently of tool permissions; history can contain private context. Lifecycle, launch-key deduplication, budgets and verification rules are the same as subagent_start. Never silently substitute a fresh launch." },
  { name: "subagent_list", action: "list", parameters: object({}), description: "Find owned run IDs and current states. Inspect without launching work or collecting reports. Returns the latest 16 records and total count." },
  { name: "subagent_models", action: "models", parameters: object({}), description: "Inspect the human model lock, exact configured ladder, and parent-side model availability. Does not change policy or launch work." },
  { name: "subagent_checkpoints", action: "checkpoints", parameters: object({}), description: "List captured parent-history checkpoints. Use an exact returned anchor as checkpointId for subagent_fork; never invent an anchor." },
  { name: "subagent_status", action: "status", parameters: object({ runId }), description: "Inspect an owned worker's task, process, cleanup, report, and clarification state. Use subagent_wait when blocked instead of polling." },
  { name: "subagent_peek", action: "peek", parameters: object({ runId, after: Type.Optional(Type.Integer({ minimum: 0, description: "Public-event cursor, default 0. Use the previous result's next cursor to continue." })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Maximum public events, default 40; output is also byte-bounded." })) }), description: "Read bounded worker events without inference or collection. Follow the returned cursor for additional events." },
  { name: "subagent_wait", action: "join", parameters: object({ runIds: Type.Array(runId, { minItems: 1, maxItems: 16, uniqueItems: true, description: "Explicit nonempty selection of owned run IDs. No implicit selection of recent workers." }), waitMode: StringEnum(["any", "all"] as const, { description: "Wait for any or all selected tasks to finish. Both modes yield for clarification, failure, user input, or timeout." }), waitTimeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 300, description: "Bounded parent wait, default 60 seconds. Does not change worker deadlines." })) }), description: "Wait on selected workers without collecting reports. A timeout means work may still be running; use returned states and nextCalls." },
  { name: "subagent_answer", action: "input", parameters: object({ runId, questionId: identifier("Exact pending clarification ID returned by status/wait. Not the question text or run ID."), text: Type.String({ minLength: 1, maxLength: LIMITS.taskBytes, description: "Answer to the pending clarification, maximum 32 KiB UTF-8. Not a new assignment or permission grant." }) }), description: "Answer a worker's pending clarification. Use the returned questionId; subagent_guide is for unsolicited advice instead." },
  { name: "subagent_guide", action: "guide", parameters: object({ runId, text: Type.String({ minLength: 1, maxLength: LIMITS.guidanceBytes, description: "Parent advice, maximum 4 KiB UTF-8, at most eight per run. Grants no new permissions, ownership, scope or budget." }) }), description: "Send advice to a running worker at its next model boundary. Use subagent_answer for a pending clarification. Inspect events for delivered/dropped acknowledgement." },
  { name: "subagent_collect", action: "collect", parameters: object({ runId }), description: "Collect a finished worker's report, including partial findings on failure/exhaustion. Reports are unverified claims; review actual diffs and checks. Collection neither merges transcripts nor proves process cleanup." },
  { name: "subagent_cancel", action: "cancel", parameters: object({ runId }), description: "Request shutdown of one explicit owned worker. Does not roll back edits. Task termination and observed process cleanup are separate; inspect returned state." },
] as const;

// Internal runtime vocabulary is deliberately not exposed as one provider schema.
export interface SubagentParams {
  action: string; mode?: "fresh" | "fork"; task?: string; label?: string; permissions?: "read-only" | "implement";
  model?: string; roots?: string[]; operation?: string; from?: string; seconds?: number; id?: string; ids?: string[];
  all?: boolean; after?: number; limit?: number; question?: string; text?: string;
}
export function runtimeParams(name: string, action: string, raw: Record<string, any>): SubagentParams {
  const { launchKey, checkpointId, runTimeoutSeconds, runId, runIds, waitMode, waitTimeoutSeconds, questionId, ...rest } = raw;
  return { ...rest, action, ...(action === "start" ? { mode: name === "subagent_fork" ? "fork" : "fresh", operation: launchKey, from: checkpointId, seconds: runTimeoutSeconds } : {}),
    ...(runId ? { id: runId } : {}), ...(action === "join" ? { ids: runIds, all: waitMode === "all", seconds: waitTimeoutSeconds } : {}), ...(questionId ? { question: questionId } : {}) };
}
export interface NextCall { tool: string; arguments: Record<string, unknown>; requiredInput?: Record<string, string> }
export function nextForRun(record: RunRecord): NextCall[] {
  if (record.taskState === "needs-input" && record.question) return [{ tool: "subagent_answer", arguments: { runId: record.id, questionId: record.question.id }, requiredInput: { text: record.question.text } }]; // The parent supplies the answer; never fabricate executable answer prose.
  if (["starting", "running", "needs-input"].includes(record.taskState)) return [{ tool: "subagent_wait", arguments: { runIds: [record.id], waitMode: "all", waitTimeoutSeconds: 60 } }];
  if (!record.collectedAt) return [{ tool: "subagent_collect", arguments: { runId: record.id } }];
  return [];
}
export function subagentFailure(error: unknown, effect: string, params: SubagentParams, records: RunRecord[]) {
  const message = String(error instanceof Error ? error.message : error).slice(0, 1800);
  let code = "operation_failed", repair = "Inspect the current state before another operation. Do not repeat this call unchanged.";
  let nextCalls: NextCall[] = params.action === "list" ? [] : [{ tool: "subagent_list", arguments: {} }];
  if (/runtime unavailable|Session changed|session.*changed|launch invalidated/i.test(message)) { code = "runtime_unavailable"; repair = "Stop using this runtime. Wait for session initialization or ask the user to restore the session; do not retry in a loop."; nextCalls = []; }
  else if (/Unknown owned run/.test(message)) { code = "unknown_run"; repair = "Use a runId returned by subagent_list, not a label, launchKey or checkpointId."; }
  else if (/different intent/.test(message)) { code = "launch_key_conflict"; repair = "Inspect the original launch. Reuse its key only with identical intent; a new key is for a separately intended launch, not an error bypass."; }
  else if (/ceiling .* reached/.test(message)) { code = "capacity_reached"; repair = "Wait for existing workers before deciding whether another launch is needed."; const ids = records.filter(r => ["starting", "running", "needs-input"].includes(r.taskState)).map(r => r.id); if (ids.length) nextCalls = [{ tool: "subagent_wait", arguments: { runIds: ids, waitMode: "any" } }]; }
  else if (/human-locked|no fallback|model ladder|smallest|not in.*ladder|no model/i.test(message)) { code = "model_policy"; repair = "Inspect subagent_models. Obey the human lock; do not change models to bypass a failed launch."; nextCalls = [{ tool: "subagent_models", arguments: {} }]; }
  else if (/not authorized|confirmation|permissions|read roots/i.test(message)) { code = "permission_required"; repair = "Stop this launch until the required human permission is available. Do not broaden permissions to bypass the failure."; nextCalls = []; }
  else if (/checkpoint|snapshot|fork sharing/i.test(message)) { code = "checkpoint_unavailable"; repair = "Inspect captured checkpoints. Fork requires a valid explicit checkpoint and history-sharing grant; do not silently substitute fresh work."; nextCalls = [{ tool: "subagent_checkpoints", arguments: {} }]; }
  else if (/not finished|clarification|Guidance requires|Guidance limit/i.test(message)) { code = "invalid_state"; repair = "Inspect the worker's current state and pending question before choosing another operation."; if (params.id) nextCalls = [{ tool: "subagent_status", arguments: { runId: params.id } }]; }
  return new Error(JSON.stringify({ code, message, effect, retryUnchanged: false, repair, nextCalls }));
}
