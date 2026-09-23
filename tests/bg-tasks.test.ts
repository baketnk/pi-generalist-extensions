import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bgTasks from "../extensions/bg-tasks.ts";
import { BackgroundJobRuntime, shouldNotifyCompletion } from "../lib/bg-tasks/runtime.ts";

const roots: string[] = [];
async function runtime() {
  const root = await mkdtemp(join(tmpdir(), "bg-tasks-test-")); roots.push(root);
  return new BackgroundJobRuntime(root, "session/runtime");
}
async function settle(jobs: BackgroundJobRuntime, id: string): Promise<ReturnType<BackgroundJobRuntime["status"]>> {
  for (let i = 0; i < 100; i++) {
    const job = jobs.status(id);
    if ((job.execution === "exited" || job.execution === "launch_failed") && job.receipt?.state !== "pending") {
      await jobs.cancel(id); // Terminal cancel only waits for final persistence.
      return jobs.status(id);
    }
    await Bun.sleep(10);
  }
  throw new Error("job did not settle");
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("bg_tasks registers independently with a session-shutdown lifecycle hook", async () => {
  const events: Record<string, Function[]> = {};
  const tools: Record<string, unknown> = {};
  const commands: Record<string, unknown> = {};
  const pi: any = {
    on: (name: string, fn: Function) => (events[name] ??= []).push(fn), registerTool: (tool: any) => tools[tool.name] = tool,
    registerCommand: (name: string, command: unknown) => commands[name] = command, appendEntry() {}, sendMessage() {},
  };
  bgTasks(pi);
  expect(tools.bg_tasks).toBeDefined();
  expect(commands["bg-tasks"]).toBeDefined();
  expect(events.session_shutdown).toHaveLength(1);
});

test("completion policy can ignore clean success or every result without losing records", async () => {
  const jobs = await runtime();
  const success = await jobs.start({ command: "exit 0", cwd: process.cwd(), notify: "errors" });
  const failed = await jobs.start({ command: "exit 3", cwd: process.cwd(), notify: "errors" });
  const silent = await jobs.start({ command: "exit 4", cwd: process.cwd(), notify: "off" });
  const successRecord = await settle(jobs, success.id), failedRecord = await settle(jobs, failed.id), silentRecord = await settle(jobs, silent.id);
  expect(shouldNotifyCompletion(successRecord)).toBe(false);
  expect(shouldNotifyCompletion(failedRecord)).toBe(true);
  expect(shouldNotifyCompletion(silentRecord)).toBe(false);
  expect(successRecord.notify).toBe("errors");
  expect(JSON.parse(await readFile(join(successRecord.logPath, "..", "result.json"), "utf8")).notify).toBe("errors");
});

test("ignore permanently silences active jobs without stopping them", async () => {
  const jobs = await runtime();
  const started = await jobs.start({ command: "sleep 0.05; exit 9", cwd: process.cwd() });
  const [ignored] = await jobs.ignore([started.id]);
  expect(ignored!.notify).toBe("off");
  expect(["starting", "running"]).toContain(ignored!.execution);
  const finished = await settle(jobs, started.id);
  expect(finished.exitCode).toBe(9);
  expect(shouldNotifyCompletion(finished)).toBe(false);
});

test("wait distinguishes the next completion from all jobs active at call time", async () => {
  const jobs = await runtime();
  const first = await jobs.start({ command: "sleep 0.03", cwd: process.cwd(), notify: "off" });
  const second = await jobs.start({ command: "sleep 1", cwd: process.cwd(), notify: "off" });
  const next = await jobs.wait("next", 2);
  expect(next).toMatchObject({ waitFor: "next", reason: "completed" });
  expect(next.completed.map(job => job.id)).toContain(first.id);
  expect(next.running.map(job => job.id)).toContain(second.id);
  await jobs.cancel(second.id);

  const third = await jobs.start({ command: "sleep 0.02", cwd: process.cwd(), notify: "off" });
  const fourth = await jobs.start({ command: "sleep 0.04", cwd: process.cwd(), notify: "off" });
  const all = await jobs.wait("all", 2);
  expect(all).toMatchObject({ waitFor: "all", reason: "completed", running: [] });
  expect(all.completed.map(job => job.id).sort()).toEqual([third.id, fourth.id].sort());
});

test("wait is bounded and reports jobs that remain active", async () => {
  const jobs = await runtime();
  const started = await jobs.start({ command: "sleep 10", cwd: process.cwd(), notify: "off" });
  const result = await jobs.wait("all", 1);
  expect(result).toMatchObject({ waitFor: "all", reason: "timeout", completed: [] });
  expect(result.running.map(job => job.id)).toEqual([started.id]);
  await jobs.cancel(started.id);
});

test("wait includes exited processes until output and receipts have settled", async () => {
  const jobs = await runtime();
  const started = await jobs.start({ command: "(sleep 0.15; printf final-output) & exit 0", cwd: process.cwd(), notify: "off" });
  for (let i = 0; i < 100 && jobs.status(started.id).execution !== "exited"; i++) await Bun.sleep(1);
  expect(jobs.status(started.id).execution).toBe("exited");
  expect(jobs.pending().map(job => job.id)).toContain(started.id);
  const waited = await jobs.wait("all", 2);
  expect(waited.completed.map(job => job.id)).toEqual([started.id]);
  expect(waited.completed[0]?.receipt?.state).toBe("recorded");
  expect((await jobs.output(started.id)).text).toBe("final-output");
});

test("turn end prompts for a disposition, and ignore all clears the gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "bg-tasks-extension-test-")); roots.push(root);
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const events: Record<string, Function> = {}, sent: Array<{ message: any; options: any }> = [];
  let tool: any;
  const pi: any = {
    on: (name: string, fn: Function) => events[name] = fn, registerTool: (value: any) => tool = value,
    registerCommand() {}, appendEntry() {}, sendMessage: (message: any, options: any) => sent.push({ message, options }),
  };
  const ctx: any = { cwd: root, mode: "tui", hasUI: false, sessionManager: { getSessionId: () => "fixture" } };
  try {
    bgTasks(pi); await events.session_start({}, ctx);
    await tool.execute("start", { action: "start", command: "sleep 10" }, undefined, undefined, ctx);
    await events.turn_end({ message: { role: "assistant", stopReason: "stop" } }, ctx);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message.content).toContain("cancel them");
    expect(sent[0]!.message.content).toContain("waitFor=next/all");
    expect(sent[0]!.options).toEqual({ deliverAs: "steer", triggerTurn: true });
    await tool.execute("ignore", { action: "ignore", all: true }, undefined, undefined, ctx);
    await events.turn_end({ message: { role: "assistant", stopReason: "stop" } }, ctx);
    expect(sent).toHaveLength(1);
  } finally {
    await events.session_shutdown?.({}, ctx);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("background jobs return promptly, retain bounded output, and preserve nonzero exits", async () => {
  const jobs = await runtime();
  const started = await jobs.start({ command: "printf 'alpha\\nbeta\\n'; exit 7", cwd: process.cwd(), label: "fixture" });
  expect(started.execution === "starting" || started.execution === "running" || started.execution === "exited").toBe(true);
  const finished = await settle(jobs, started.id);
  expect(finished.execution).toBe("exited");
  expect(finished.exitCode).toBe(7);
  const first = await jobs.output(started.id, undefined, 6);
  expect(first.text).toBe("alpha\n");
  expect(first.nextCursor).toBeDefined();
  const second = await jobs.output(started.id, first.nextCursor, 32);
  expect(second.text).toBe("beta\n");
  expect((await readFile(finished.logPath, "utf8"))).toBe("alpha\nbeta\n");
});

test("invalid cursors and non-Linux-independent ownership checks fail closed", async () => {
  const jobs = await runtime();
  const started = await jobs.start({ command: "printf ok", cwd: process.cwd() });
  await settle(jobs, started.id);
  await expect(jobs.output(started.id, "other:0")).rejects.toThrow("Cursor does not belong");
  expect(() => jobs.status("not-a-job")).toThrow("Unknown");
  await expect(jobs.cancel("not-a-job")).rejects.toThrow("Unknown");
  await expect(jobs.start({ command: "true", cwd: import.meta.path })).rejects.toThrow("existing directory");
});

test("session shutdown terminates owned jobs and records shutdown cleanup", async () => {
  const jobs = await runtime();
  const started = await jobs.start({ command: "trap 'exit 0' TERM; while :; do sleep 1; done", cwd: process.cwd() });
  await Bun.sleep(30);
  await jobs.shutdown();
  const finished = jobs.status(started.id);
  expect(finished.stopReason).toBe("session_shutdown");
  expect(["confirmed", "incomplete"]).toContain(finished.cleanup);
  expect(finished.execution).toBe("exited");
});

test("shutdown still signals owned processes when metadata storage fails", async () => {
  const jobs = await runtime();
  const started = await jobs.start({ command: "sleep 1", cwd: process.cwd(), notify: "off" });
  await Bun.sleep(20);
  await rm(join(started.logPath, ".."), { recursive: true, force: true });
  await jobs.shutdown();
  const finished = jobs.status(started.id);
  expect(finished.execution).toBe("exited");
  expect(finished.stopReason).toBe("session_shutdown");
  expect(finished.persistenceError).toBeDefined();
});
