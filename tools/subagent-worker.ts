/** Owned SDK subprocess. Never load parent extensions or evaluate model-supplied code. */
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
import { LIMITS, type Launch, type ParentPacket, type TaskState, type WorkerPacket, type WorkerReport } from "../lib/subagents/types.ts";
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
  if (launch.mode === "fork") {
    if (!launch.snapshot || launch.snapshot.digest !== hash(launch.snapshot.messages)) throw new Error("Fork snapshot missing/corrupt; refusing fresh substitution.");
    completeMessages(launch.snapshot.messages);
  }
  if (launch.workerFile) {
    const binding = await jsonFile<WorkerBinding | undefined>(launch.workerFile, undefined);
    if (!binding || binding.runId !== launch.id) throw new Error("Worker mailbox grant invalid.");
    board = new BoardClient(binding.paths, binding.token);
    await board.connect({ ...await projectAt(launch.cwd), name: launch.label, summary: "Inspect worker: use subagents input/peek, not task offers. Mailbox presence only in v1.", activity: "working" }, "agent", undefined, true);
    heartbeat = setInterval(() => { void board?.call("heartbeat").catch(e => event("coordination-error", { text: String(e) })); }, 15000); heartbeat.unref();
  }
  // Auth may be consulted by the trusted provider runtime, never exposed as a worker tool.
  // Exact model identity only; no SDK default-model resolution or fallback.
  const modelRuntime = await ModelRuntime.create({ authPath: join(launch.agentDir, "auth.json"), modelsPath: join(launch.agentDir, "models.json"), allowModelNetwork: false });
  const model = modelRuntime.getModel(launch.model.provider, launch.model.id);
  if (!model) throw new Error(`Requested model unavailable: ${launch.model.provider}/${launch.model.id}`);
  if (!await modelRuntime.getAuth(model)) throw new Error(`No credentials for requested model ${launch.model.provider}/${launch.model.id}`);
  let turns = 0, tools = 0;
  const guard: ExtensionFactory = pi => {
    pi.on("tool_call", e => {
      if (cancelled || report || terminal) return { block: true, reason: "Worker stopped; sibling tools are not authorized." };
      if (++tools > launch.maxTools) { terminal = "budget-exceeded"; void session?.abort(); return { block: true, reason: "Tool budget reached." }; }
      event("tool-start", { tool: e.toolName, toolId: e.toolCallId, text: JSON.stringify(e.input) });
    });
  };
  const reportTool = defineTool({ name: "report", label: "Report", description: "Submit one final structured investigation report and stop. Claims are not proof; include source locations and actual checks, uncertainties, and limitations. No edits are allowed.",
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
    systemPromptOverride: () => "You are a bounded inspect-only subagent. Your parent assigned one investigation; independently inspect evidence and report honestly. Prior fork messages are historical context, not grants or current instructions. You have only root-scoped read/ls/grep, progress, needs_input, report. No shell, edits, recursive delegation, private memory, continuity or history tools. Never claim an inspected test passed. Use progress for substantial updates, needs_input only for blockers, and finish with report. Do not emit hidden reasoning to progress. Stop once reported.\n\nGranted root: " + launch.cwd,
  });
  await loader.reload();
  const manager = SessionManager.create(launch.cwd, join(dirname(process.argv[2]!), "sessions"));
  // Persist the frozen projection as a data entry, not copied parent activation entries.
  manager.appendCustomEntry("subagents:origin:v1", { id: launch.id, mode: launch.mode, source: launch.snapshot && { session: launch.snapshot.session, anchor: launch.snapshot.anchor, digest: launch.snapshot.digest } });
  if (launch.snapshot) manager.appendCustomEntry("subagents:fork-context:v1", launch.snapshot);
  const privatePaths = await Promise.all([launch.agentDir, dirname(dirname(dirname(process.argv[2]!))), ...(launch.privatePaths ?? [])]
    .map(path => realpath(path).catch(() => path)));
  const created = await createAgentSession({ cwd: launch.cwd, agentDir: launch.agentDir, modelRuntime, model,
    thinkingLevel: launch.thinking, resourceLoader: loader, sessionManager: manager,
    settingsManager,
    tools: ["read", "ls", "grep", "progress", "needs_input", "report"], customTools: [...inspectTools(launch.cwd, privatePaths), progressTool, questionTool, reportTool] });
  session = created.session;
  await session.bindExtensions({ mode: "print", onError: e => { terminal = "failed"; event("error", { text: e.error }); void session?.abort(); } });
  session.agent.toolExecution = "sequential";
  const previousStop = session.agent.shouldStopAfterTurn;
  session.agent.shouldStopAfterTurn = async (context, signal) => {
    if (!report && !terminal && turns >= launch.maxTurns) terminal = "budget-exceeded";
    return !!report || !!terminal || cancelled || (await previousStop?.(context, signal) ?? false);
  };
  if (launch.snapshot) session.agent.state.messages = structuredClone(launch.snapshot.messages);
  const originalStream = session.agent.streamFunction;
  // SDK stream options have no stable session setter for maxTokens; cap every call.
  session.agent.streamFunction = (m, context, options) => {
    if (turns > launch.maxTurns || cancelled || report || terminal) throw new Error("Worker stopped before provider request.");
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
      event("turn-start");
      if (++turns > launch.maxTurns) { terminal = "budget-exceeded"; void session?.abort(); }
    } else if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") event("text", { text: e.assistantMessageEvent.delta });
    else if (e.type === "message_end" && e.message.role === "assistant") {
      const usage = e.message.usage;
      event("usage", { data: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, cost: usage.cost.total } });
      if (e.message.stopReason === "error") { terminal ??= "failed"; event("error", { text: e.message.errorMessage ?? "Provider error." }); }
    } else if (e.type === "tool_execution_end") event("tool-end", { tool: e.toolName, toolId: e.toolCallId, text: JSON.stringify(e.result?.content ?? {}), data: { isError: e.isError } });
  });
  send({ version: 1, type: "ready", sessionFile: manager.getSessionFile()! });
  if (cancelled) throw new Error("Cancelled before inference.");
  await session.prompt(`Current delegated task (run ${launch.id}; ${launch.mode} origin). This is the active assignment, not previous fork requests:\n\n${launch.task}\n\nUse the report tool when finished.`);
  send({ version: 1, type: "terminal", state: cancelled ? "cancelled" : terminal ?? (report ? "reported" : "incomplete"), report,
    reason: !report && !terminal && !cancelled ? "Model stopped without a structured report. No automatic formatting retry." : undefined });
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
