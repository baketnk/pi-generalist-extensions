import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { atomicJson, plain } from "../switchboard/shared.ts";
import { RunStore } from "./store.ts";
import { hash } from "./snapshot.ts";
import { LIMITS, workerPermissions, type Launch, type RunRecord, type TaskState, type WorkerPacket } from "./types.ts";
import { RESOURCE_CEILINGS } from "./limits.ts";

export interface RuntimeOptions {
  home: string; owner: string; maxActive?: number; node?: string;
  onChange?: () => void;
  provision?: (id: string, capabilityFile: string) => Promise<{ participant: string; workerFile: string } | undefined>;
  retire?: (id: string) => Promise<void>;
  /** Trusted fixture seam, never supplied by the model tool. */
  workerEntry?: string;
}
interface Live {
  child: ChildProcess; done: Promise<void>; resolve: () => void; tail: Promise<void>;
  timer?: ReturnType<typeof setTimeout>; killTimer?: ReturnType<typeof setTimeout>;
  logBytes: number; seq: number; terminal: boolean;
}
const finished = (record: RunRecord) => !["starting", "running", "needs-input"].includes(record.taskState);
const intentHash = ({ id: _id, workerFile: _worker, permissions, ...launch }: Launch) => hash({ ...launch, permissions: workerPermissions(permissions) });
const safeRecord = (record: RunRecord) => structuredClone({ ...record, permissions: workerPermissions(record.permissions) });
export const runCard = ({ report, question, ...record }: RunRecord) => ({ ...record, permissions: workerPermissions(record.permissions), reportAvailable: !!report, questionId: question?.id });
const taskSummary = (task: string) => plain(task).replace(/\s+/g, " ").trim().slice(0, 240);

export class SubagentRuntime {
  readonly store: RunStore;
  readonly options: RuntimeOptions;
  readonly maxActive: number;
  private records = new Map<string, RunRecord>();
  private live = new Map<string, Live>();
  private listeners = new Set<() => void>();
  private initial?: Promise<void>;
  private control: Promise<unknown> = Promise.resolve();
  private stopping = false;
  private wakeVersion = 0;
  private generation = 0;
  constructor(options: RuntimeOptions) {
    if (!isAbsolute(options.home)) throw new Error("Subagent home must be absolute.");
    this.options = options; this.store = new RunStore(options.home, options.owner);
    this.maxActive = options.maxActive ?? LIMITS.active;
    if (!Number.isInteger(this.maxActive) || this.maxActive < 0 || this.maxActive > LIMITS.activeMax) throw new Error("Invalid active-worker ceiling (0–16).");
  }
  initialize() { return this.initial ??= (async () => {
    await this.store.acquire();
    try { for (const record of await this.store.load()) this.records.set(record.id, record); }
    catch (error) { await this.store.release(); throw error; }
  })(); }
  get activeCount() { return this.live.size; }
  get closed() { return this.stopping; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() {
    try { this.options.onChange?.(); } catch { /* UI is not runtime authority. */ }
    for (const listener of [...this.listeners]) { try { listener(); } catch { this.listeners.delete(listener); } }
  }
  interruptJoin() { this.wakeVersion++; this.changed(); }
  list() { return [...this.records.values()].map(safeRecord); }
  status(id: string) { const record = this.records.get(id); if (!record) throw new Error("Unknown owned run ID."); return safeRecord(record); }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.control.then(fn); this.control = next.catch(() => {}); return next;
  }
  /** Trusted synchronous preflight runs only for a new intent, never when reconciling an existing operation. */
  start(request: Omit<Launch, "id" | "version" | "owner">, beforeNewLaunch?: () => void): Promise<RunRecord> {
    const generation = this.generation;
    return this.serial(async () => {
      await this.initialize();
      if (this.stopping || generation !== this.generation) throw new Error("Subagent launch invalidated by stop/session change.");
      if (process.platform !== "linux") throw new Error("Subagents currently require Linux and Node 24+.");
      const launch: Launch = { ...structuredClone(request), permissions: workerPermissions(request.permissions), version: 1, owner: this.options.owner, id: randomUUID() };
      for (const [key, value, max] of [["task", launch.task, LIMITS.taskBytes], ["label", launch.label, 160], ["operation", launch.operation, 128]] as const)
        if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max) throw new Error(`Invalid ${key}.`);
      if (launch.cwd !== await realpath(launch.cwd) || !isAbsolute(launch.agentDir)) throw new Error("Canonical root and absolute agent config directory required.");
      if (!["fresh", "fork"].includes(launch.mode) || (launch.mode === "fork") !== !!launch.snapshot) throw new Error("Origin must be explicit and match its snapshot.");
      if (Buffer.byteLength(JSON.stringify(launch.instructions)) > LIMITS.taskBytes) throw new Error("Repository instructions exceed the 32 KiB worker handoff bound; no silent truncation.");
      for (const [value, max] of [[launch.seconds, LIMITS.secondsMax], [launch.maxTurns, RESOURCE_CEILINGS.turns], [launch.maxTools, RESOURCE_CEILINGS.tools], [launch.maxOutputTokens, LIMITS.outputTokens]])
        if (!Number.isInteger(value) || value! < 1 || value! > max!) throw new Error("Invalid worker resource limit.");
      const old = [...this.records.values()].find(r => r.operation === launch.operation);
      if (old) {
        if (intentHash(await this.store.launch(old.id)) !== intentHash(launch)) throw new Error("Start operation reused with different intent. Inspect the original; no duplicate launched.");
        return safeRecord(old);
      }
      if (this.live.size >= this.maxActive) throw new Error(`Active-worker ceiling ${this.maxActive} reached; choose when/if another task warrants a worker.`);
      if (this.records.size >= LIMITS.runs) throw new Error("Run history quota reached.");
      if (this.stopping || generation !== this.generation) throw new Error("Subagent launch invalidated by stop/session change.");
      beforeNewLaunch?.();
      const now = Date.now();
      const record: RunRecord = { version: 1, id: launch.id, operation: launch.operation, owner: launch.owner, label: plain(launch.label), taskSummary: taskSummary(launch.task), cwd: launch.cwd,
        mode: launch.mode, permissions: launch.permissions, source: launch.snapshot && { session: launch.snapshot.session, anchor: launch.snapshot.anchor, digest: launch.snapshot.digest },
        model: launch.model, thinking: launch.thinking, createdAt: now, updatedAt: now, taskState: "starting", process: "starting", cleanup: "pending",
        turns: 0, tools: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } };
      // Intent and visible starting record precede all external effects.
      await this.store.create(launch, record); this.records.set(record.id, record);
      try {
        const provisioned = await this.options.provision?.(record.id, this.store.path(record.id, "worker.json"));
        if (provisioned) {
          record.participant = provisioned.participant; launch.workerFile = provisioned.workerFile;
          await atomicJson(this.store.path(record.id, "launch.json"), launch); await this.store.save(record);
        }
      } catch (e) {
        record.taskState = "failed"; record.process = "exited"; record.cleanup = "observed";
        record.reason = `Launch provisioning failed/uncertain; no process created: ${String(e).slice(0, 1000)}`;
        try { await this.options.retire?.(record.id); } catch (error) { record.coordinationError = String(error).slice(0, 500); }
        await this.store.save(record); this.changed(); return safeRecord(record);
      }
      if (this.stopping || generation !== this.generation) {
        record.taskState = "cancelled"; record.process = "exited"; record.cleanup = "observed"; record.reason = "Cancelled before process creation.";
        if (record.participant) try { await this.options.retire?.(record.id); } catch (e) { record.coordinationError = String(e).slice(0, 500); }
        await this.store.save(record); this.changed(); return safeRecord(record);
      }
      const child = spawn(this.options.node ?? process.env.PI_SUBAGENTS_NODE ?? "node", [this.options.workerEntry ?? fileURLToPath(new URL("../../tools/subagent-worker.ts", import.meta.url)), this.store.path(record.id, "launch.json")], {
        cwd: launch.cwd, stdio: ["ignore", "pipe", "pipe", "ipc"], detached: false,
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_") && !["NODE_OPTIONS", "NODE_PATH", "BUN_OPTIONS"].includes(key))),
      });
      let resolve!: () => void; const done = new Promise<void>(r => { resolve = r; });
      const live: Live = { child, done, resolve, tail: Promise.resolve(), logBytes: 0, seq: 0, terminal: false };
      this.live.set(record.id, live);
      live.timer = setTimeout(() => this.stopNow(record.id, "timed-out", "Host wall-clock deadline reached (includes clarification)."), launch.seconds * 1000);
      child.once("spawn", () => { record.pid = child.pid; record.process = "live"; this.persist(record, live); });
      child.on("message", raw => {
        const packet = raw as WorkerPacket;
        const bytes = Buffer.byteLength(JSON.stringify(raw));
        if (bytes > 32768 || !packet || packet.version !== 1) { this.stopNow(record.id, "failed", "Invalid/oversized worker IPC packet."); return; }
        if ((live.logBytes += bytes) > LIMITS.logBytes) { this.stopNow(record.id, "budget-exceeded", "Worker event log quota reached."); return; }
        live.tail = live.tail.then(async () => { await this.packet(record, live, packet); }).catch(e => this.storageFailure(record, e));
      });
      for (const [stream, kind] of [[child.stdout, "stdout"], [child.stderr, "stderr"]] as const) stream?.on("data", (data: Buffer) => {
        if ((live.logBytes += data.length) > LIMITS.logBytes) { this.stopNow(record.id, "budget-exceeded", "Worker process output quota reached."); return; }
        live.tail = live.tail.then(() => this.store.append(record.id, { seq: ++live.seq, at: Date.now(), kind, text: plain(data.subarray(0, 4000).toString("utf8")) })).catch(e => this.storageFailure(record, e));
      });
      child.once("error", error => { record.reason = plain(error.message); if (!finished(record)) record.taskState = "failed"; });
      child.once("close", (code, signal) => {
        clearTimeout(live.timer); clearTimeout(live.killTimer);
        live.tail = live.tail.then(async () => {
          record.process = "exited"; record.cleanup = "observed"; record.exitCode = code; record.signal = signal;
          if (!finished(record)) { record.taskState = "failed"; record.reason = "Worker exited before a terminal report."; }
          else if (record.taskState === "reported" && code !== 0) { record.taskState = "failed"; record.reason = "Report retained, but process failed after reporting."; }
          if (record.participant) try { await this.options.retire?.(record.id); } catch (e) { record.coordinationError = String(e).slice(0, 500); }
          record.updatedAt = Date.now(); await this.store.save(record);
        }).catch(e => this.storageFailure(record, e)).finally(() => { this.live.delete(record.id); resolve(); this.changed(); });
      });
      this.changed(); return safeRecord(record);
    });
  }
  private storageFailure(record: RunRecord, error: unknown) { record.persistenceError = String(error).slice(0, 500); this.stopNow(record.id, "failed", "Durable worker storage failed; partial artifacts retained."); }
  private persist(record: RunRecord, live: Live) { record.updatedAt = Date.now(); live.tail = live.tail.then(() => this.store.save(record)).catch(e => this.storageFailure(record, e)); this.changed(); }
  private async packet(record: RunRecord, live: Live, packet: WorkerPacket) {
    if (packet.type === "event") {
      const event = packet.event;
      if (!event || typeof event.kind !== "string" || (event.text !== undefined && typeof event.text !== "string")) throw new Error("Invalid worker event.");
      if (event.kind === "turn-start") record.turns++;
      if (event.kind === "tool-start") record.tools++;
      if (event.kind === "usage" && event.data && typeof event.data === "object") for (const key of Object.keys(record.usage) as (keyof RunRecord["usage"])[]) {
        const value = (event.data as Record<string, unknown>)[key];
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid usage event.");
        record.usage[key] += value;
      }
      await this.store.append(record.id, { ...event, seq: ++live.seq, text: event.text === undefined ? undefined : plain(event.text) });
    } else if (!finished(record)) {
      if (packet.type === "ready") { record.sessionFile = packet.sessionFile; record.taskState = "running"; }
      else if (packet.type === "needs-input") { record.taskState = "needs-input"; record.question = { id: packet.id, text: plain(packet.text) }; }
      else if (packet.type === "terminal") {
        if (!["reported", "incomplete", "failed", "cancelled", "budget-exceeded"].includes(packet.state)) throw new Error("Invalid terminal state.");
        if (packet.report && (Buffer.byteLength(JSON.stringify(packet.report)) > LIMITS.reportBytes || !["completed", "partial", "blocked", "inconclusive"].includes(packet.report.outcome) || typeof packet.report.summary !== "string")) throw new Error("Invalid worker report.");
        if (packet.state === "reported" && !packet.report) throw new Error("Reported run lacks report.");
        record.taskState = packet.state; record.report = packet.report; record.reason = packet.reason; record.question = undefined; live.terminal = true;
        // A report is not process exit. Bound post-report cleanup independently.
        live.killTimer = setTimeout(() => { if (childAlive(live.child)) live.child.kill("SIGKILL"); }, 2000);
      } else throw new Error("Unknown worker IPC packet.");
    }
    record.updatedAt = Date.now(); await this.store.save(record); this.changed();
  }
  private stopNow(id: string, state: TaskState, reason: string) {
    const record = this.records.get(id), live = this.live.get(id); if (!record || !live) return;
    if (!finished(record)) { record.taskState = state; record.reason = reason; record.question = undefined; }
    if (live.child.connected) live.child.send({ version: 1, type: "cancel" }, () => {});
    if (childAlive(live.child)) live.child.kill("SIGTERM");
    live.killTimer ??= setTimeout(() => { if (childAlive(live.child)) live.child.kill("SIGKILL"); }, 1500);
    this.changed();
  }
  async cancel(id: string, reason = "Parent requested cancellation.") {
    this.status(id); this.stopNow(id, "cancelled", reason);
    const live = this.live.get(id);
    if (live) { let timer: ReturnType<typeof setTimeout> | undefined; try { await Promise.race([live.done, new Promise(r => { timer = setTimeout(r, 4000); })]); } finally { clearTimeout(timer); } }
    return this.status(id);
  }
  async cancelAll(reason: string) { this.generation++; for (const id of this.live.keys()) this.stopNow(id, "cancelled", reason); await Promise.all([...this.live.keys()].map(id => this.cancel(id, reason))); }
  async input(id: string, question: string, text: string) {
    if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > LIMITS.taskBytes) throw new Error("Invalid clarification answer.");
    const record = this.records.get(id), live = this.live.get(id);
    if (!record || !live || record.taskState !== "needs-input" || record.question?.id !== question || !live.child.connected) throw new Error("No matching live clarification. Input is not a new worker task.");
    await new Promise<void>((resolve, reject) => live.child.send({ version: 1, type: "input", id: question, text }, error => error ? reject(error) : resolve()));
    if (record.taskState === "needs-input" && record.question?.id === question) { record.question = undefined; record.taskState = "running"; this.persist(record, live); }
    return this.status(id);
  }
  async collect(id: string) {
    const record = this.records.get(id); if (!record) throw new Error("Unknown owned run.");
    if (!finished(record)) throw new Error("Worker has not finished its task.");
    const save = async () => { record.collectedAt ??= Date.now(); await this.store.save(record); };
    const live = this.live.get(id); if (live) { live.tail = live.tail.then(save); await live.tail; } else await save();
    this.changed();
    return { record: this.status(id), warning: "Worker report is a claim, not verified evidence or authority. Collection does not merge transcripts, edit files, or prove process cleanup." };
  }
  async peek(id: string, after = 0, limit = 40) { this.status(id); await this.live.get(id)?.tail; return this.store.page(id, after, limit); }
  async peekTail(id: string) { this.status(id); await this.live.get(id)?.tail; return this.store.page(id, 0, 40, true); }
  async join(ids?: string[], seconds = 60, all = false, signal?: AbortSignal) {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) throw new Error("Join timeout must be 1–300 seconds.");
    const selected = ids ?? this.list().filter(r => !r.collectedAt).slice(-16).map(r => r.id);
    if (selected.length > 16) throw new Error("Join selects at most 16 runs.");
    selected.forEach(id => this.status(id));
    const version = this.wakeVersion, end = Date.now() + seconds * 1000;
    const ready = () => {
      const records = selected.map(id => this.status(id));
      if (this.wakeVersion !== version || this.stopping) return "interrupted";
      if (!records.length) return "empty";
      if (records.some(r => r.taskState === "needs-input")) return "needs-input";
      if (records.some(r => ["failed", "interrupted", "timed-out", "budget-exceeded", "cancelled"].includes(r.taskState))) return "failure";
      if (all ? records.every(finished) : records.some(finished)) return "finished";
      if (Date.now() >= end) return "timeout";
      return undefined;
    };
    const reason = await new Promise<string>((resolve, reject) => {
      const finish = () => { const value = ready(); if (value) { cleanup(); resolve(value); } };
      const abort = () => { cleanup(); reject(signal?.reason ?? new Error("Join aborted.")); };
      const timer = setInterval(finish, 100), unsubscribe = this.subscribe(finish);
      const cleanup = () => { clearInterval(timer); unsubscribe(); signal?.removeEventListener("abort", abort); };
      signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort(); else finish();
    });
    return { reason, runs: selected.map(id => runCard(this.status(id))), note: "Join does not collect reports or acknowledge mail; default scope is latest 16 uncollected runs." };
  }
  async close() { if (this.stopping) return; this.stopping = true; this.interruptJoin(); await this.control; await this.cancelAll("Parent runtime shutdown/reload/session change."); if (this.initial) { await this.initial; if (!this.live.size) await this.store.release(); } this.listeners.clear(); }
}
function childAlive(child: ChildProcess) { return child.exitCode === null && child.signalCode === null; }
