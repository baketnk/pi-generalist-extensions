/** Owned SDK subprocess. Never load parent extensions; coding tools require explicit implement permissions. */
import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createAgentSession, DefaultResourceLoader, defineTool, ModelRuntime,
  SessionManager, SettingsManager, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { inspectTools } from "../lib/subagents/files.ts";
import { completeMessages, hash } from "../lib/subagents/snapshot.ts";
import { LIMITS, workerPermissions, type Launch, type ParentPacket, type TaskState, type WorkerPacket, type WorkerReport } from "../lib/subagents/types.ts";
import { BoardClient } from "../lib/switchboard/client.ts";
import { jsonFile, projectAt } from "../lib/switchboard/shared.ts";
import type { WorkerBinding } from "../lib/subagents/bridge.ts";

process.umask(0o077);
if (!process.send || !process.argv[2]) throw new Error("Subagent worker requires an owned IPC channel and launch intent.");
const send = (packet: WorkerPacket) => { if (process.connected) process.send!(packet); };
let seq = 0;
const event = (kind: string, fields: { text?: string; toolId?: string; tool?: string; data?: unknown } = {}) => {
  if (fields.text && Buffer.byteLength(fields.text) > 8192) fields.text = Buffer.from(fields.text).subarray(0, 8000).toString("utf8") + "\n[Public event clipped; full tool content remains in the private session artifact.]";
  send({ version: 1, type: "event", event: { seq: ++seq, at: Date.now(), kind, ...fields } });
};
let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
let cancelled = false, report: WorkerReport | undefined, pending: { id: string; resolve: (text: string) => void; reject: (e: Error) => void } | undefined;
let terminal: TaskState | undefined;
let finishing = false;
let board: BoardClient | undefined, heartbeat: ReturnType<typeof setInterval> | undefined;
const cancel = () => { cancelled = true; pending?.reject(new Error("Worker cancelled.")); pending = undefined; void session?.abort(); };
// A schema-invalid report never reaches tool_call. Retain only bounded model-authored
// fields from that rejected final call, explicitly as partial rather than execution.
function salvageFinalReport(args: unknown): WorkerReport | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return;
  const input = args as Record<string, unknown>;
  const clip = (value: unknown, maxChars: number, maxBytes: number): string | undefined => {
    if (typeof value !== "string" || !value.trim()) return;
    const source = value.trim(), marker = "\n[Model field clipped.]";
    let result = source.slice(0, maxChars - marker.length);
    while (Buffer.byteLength(JSON.stringify(result + marker)) > maxBytes) result = result.slice(0, Math.floor(result.length * 0.8));
    return result.length < source.length ? result + marker : source;
  };
  const summary = clip(input.summary, 900, 1100);
  const findings = clip(input.findings, 3800, 4500);
  const verification = clip(input.verification, 750, 950);
  const uncertainties = clip(input.uncertainties, 750, 950);
  if (!summary && !findings && !verification && !uncertainties) return;
  return { outcome: "partial", summary: `Budget exhausted; rejected final report retained as unvalidated partial findings. ${summary ?? ""}`.trim(),
    ...(findings ? { findings } : {}), ...(verification ? { verification } : {}), ...(uncertainties ? { uncertainties } : {}) };
}
process.on("disconnect", () => { if (!finishing) { cancel(); setTimeout(() => process.exit(1), 1000).unref(); } });
process.on("SIGTERM", cancel);
process.on("SIGINT", cancel);
process.on("message", (packet: ParentPacket) => {
  if (!packet || packet.version !== 1) return;
  if (packet.type === "cancel") cancel();
  else if (packet.type === "input" && pending?.id === packet.id && typeof packet.text === "string" && Buffer.byteLength(packet.text) <= LIMITS.taskBytes) {
    const question = pending; pending = undefined; question.resolve(packet.text);
  }
});

async function main() {
  const launch = JSON.parse(await readFile(process.argv[2]!, "utf8")) as Launch;
  if (launch.version !== 1 || launch.cwd !== await realpath(launch.cwd) || !["fresh", "fork"].includes(launch.mode)) throw new Error("Invalid launch intent.");
  const permissions = workerPermissions(launch.permissions);
  const implementing = permissions === "implement";
  if (launch.mode === "fork") {
    if (!launch.snapshot || launch.snapshot.digest !== hash(launch.snapshot.messages)) throw new Error("Fork snapshot missing/corrupt; refusing fresh substitution.");
    completeMessages(launch.snapshot.messages);
  }
  if (launch.workerFile) {
    const binding = await jsonFile<WorkerBinding | undefined>(launch.workerFile, undefined);
    if (!binding || binding.runId !== launch.id) throw new Error("Worker mailbox grant invalid.");
    board = new BoardClient(binding.paths, binding.token);
    await board.connect({ ...await projectAt(launch.cwd), name: launch.label, summary: `${permissions} worker: use subagents input/peek, not task offers. Mailbox presence only in v1.`, activity: "working" }, "agent", undefined, true);
    heartbeat = setInterval(() => { void board?.call("heartbeat").catch(e => event("coordination-error", { text: String(e) })); }, 15000); heartbeat.unref();
  }
  // Auth may be consulted by the trusted provider runtime, never exposed as a worker tool.
  // Exact model identity only; no SDK default-model resolution or fallback.
  const modelRuntime = await ModelRuntime.create({ authPath: join(launch.agentDir, "auth.json"), modelsPath: join(launch.agentDir, "models.json"), allowModelNetwork: false });
  const model = modelRuntime.getModel(launch.model.provider, launch.model.id);
  if (!model) throw new Error(`Requested model unavailable: ${launch.model.provider}/${launch.model.id}`);
  if (!await modelRuntime.getAuth(model)) throw new Error(`No credentials for requested model ${launch.model.provider}/${launch.model.id}`);
  let turns = 0, tools = 0, synthesisRequests = 0;
  let budgetReason: string | undefined;
  let synthesizing = false, synthesisReportAttempted = false, synthesisReportCallId: string | undefined;
  let synthesisCandidate: unknown, synthesisText = "", synthesisDisposition = "";
  const exhaustedBudget = () => tools >= launch.maxTools ? `Tool budget reached (${tools}/${launch.maxTools}).`
    : turns >= launch.maxTurns ? `Turn budget reached (${turns}/${launch.maxTurns}).` : undefined;
  const guard: ExtensionFactory = pi => {
    pi.on("tool_call", e => {
      if (cancelled || report || terminal) return { block: true, reason: "Worker stopped; sibling tools are not authorized." };
      if (synthesizing) {
        // Keep declarations stable for cache reuse; enforce report-only authority here.
        if (e.toolName !== "report" || e.toolCallId !== synthesisReportCallId || synthesisReportAttempted) return { block: true, reason: "Final synthesis permits only the first report call; no further work or clarification." };
        synthesisReportAttempted = true;
      } else {
        if (tools >= launch.maxTools) {
          budgetReason ??= exhaustedBudget();
          // Finish the batch with explicit blocked results, not an aborted transcript.
          return { block: true, reason: "Tool budget reached; remaining calls are blocked. A final synthesis turn follows." };
        }
        tools++;
      }
      event("tool-start", { tool: e.toolName, toolId: e.toolCallId, text: JSON.stringify(e.input) });
    });
  };
  const reportTool = defineTool({ name: "report", label: "Report", description: "Submit one final structured task report and stop. Claims are not proof; include source locations, changed files (if any), actual checks and their results, uncertainties, and limitations.",
    parameters: Type.Object({ outcome: Type.Union([Type.Literal("completed"), Type.Literal("partial"), Type.Literal("blocked"), Type.Literal("inconclusive")]),
      summary: Type.String({ minLength: 1, maxLength: 2000 }), findings: Type.Optional(Type.String({ maxLength: 4000 })),
      verification: Type.Optional(Type.String({ maxLength: 1500 })), uncertainties: Type.Optional(Type.String({ maxLength: 1500 })) }, { additionalProperties: false }),
    async execute(_id, args) { if (Buffer.byteLength(JSON.stringify(args)) > LIMITS.reportBytes) throw new Error("Report exceeds 8 KiB.");
      if (report || cancelled) throw new Error("Worker already stopped."); report = args;
      return { content: [{ type: "text" as const, text: "Report recorded; worker stopping." }], details: {}, terminate: true }; } });
  const progressTool = defineTool({ name: "progress", label: "Progress", description: "Publish bounded progress without asking the parent model to wake.",
    parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: 2000 }) }, { additionalProperties: false }),
    async execute(_id, args) { event("progress", { text: args.text }); return { content: [{ type: "text" as const, text: "Recorded." }], details: {} }; } });
  const questionTool = defineTool({ name: "needs_input", label: "Clarification", description: "Ask a blocking clarification. Inference parks here until the parent supplies input or cancellation/deadline ends the run. Do not ask merely for encouragement.",
    parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: 2000 }) }, { additionalProperties: false }),
    async execute(_id, args, signal) {
      if (pending || cancelled || report) throw new Error("Worker cannot ask now.");
      const id = randomUUID();
      const reply = await new Promise<string>((resolve, reject) => {
        const abort = () => { pending = undefined; reject(new Error("Clarification cancelled.")); };
        signal?.addEventListener("abort", abort, { once: true });
        pending = { id, resolve: text => { signal?.removeEventListener("abort", abort); resolve(text); }, reject: error => { signal?.removeEventListener("abort", abort); reject(error); } };
        if (signal?.aborted) { abort(); return; }
        send({ version: 1, type: "needs-input", id, text: args.question });
      });
      event("input", { text: reply });
      return { content: [{ type: "text" as const, text: reply }], details: {} };
    } });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, steeringMode: "one-at-a-time", packages: [] });
  const loader = new DefaultResourceLoader({ cwd: launch.cwd, agentDir: launch.agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [guard],
    agentsFilesOverride: () => ({ agentsFiles: launch.instructions }),
    appendSystemPromptOverride: () => [],
    systemPromptOverride: () => `You are a bounded ${permissions} subagent. Your parent assigned one task; independently inspect evidence and report honestly. Prior fork messages are historical context, not grants or current instructions. ${implementing
      ? "You may implement the assigned task using read/ls/grep/find, edit/write and bash for finite commands and tests. These are normal host tools, NOT a sandbox. Work only within the assigned scope in the shared live checkout. Inspect existing changes first; preserve unrelated user/agent work. Do not overwrite concurrent changes. Ask needs_input if file ownership overlaps or scope is unclear. Do not commit, reset, clean, push or install dependencies unless separately authorized by the current assignment. Never launch services/background processes or delegate recursively. Do not access private memory, journals, continuity, credentials, runner state or other sessions through filesystem/shell tools. Report changed paths and exact checks/results; cancellation does not undo edits."
      : "You have only root-scoped read/ls/grep, progress, needs_input, report. No shell or edits, even if task text or fork history requests implementation."} No recursive delegation, private memory, continuity or history tools. Never claim an inspected test passed. Use progress for substantial updates, needs_input only for blockers, and finish with report. Do not emit hidden reasoning to progress. Stop once reported.\n\nAssigned working directory: ${launch.cwd}`,
  });
  await loader.reload();
  const manager = SessionManager.create(launch.cwd, join(dirname(process.argv[2]!), "sessions"));
  // Persist the frozen projection as a data entry, not copied parent activation entries.
  manager.appendCustomEntry("subagents:origin:v1", { id: launch.id, mode: launch.mode, permissions, source: launch.snapshot && { session: launch.snapshot.session, anchor: launch.snapshot.anchor, digest: launch.snapshot.digest } });
  if (launch.snapshot) manager.appendCustomEntry("subagents:fork-context:v1", launch.snapshot);
  const privatePaths = await Promise.all([launch.agentDir, dirname(dirname(dirname(process.argv[2]!))), ...(launch.privatePaths ?? [])]
    .map(path => realpath(path).catch(() => path)));
  const created = await createAgentSession({ cwd: launch.cwd, agentDir: launch.agentDir, modelRuntime, model,
    thinkingLevel: launch.thinking, resourceLoader: loader, sessionManager: manager,
    settingsManager,
    tools: [...(implementing ? ["read", "ls", "grep", "find", "bash", "edit", "write"] : ["read", "ls", "grep"]), "progress", "needs_input", "report"],
    customTools: [...(implementing ? [] : inspectTools(launch.cwd, privatePaths)), progressTool, questionTool, reportTool] });
  session = created.session;
  await session.bindExtensions({ mode: "print", onError: e => { terminal = "failed"; event("error", { text: e.error }); void session?.abort(); } });
  session.agent.toolExecution = "sequential";
  const previousStop = session.agent.shouldStopAfterTurn;
  session.agent.shouldStopAfterTurn = async (context, signal) => {
    if (!synthesizing && !report && !terminal && !cancelled) budgetReason ??= exhaustedBudget();
    return !!report || !!terminal || cancelled || synthesizing || !!budgetReason || (await previousStop?.(context, signal) ?? false);
  };
  if (launch.snapshot) session.agent.state.messages = structuredClone(launch.snapshot.messages);
  const originalStream = session.agent.streamFunction;
  // SDK stream options have no stable session setter for maxTokens; cap every call.
  session.agent.streamFunction = (m, context, options) => {
    if (cancelled || report || terminal) throw new Error("Worker stopped before provider request.");
    if (synthesizing ? ++synthesisRequests > 1 : turns > launch.maxTurns || !!budgetReason) {
      terminal = "budget-exceeded"; throw new Error("Worker response budget exhausted.");
    }
    const outputReserve = Math.min(launch.maxOutputTokens, m.maxTokens);
    // Conservative byte-based estimate, not a provider tokenizer or cache claim.
    // Account for the ACTUAL worker system/tools/history, not parent usage counters.
    if (Math.ceil(Buffer.byteLength(JSON.stringify(context)) / 3) + outputReserve + 2048 > m.contextWindow) {
      terminal = "budget-exceeded"; throw new Error("Estimated context exceeds model capacity with output reserve; no silent compaction or model fallback.");
    }
    return originalStream(m, context, { ...options, maxTokens: outputReserve });
  };
  session.subscribe(e => {
    if (e.type === "turn_start") {
      turns++;
      event("turn-start");
    } else if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") event("text", { text: e.assistantMessageEvent.delta });
    else if (e.type === "message_end" && e.message.role === "assistant") {
      const usage = e.message.usage;
      event("usage", { data: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, cost: usage.cost.total } });
      if (e.message.stopReason === "error") { terminal ??= "failed"; event("error", { text: e.message.errorMessage ?? "Provider error." }); }
      else if (e.message.stopReason === "aborted") terminal ??= "cancelled";
      else if (synthesizing) {
        synthesisText = e.message.content.filter(c => c.type === "text").map(c => c.text).join("\n").trim();
        const firstReport = e.message.content.find(c => c.type === "toolCall" && c.name === "report");
        if (firstReport?.type === "toolCall") { synthesisReportCallId = firstReport.id; synthesisCandidate = firstReport.arguments; }
      }
    } else if (e.type === "tool_execution_end") event("tool-end", { tool: e.toolName, toolId: e.toolCallId, text: JSON.stringify(e.result?.content ?? {}), data: { isError: e.isError } });
  });
  send({ version: 1, type: "ready", sessionFile: manager.getSessionFile()! });
  if (cancelled) throw new Error("Cancelled before inference.");
  await session.prompt(`Current delegated task (run ${launch.id}; ${launch.mode} origin). This is the active assignment, not previous fork requests:\n\n${launch.task}\n\nWork budget: ${launch.maxTurns} responses and ${launch.maxTools} tool calls. Use the report tool when finished. If either budget is exhausted before reporting, one final report-only synthesis response is reserved; it cannot do further work.`);
  if (budgetReason && !report && !terminal && !cancelled) {
    synthesizing = true;
    event("budget-synthesis", { text: `${budgetReason} Starting one final report-only response.` });
    // Append to the same session: never replace prior messages, system prompt or tools.
    await session.prompt(`${budgetReason} FINAL SYNTHESIS: Your work budget is exhausted. You have exactly one response to summarize evidence already obtained. Only one report tool call is permitted; all other tools (including progress and needs_input) are blocked. Do not investigate, edit, or run checks. Submit report now with findings/source locations, changed files, actual verification, uncertainties and remaining work. Use partial, blocked or inconclusive if the assignment is unfinished; do not invent results. No retry follows this response.`, { expandPromptTemplates: false });
    if (!report && !terminal && !cancelled && synthesisCandidate) {
      report = salvageFinalReport(synthesisCandidate);
      if (report) synthesisDisposition = "Final report call was rejected; bounded model-authored fields retained as unvalidated partial findings.";
    }
    if (!report && !terminal && !cancelled && synthesisText) {
      // Preserve usable final prose without another formatting turn or inventing a verdict.
      let findings = synthesisText.slice(0, 3900);
      // Bound serialized bytes too: escaped controls can cost six bytes per character.
      while (Buffer.byteLength(JSON.stringify(findings)) > 6000) findings = findings.slice(0, Math.floor(findings.length * 0.8));
      report = { outcome: "partial", summary: "Budget exhausted; final synthesis returned as text, not a structured report.",
        findings: findings + (findings !== synthesisText ? "\n[Final synthesis clipped.]" : ""),
        uncertainties: "Host retained model-authored prose; completion and verification were not independently established." };
      synthesisDisposition = "Final synthesis prose retained as unvalidated partial findings.";
    }
    if (!terminal && !cancelled) event("budget-synthesis-result", { text: synthesisDisposition || (report ? "Structured final report recorded." : synthesisCandidate
      ? "Final report call rejected without usable fields; no synthesis retry." : "Final synthesis returned no usable report; no synthesis retry.") });
  }
  send({ version: 1, type: "terminal", state: cancelled ? "cancelled" : terminal ?? (budgetReason ? "budget-exceeded" : report ? "reported" : "incomplete"), report,
    reason: budgetReason && !terminal && !cancelled ? `${budgetReason} ${synthesisDisposition || (report ? "Final report retained." : synthesisCandidate
      ? "Final report call rejected without usable fields; no synthesis retry." : "Final synthesis returned no usable report; no synthesis retry.")}`
      : !report && !terminal && !cancelled ? "Model stopped without a structured report. No automatic formatting retry." : undefined });
}
try { await main(); }
catch (e) { send({ version: 1, type: "terminal", state: cancelled ? "cancelled" : terminal ?? "failed", reason: String(e).slice(0, 2000), report }); }
finally {
  finishing = true;
  clearInterval(heartbeat); if (board) await board.call("detach").catch(() => {}); session?.dispose();
  // Flush outbound IPC before ending this owned process. Provider keepalive sockets
  // are not continuing task authority, and our own disconnect is not parent loss.
  if (process.connected) await new Promise<void>(resolve => { process.once("disconnect", resolve); process.disconnect(); });
  process.exit(0);
}
