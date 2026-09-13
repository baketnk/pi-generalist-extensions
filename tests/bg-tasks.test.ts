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
