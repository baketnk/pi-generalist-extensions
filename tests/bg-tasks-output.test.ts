import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundJobRuntime, type JobRecord } from "../lib/bg-tasks/runtime.ts";

const fixtures: { root: string; jobs: BackgroundJobRuntime }[] = [];

async function completed(command: string) {
  const root = await mkdtemp(join(tmpdir(), "bg-output-test-"));
  let finish!: (record: JobRecord) => void;
  const done = new Promise<JobRecord>(resolve => { finish = resolve; });
  const jobs = new BackgroundJobRuntime(root, "fixture", finish);
  fixtures.push({ root, jobs });
  await jobs.start({ command, cwd: root, timeoutSeconds: 2, notify: "off" });
  // Wait for persistence/completion, not merely the process's exit event.
  return { jobs, record: await done };
}

afterEach(async () => {
  for (const { root, jobs } of fixtures.splice(0)) {
    await jobs.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("silent jobs retain a real private empty log", async () => {
  const { jobs, record } = await completed("exit 0");
  expect(record.exitCode).toBe(0);
  expect(await readFile(record.logPath, "utf8")).toBe("");
  expect((await stat(record.logPath)).mode & 0o777).toBe(0o600);
  expect(await jobs.output(record.id)).toMatchObject({ text: "", start: 0, end: 0, retainedBytes: 0 });
});

test.each(["exit 0", "printf evidence"])("missing logs are not empty-success output: %s", async command => {
  const { jobs, record } = await completed(command);
  await rm(record.logPath);
  await expect(jobs.output(record.id)).rejects.toThrow("Job output log is missing");
  await expect(jobs.output(record.id, undefined, 32, true)).rejects.toThrow("Job output log is missing");
  expect(jobs.status(record.id).retainedBytes).toBe(record.retainedBytes);
});
