import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { captureSource, type SourceIdentity } from "./source.ts";
import { hashArtifact, writeImmutableJson, type ExecutionReceipt } from "./receipt.ts";

export type JobExecution = "starting" | "running" | "exited" | "launch_failed" | "unknown";
export type StopReason = "user_cancel" | "timeout" | "output_limit" | "session_shutdown";
export type Cleanup = "not_requested" | "pending" | "confirmed" | "incomplete" | "unknown";
export type JobNotify = "always" | "errors" | "off";

export interface JobLimits { timeoutSeconds: number; maxOutputBytes: number }
export interface JobRecord {
  id: string; label?: string; command: string; cwd: string; createdAt: number; startedAt?: number; endedAt?: number;
  execution: JobExecution; exitCode?: number | null; signal?: string | null; stopReason?: StopReason;
  cleanup: Cleanup; capturedBytes: number; retainedBytes: number; outputTruncated: boolean; logPath: string; limits: JobLimits; notify: JobNotify;
  launchError?: string; outputError?: string; persistenceError?: string;
  receipt?: { state: "pending" | "recorded" | "error"; path: string; sha256?: string; error?: string };
}
export interface OutputPage { text: string; nextCursor?: string; start: number; end: number; retainedBytes: number; gap?: string }
export interface StartOptions { command: string; cwd: string; label?: string; timeoutSeconds?: number; notify?: JobNotify }

/** Whether settlement should enqueue a model-visible completion message. */
export function shouldNotifyCompletion(job: Pick<JobRecord, "notify" | "execution" | "exitCode" | "signal" | "stopReason" | "cleanup" | "persistenceError" | "outputError">): boolean {
  if (job.notify === "off") return false;
  if (job.notify !== "errors") return true;
  return job.execution !== "exited" || job.exitCode !== 0 || !!job.signal || !!job.stopReason || !!job.persistenceError || !!job.outputError || job.cleanup === "incomplete" || job.cleanup === "unknown";
}

const DEFAULT_TIMEOUT_SECONDS = 30 * 60;
const MAX_TIMEOUT_SECONDS = 4 * 60 * 60;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const PAGE_MAX_BYTES = 32 * 1024;
const TERM_GRACE_MS = 5_000;

interface LiveJob {
  record: JobRecord; child: ChildProcess; source: SourceIdentity;
  timer?: ReturnType<typeof setTimeout>; stopping?: Promise<void>; settling?: Promise<void>;
  write: Promise<void>; done: Promise<void>; resolveDone: () => void;
  closed: Promise<void>; resolveClosed: () => void; streamsClosed: boolean;
  acceptingOutput: boolean; reservedBytes: number;
}

function copy(record: JobRecord): JobRecord { return { ...record, limits: { ...record.limits }, receipt: record.receipt ? { ...record.receipt } : undefined }; }
function cursor(id: string, offset: number): string { return `${id}:${offset}`; }
function parseCursor(id: string, value: string | undefined): number {
  if (!value) return 0;
  const match = new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:([0-9]+)$`).exec(value);
  if (!match) throw new Error("Cursor does not belong to this job.");
  return Number(match[1]);
}
function rendered(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/** Linux-only, session-bound finite commands. The caller owns lifecycle teardown. */
export class BackgroundJobRuntime {
  private readonly jobs = new Map<string, LiveJob>();
  private closed = false;

  constructor(private readonly root: string, private readonly owner: string, private readonly onComplete?: (job: JobRecord) => void) {}

  async start(options: StartOptions, signal?: AbortSignal): Promise<JobRecord> {
    if (process.platform !== "linux") throw new Error("bg_tasks start is currently supported only on Linux.");
    if (this.closed) throw new Error("Background-job runtime is shutting down.");
    if (!options.command.trim() || options.command.length > 16_384 || /\0/.test(options.command)) throw new Error("command must be non-empty text up to 16 KiB.");
    if ([...this.jobs.values()].filter(job => job.record.execution === "starting" || job.record.execution === "running").length >= 4) throw new Error("At most four background jobs may run in this session runtime.");
    signal?.throwIfAborted();
    const cwd = await realpath(options.cwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error("cwd must resolve to an existing directory.");
    const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_TIMEOUT_SECONDS) throw new Error(`timeoutSeconds must be an integer from 1 to ${MAX_TIMEOUT_SECONDS}.`);
    const notify = options.notify ?? "always";
    if (!["always", "errors", "off"].includes(notify)) throw new Error("notify must be always, errors, or off.");
    const id = randomUUID();
    const dir = join(this.root, this.owner, id);
    await mkdir(this.root, { recursive: true, mode: 0o700 }); await chmod(this.root, 0o700);
    await mkdir(dir, { recursive: true, mode: 0o700 }); await chmod(dir, 0o700);
    const record: JobRecord = { id, label: options.label?.trim() || undefined, command: options.command, cwd, createdAt: Date.now(), execution: "starting", cleanup: "not_requested", capturedBytes: 0, retainedBytes: 0, outputTruncated: false, logPath: join(dir, "output.log"), limits: { timeoutSeconds, maxOutputBytes: MAX_OUTPUT_BYTES }, notify };
    record.receipt = { state: "pending", path: join(dir, "receipt.json") };
    const source = await captureSource(cwd);
    await writeImmutableJson(join(dir, "launch.json"), { ...record, source, owner: this.owner, shell: "/bin/bash --noprofile --norc -c" });
    // An empty artifact means a silent command; absence means lost evidence.
    // Create it before spawning so storage failure cannot launch unrecorded work.
    await writeFile(record.logPath, Buffer.alloc(0), { flag: "wx", mode: 0o600 });
    signal?.throwIfAborted();
    if (this.closed) throw new Error("Background-job runtime is shutting down.");
    let child: ChildProcess;
    try {
      child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", options.command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      record.execution = "launch_failed"; record.endedAt = Date.now(); record.launchError = String(error).slice(0, 2000);
      await this.finalize(record, dir, source, "closed"); throw error;
    }
    let resolveDone!: () => void;
    const done = new Promise<void>(resolve => { resolveDone = resolve; });
    let resolveClosed!: () => void;
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    const live: LiveJob = { record, child, source, write: Promise.resolve(), done, resolveDone, closed, resolveClosed, streamsClosed: false, acceptingOutput: true, reservedBytes: 0 };
    this.jobs.set(id, live);
    const append = (chunk: Buffer) => {
      if (!live.acceptingOutput) return;
      record.capturedBytes += chunk.length;
      const remaining = MAX_OUTPUT_BYTES - live.reservedBytes;
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining);
        live.reservedBytes += kept.length;
        live.write = live.write.then(async () => {
          if (record.outputError) return;
          const log = await open(record.logPath, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            if (!(await log.stat()).isFile()) throw new Error("Log is no longer a regular file.");
            await log.writeFile(kept);
          } finally { await log.close(); }
          record.retainedBytes += kept.length;
        }).catch(error => { record.outputError = (error as NodeJS.ErrnoException).code ?? "Log write failed."; });
      }
      if (chunk.length > remaining && !record.outputTruncated) {
        record.outputTruncated = true;
        void this.cancel(id, "output_limit");
      }
    };
    child.stdout?.on("data", append); child.stderr?.on("data", append);
    child.once("spawn", () => {
      record.execution = "running"; record.startedAt = Date.now();
      void this.writeState(record, dir).catch(error => { record.persistenceError = String(error).slice(0, 2000); });
    });
    child.once("close", () => { live.streamsClosed = true; live.resolveClosed(); });
    child.once("error", error => {
      record.execution = "launch_failed"; record.endedAt = Date.now();
      record.launchError = String(error).slice(0, 2000);
      void this.settle(live, dir);
    });
    child.once("exit", (code, exitSignal) => { record.execution = "exited"; record.exitCode = code; record.signal = exitSignal; record.endedAt = Date.now(); void this.settle(live, dir); });
    live.timer = setTimeout(() => { void this.cancel(id, "timeout"); }, timeoutSeconds * 1000);
    // The tool-call signal controls launch admission only. Once acknowledged, an
    // accepted job is cancelled explicitly or during session teardown—not by a
    // later Esc that aborts an unrelated agent turn.
    return copy(record);
  }

  list(): JobRecord[] { return [...this.jobs.values()].map(job => copy(job.record)).sort((a, b) => b.createdAt - a.createdAt); }
  status(id: string): JobRecord { const job = this.jobs.get(id); if (!job) throw new Error("Unknown or no-longer-live background job ID."); return copy(job.record); }

  async output(id: string, value?: string, limit = 8 * 1024, tail = false): Promise<OutputPage> {
    const job = this.jobs.get(id); if (!job) throw new Error("Unknown or no-longer-live background job ID.");
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX_BYTES) throw new Error(`limit must be an integer from 1 to ${PAGE_MAX_BYTES}.`);
    await job.write.catch(() => {});
    if (job.record.outputError) throw new Error(`Job output capture failed: ${job.record.outputError}`);
    const bytes = await readFile(job.record.logPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Job output log is missing; retained output is unavailable, not empty.");
      throw error;
    });
    const retained = job.record.retainedBytes;
    let start = tail ? Math.max(0, retained - limit) : parseCursor(id, value);
    const gap = start > retained ? "Cursor is beyond retained output." : undefined;
    if (start > retained) start = retained;
    const end = Math.min(retained, start + limit);
    return { text: rendered(bytes.subarray(start, end).toString("utf8")), start, end, retainedBytes: retained, nextCursor: end < retained ? cursor(id, end) : undefined, gap };
  }

  async cancel(id: string, reason: StopReason = "user_cancel"): Promise<JobRecord> {
    const live = this.jobs.get(id); if (!live) throw new Error("Unknown or no-longer-live background job ID.");
    if (live.record.execution === "exited" || live.record.execution === "launch_failed") { await live.done; return copy(live.record); }
    if (!live.stopping) live.stopping = this.stop(live, reason);
    await live.stopping; return copy(live.record);
  }

  async shutdown(): Promise<void> { this.closed = true; await Promise.allSettled([...this.jobs.keys()].map(id => this.cancel(id, "session_shutdown"))); }

  private async stop(live: LiveJob, reason: StopReason): Promise<void> {
    const { record, child } = live; record.stopReason ??= reason; record.cleanup = "pending";
    await this.writeState(record, join(this.root, this.owner, record.id));
    const pid = child.pid;
    if (!pid) { record.cleanup = "incomplete"; return; }
    try { process.kill(-pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") record.cleanup = "incomplete"; }
    await Promise.race([live.done, new Promise<void>(resolve => setTimeout(resolve, TERM_GRACE_MS))]);
    if (record.execution === "running" || record.execution === "starting") {
      try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") record.cleanup = "incomplete"; }
      await Promise.race([live.done, new Promise<void>(resolve => setTimeout(resolve, TERM_GRACE_MS))]);
    }
  }

  private settle(live: LiveJob, dir: string): Promise<void> {
    return live.settling ??= (async () => {
      if (live.timer) clearTimeout(live.timer);
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Exit is not EOF. Bound inherited-pipe holders rather than hashing a
        // still-growing log or waiting forever for a detached descendant.
        await Promise.race([live.closed, new Promise<void>(resolve => { drainTimer = setTimeout(resolve, 1000); })]);
        live.acceptingOutput = false;
        if (!live.streamsClosed) { live.child.stdout?.destroy(); live.child.stderr?.destroy(); live.record.cleanup = "unknown"; }
        const capture = live.streamsClosed ? "closed" : "forced_close";
        await live.write;
        if (live.record.outputError) live.record.cleanup = "incomplete";
        else if (live.record.cleanup === "pending") live.record.cleanup = "confirmed";
        await this.finalize(live.record, dir, live.source, live.record.outputError ? "write_error" : capture);
      } catch (error) {
        live.record.persistenceError = String(error).slice(0, 2000);
        live.record.cleanup = "incomplete";
        if (live.record.receipt?.state === "pending") live.record.receipt = { ...live.record.receipt, state: "error", error: live.record.persistenceError };
      } finally {
        if (drainTimer) clearTimeout(drainTimer);
        live.resolveDone();
      }
      try { this.onComplete?.(copy(live.record)); }
      catch { /* Delivery failure must not reject the already-persisted execution. */ }
    })();
  }

  private async writeState(record: JobRecord, dir: string): Promise<void> { await this.writeJson(join(dir, "state.json"), record); }
  private async finalize(record: JobRecord, dir: string, source: SourceIdentity, capture: ExecutionReceipt["output"]["capture"]): Promise<void> {
    const artifact = await hashArtifact(record.logPath);
    if (artifact.state !== "available" || artifact.bytes !== record.retainedBytes) {
      record.outputError ??= "Retained log is unavailable or its length differs from captured output.";
      record.cleanup = "incomplete";
    }
    const { receipt: _reference, ...job } = copy(record);
    const receipt: ExecutionReceipt = {
      version: 1, kind: "execution-receipt", origin: "bg_tasks", recordedAt: Date.now(), owner: this.owner,
      shell: { executable: "/bin/bash", args: ["--noprofile", "--norc", "-c", record.command] }, job, source,
      output: { file: "output.log", capture, artifact },
    };
    const path = join(dir, "receipt.json");
    record.receipt = { state: "recorded", path, sha256: await writeImmutableJson(path, receipt) };
    await writeImmutableJson(join(dir, "result.json"), record);
    await this.writeState(record, dir);
  }
  private async writeJson(path: string, value: unknown): Promise<void> {
    const temp = `${path}.${randomUUID()}.tmp`; await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 }); await rename(temp, path);
  }
}
