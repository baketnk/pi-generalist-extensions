import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BackgroundJobRuntime, shouldNotifyCompletion, type JobRecord } from "../lib/bg-tasks/runtime.ts";
import { hashArtifact, readReceipt, sha256, verifyReceipt, writeImmutableJson } from "../lib/bg-tasks/receipt.ts";
import { captureSource } from "../lib/bg-tasks/source.ts";

const fixtures: { root: string; jobs: BackgroundJobRuntime }[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "execution-receipt-")), cwd = join(root, "work");
  await mkdir(cwd);
  let resolve!: (job: JobRecord) => void;
  const done = new Promise<JobRecord>(r => { resolve = r; });
  let completions = 0;
  const jobs = new BackgroundJobRuntime(join(root, "artifacts"), "owner/runtime", job => { completions++; resolve(job); });
  fixtures.push({ root, jobs });
  return { root, cwd, jobs, done, completions: () => completions };
}
afterEach(async () => {
  for (const { root, jobs } of fixtures.splice(0)) {
    await jobs.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("receipt captures exact execution facts and hashes the fully drained raw log", async () => {
  const f = await fixture(), command = "head -c 1048576 /dev/zero; printf tail; exit 7";
  const started = await f.jobs.start({ command, cwd: f.cwd, notify: "off" });
  expect(started.receipt?.state).toBe("pending");
  const job = await f.done, path = job.receipt!.path;
  expect(job.receipt?.state).toBe("recorded");
  expect(f.completions()).toBe(1);
  const saved = await readReceipt(path), bytes = await readFile(job.logPath);
  expect(bytes.length).toBe(1048580);
  expect(bytes.subarray(-4).toString()).toBe("tail");
  expect(saved.sha256).toBe(job.receipt!.sha256!);
  expect(saved.receipt.job).toMatchObject({ command, cwd: f.cwd, execution: "exited", exitCode: 7, signal: null, retainedBytes: bytes.length });
  expect(saved.receipt.shell.args).toEqual(["--noprofile", "--norc", "-c", command]);
  expect(saved.receipt.source.kind).toBe("unavailable");
  expect(saved.receipt.output).toEqual({ file: "output.log", capture: "closed", artifact: { state: "available", bytes: bytes.length, sha256: sha256(bytes) } });
  expect(saved.receipt.recordedAt).toBeGreaterThanOrEqual(job.endedAt!);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(join(dirname(path), "result.json"), "utf8")).receipt).toEqual(job.receipt);
  expect(await verifyReceipt(path, job.receipt!.sha256)).toMatchObject({ receiptIntegrity: "match", artifactIntegrity: "match" });
  const original = await readFile(path, "utf8");
  await f.jobs.shutdown();
  expect(await readFile(path, "utf8")).toBe(original);
  expect(f.completions()).toBe(1);
});

test("immutable publication rejects overwrite and removes staging files", async () => {
  const f = await fixture(), path = join(f.root, "immutable.json");
  await writeImmutableJson(path, { first: true });
  const before = await readFile(path, "utf8");
  await expect(writeImmutableJson(path, { second: true })).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe(before);
  expect((await readdir(f.root)).filter(name => name.endsWith(".tmp"))).toEqual([]);
});

test("Git identity distinguishes clean, dirty, untracked and pre-command state without capturing file names", async () => {
  const f = await fixture();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: f.cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: "pipe" });
  git("init");
  await writeFile(join(f.cwd, "tracked"), "original");
  git("add", "tracked"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
  const clean = await captureSource(f.cwd);
  expect(clean).toMatchObject({ kind: "git", workingTree: "clean", head: git("rev-parse", "HEAD").toString().trim() });
  await mkdir(join(f.cwd, "nested"));
  await writeFile(join(f.cwd, "private-filename"), "untracked secret");
  const dirty = await captureSource(join(f.cwd, "nested"));
  expect(dirty.workingTree).toBe("dirty");
  expect(JSON.stringify(dirty)).not.toContain("private-filename");
  await rm(join(f.cwd, "private-filename"));
  await f.jobs.start({ command: "printf changed > tracked", cwd: f.cwd, notify: "off" });
  const job = await f.done, saved = await readReceipt(job.receipt!.path);
  expect(saved.receipt.source.workingTree).toBe("clean");
  expect((await captureSource(f.cwd)).workingTree).toBe("dirty");
});

test("explicit checks detect changed/missing artifacts and changed receipt bytes without rewriting history", async () => {
  const f = await fixture();
  await f.jobs.start({ command: "printf alpha", cwd: f.cwd, notify: "off" });
  const job = await f.done, path = job.receipt!.path, original = await readFile(path, "utf8");
  await writeFile(job.logPath, "bravo"); // same length, different content
  expect((await verifyReceipt(path)).artifactIntegrity).toBe("changed");
  expect((await verifyReceipt(path)).receiptIntegrity).toBe("not_checked");
  await rm(job.logPath);
  expect((await verifyReceipt(path)).artifactIntegrity).toBe("missing");
  expect(await readFile(path, "utf8")).toBe(original);
  await symlink(path, job.logPath);
  expect((await verifyReceipt(path)).artifactIntegrity).toBe("unavailable");
  await writeFile(path, `${original} `);
  expect((await verifyReceipt(path, job.receipt!.sha256)).receiptIntegrity).toBe("changed");
});

test("reader rejects missing, oversized, malformed and symlink receipts", async () => {
  const f = await fixture(), path = join(f.root, "receipt.json");
  await expect(readReceipt(path)).rejects.toThrow();
  await writeFile(path, "x".repeat(256 * 1024 + 1));
  await expect(readReceipt(path)).rejects.toThrow("exceeds");
  await writeFile(path, "{}");
  await expect(readReceipt(path)).rejects.toThrow("malformed");
  await symlink(path, join(f.root, "alias"));
  await expect(readReceipt(join(f.root, "alias"))).rejects.toThrow();
  expect((await hashArtifact(f.root)).state).toBe("unavailable");
});

test.each(["user_cancel", "timeout", "session_shutdown"] as const)("receipt preserves stop reason and actual signal: %s", async reason => {
  const f = await fixture();
  const job = await f.jobs.start({ command: "exec sleep 10", cwd: f.cwd, timeoutSeconds: reason === "timeout" ? 1 : 10, notify: "off" });
  if (reason === "user_cancel") await f.jobs.cancel(job.id);
  if (reason === "session_shutdown") await f.jobs.shutdown();
  const final = await f.done, saved = await readReceipt(final.receipt!.path);
  expect(saved.receipt.job).toMatchObject({ execution: "exited", stopReason: reason, exitCode: null, signal: "SIGTERM" });
  expect(saved.receipt.output.artifact).toMatchObject({ state: "available", bytes: 0 });
  expect(f.completions()).toBe(1);
});

test("receipt publication failure remains inspectable, settles once, and never clobbers", async () => {
  const f = await fixture();
  const started = await f.jobs.start({ command: "sleep 0.1", cwd: f.cwd, notify: "errors" });
  await writeFile(started.receipt!.path, "external record");
  const job = await f.done;
  expect(job.receipt?.state).toBe("error");
  expect(job.persistenceError).toBeDefined();
  expect(shouldNotifyCompletion(job)).toBe(true);
  expect(await readFile(started.receipt!.path, "utf8")).toBe("external record");
  expect(f.completions()).toBe(1);
});

test("lost live logs are not silently recreated and write errors enter the receipt", async () => {
  const f = await fixture();
  const started = await f.jobs.start({ command: "sleep 0.1; printf lost", cwd: f.cwd, notify: "off" });
  await rm(started.logPath);
  const job = await f.done, saved = await readReceipt(job.receipt!.path);
  expect(job.outputError).toBe("ENOENT");
  expect(job.retainedBytes).toBe(0);
  expect(saved.receipt.output).toMatchObject({ capture: "write_error", artifact: { state: "missing" } });
  await expect(f.jobs.output(job.id)).rejects.toThrow("capture failed");
});

test("inherited pipes are bounded and the receipt/log freeze after forced closure", async () => {
  const f = await fixture();
  await f.jobs.start({ command: "sleep 1.3 & printf leader", cwd: f.cwd, notify: "off" });
  const job = await f.done, saved = await readReceipt(job.receipt!.path), original = await readFile(job.receipt!.path, "utf8");
  expect(saved.receipt.output.capture).toBe("forced_close");
  expect(job.cleanup).toBe("unknown");
  await Bun.sleep(400); // Let the finite fixture child finish; no persistent process.
  expect(await readFile(job.receipt!.path, "utf8")).toBe(original);
  expect((await verifyReceipt(job.receipt!.path, job.receipt!.sha256)).artifactIntegrity).toBe("match");
  expect(f.completions()).toBe(1);
});

test("CLI read/check works after runtime shutdown and reports failed integrity", async () => {
  const f = await fixture();
  await f.jobs.start({ command: "printf cli", cwd: f.cwd, notify: "off" });
  const job = await f.done, path = job.receipt!.path;
  await f.jobs.shutdown();
  const cli = (...args: string[]) => Bun.spawn([process.execPath, join(import.meta.dir, "../tools/execution-receipt.ts"), ...args], { stdout: "pipe", stderr: "pipe" });
  const read = cli("read", path);
  expect(JSON.parse(await new Response(read.stdout).text()).receipt.job.id).toBe(job.id);
  expect(await read.exited).toBe(0);
  const check = cli("check", path, job.receipt!.sha256!);
  expect(JSON.parse(await new Response(check.stdout).text())).toMatchObject({ artifactIntegrity: "match", receiptIntegrity: "match" });
  expect(await check.exited).toBe(0);
  await rm(job.logPath);
  const missing = cli("check", path);
  expect(JSON.parse(await new Response(missing.stdout).text()).artifactIntegrity).toBe("missing");
  expect(await missing.exited).toBe(1);
});
