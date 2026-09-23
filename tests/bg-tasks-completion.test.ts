import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bgTasks from "../extensions/bg-tasks.ts";
import { CompletionQueue, completionPacket, formatCompletions, COMPLETION_BATCH_SIZE } from "../lib/bg-tasks/completion.ts";
import type { JobRecord } from "../lib/bg-tasks/runtime.ts";

const fake = (id = "a"): JobRecord => ({ id, command: "true", cwd: "/", createdAt: 1, execution: "exited", exitCode: 0, cleanup: "not_requested", capturedBytes: 0, retainedBytes: 0, outputTruncated: false, logPath: "/unused", limits: { timeoutSeconds: 1, maxOutputBytes: 10 }, notify: "always" });
const output = async () => ({ text: "evidence", start: 0, end: 8, retainedBytes: 8 });

test("queue coalesces a bounded batch, preserves remainder, and does not replay delivered packets", async () => {
  const q = new CompletionQueue();
  for (let i = 0; i < 10; i++) q.add(fake(String(i)));
  const delivered: any[] = [];
  await q.drain({ output }, (packets, remaining) => delivered.push({ packets, remaining }));
  expect(delivered[0].packets).toHaveLength(COMPLETION_BATCH_SIZE);
  expect(delivered[0].remaining).toBe(2);
  await q.drain({ output }, packets => delivered.push(packets));
  expect(q.size).toBe(0);
  await q.drain({ output }, () => { throw new Error("unexpected duplicate"); });
});

test("queue fences in-flight reads on clear, explicit observation, and lost delivery eligibility", async () => {
  for (const action of ["clear", "ack", "busy"] as const) {
    const q = new CompletionQueue(); q.add(fake());
    let release!: () => void, allowed = true;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const drain = q.drain({ output: async () => { await gate; return output(); } }, () => { throw new Error("stale delivery"); }, () => allowed);
    if (action === "clear") q.clear();
    if (action === "ack") q.acknowledge(["a"]);
    if (action === "busy") allowed = false;
    release(); await drain;
    expect(q.size).toBe(action === "busy" ? 1 : 0);
  }
});

test("delivery ambiguity never retries a submitted packet", async () => {
  const q = new CompletionQueue(); q.add(fake());
  await expect(q.drain({ output }, () => { throw new Error("ambiguous enqueue"); })).rejects.toThrow("ambiguous");
  expect(q.size).toBe(0);
});

test("completion packets bound escaped output and report missing output honestly", async () => {
  const job = { ...fake("a".repeat(36)), label: "\u0001".repeat(200), launchError: "x".repeat(5000), persistenceError: "\n".repeat(5000) };
  const packet = await completionPacket({ output: async () => ({ text: "\t".repeat(2048), start: 4000, end: 6048, retainedBytes: 6048 }) }, job);
  expect(packet.outputPreviewTruncated).toBe(true);
  expect(packet.output?.start).toBe(4000);
  expect(Buffer.byteLength(formatCompletions(Array(8).fill(packet)))).toBeLessThan(32 * 1024);
  const missing = await completionPacket({ output: async () => { throw new Error("log is missing"); } }, job);
  expect(missing.output).toBeUndefined(); expect(missing.outputError).toContain("missing");
});

async function fixture(run: (h: any) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "bg-delivery-"));
  const old = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const events: Record<string, Function> = {}, sent: any[] = [], records: any[] = [];
  let tool: any, idle = true;
  const listeners = new Set<() => void>();
  const ctx: any = { cwd: root, mode: "rpc", hasUI: false, isIdle: () => idle, sessionManager: { getSessionId: () => "synthetic" } };
  bgTasks({ on: (name: string, fn: Function) => { events[name] = fn; }, registerTool: (value: any) => { tool = value; }, registerCommand() {},
    appendEntry: (_name: string, record: any) => { records.push(record); for (const notify of listeners) notify(); },
    sendMessage: (message: any, options: any) => { sent.push({ message, options }); },
  } as any);
  const call = (args: any, signal?: AbortSignal) => tool.execute("fixture", args, signal, undefined, ctx);
  const settled = async (count: number) => {
    if (records.length >= count) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(check); reject(new Error("fixture settlement timeout")); }, 3000);
      const check = () => { if (records.length >= count) { clearTimeout(timer); listeners.delete(check); resolve(); } };
      listeners.add(check); check();
    });
  };
  try {
    await events.session_start({}, ctx);
    await run({ root, events, sent, records, call, settled, ctx, idle: (value: boolean) => { idle = value; } });
  } finally {
    await events.session_shutdown({}, ctx);
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
    await rm(root, { recursive: true, force: true });
  }
}

test("busy completions share one append-only boundary, not a late follow-up wake", async () => fixture(async h => {
  await h.events.before_agent_start({}, h.ctx); h.idle(false);
  await h.call({ action: "start", command: "printf first" });
  await h.call({ action: "start", command: "printf second; exit 3" });
  await h.settled(2); await Bun.sleep(100);
  expect(h.sent).toHaveLength(0);
  const previous = { type: "custom", customType: "other-extension", data: 1 };
  const result = await h.events.turn_end({ entries: [previous], message: { role: "assistant", stopReason: "toolUse" } }, h.ctx);
  expect(result.continue).toBe(true); expect(result.entries[0]).toBe(previous);
  const observation = result.entries[1];
  expect(observation.details.completions).toHaveLength(2);
  expect(observation.content).toContain("first"); expect(observation.content).toContain("second");
  expect(observation.details.completions.find((packet: any) => packet.output?.text === "second")?.exitCode).toBe(3);
  expect(await h.events.turn_end({ entries: [], message: { role: "assistant", stopReason: "stop" } }, h.ctx)).toBeUndefined();
  h.idle(true); await h.events.agent_end({ messages: [] }); await h.events.agent_settled(); await Bun.sleep(100);
  expect(h.sent).toHaveLength(0);
}));

test("idle bursts produce one bounded wake with output, not one per job", async () => fixture(async h => {
  await h.call({ action: "start", command: "printf one" });
  await h.call({ action: "start", command: "printf two" });
  await h.settled(2); await Bun.sleep(150);
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0].message.details.completions).toHaveLength(2);
  expect(h.sent[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
}));

test("wait returns output and queued completions exactly once", async () => fixture(async h => {
  await h.events.before_agent_start({}, h.ctx); h.idle(false);
  await h.call({ action: "start", command: "printf already" }); await h.settled(1);
  await h.call({ action: "start", command: "sleep 0.02; printf waited" });
  const result = await h.call({ action: "wait", waitFor: "all", seconds: 2 });
  expect(result.details.completions).toHaveLength(2);
  expect(result.content[0].text).toContain("waited"); expect(result.content[0].text).toContain("already");
  expect(await h.events.turn_end({ entries: [], message: { role: "assistant", stopReason: "stop" } }, h.ctx)).toBeUndefined();
  expect(h.sent).toHaveLength(0);
}));

test("abort suppresses late wakes, preserves observations for the next explicit prompt", async () => fixture(async h => {
  await h.events.before_agent_start({}, h.ctx);
  await h.call({ action: "start", command: "sleep 0.02; printf after-abort" });
  await h.events.agent_end({ messages: [{ role: "assistant", stopReason: "aborted" }] });
  await h.settled(1); await Bun.sleep(150);
  expect(h.sent).toHaveLength(0);
  const next = await h.events.before_agent_start({}, h.ctx);
  expect(next.message.content).toContain("after-abort");
}));

test("ignore by ID silences a settled completion still awaiting delivery", async () => fixture(async h => {
  await h.events.before_agent_start({}, h.ctx);
  const started = await h.call({ action: "start", command: "printf ignored" });
  await h.settled(1);
  const ignored = await h.call({ action: "ignore", id: started.details.job.id });
  expect(ignored.details.jobs[0].notify).toBe("off");
  expect(await h.events.turn_end({ entries: [], message: { role: "assistant", stopReason: "stop" } }, h.ctx)).toBeUndefined();
  expect(h.sent).toHaveLength(0);
}));

test("branch changes and shutdown fence queued idle delivery", async () => fixture(async h => {
  await h.call({ action: "start", command: "printf old-branch" }); await h.settled(1);
  await h.events.session_tree({}, h.ctx); await Bun.sleep(150);
  expect(h.sent).toHaveLength(0);
  await h.call({ action: "start", command: "printf before-reload" }); await h.settled(2);
  await h.events.session_shutdown({}, h.ctx); await h.events.session_start({}, h.ctx); await Bun.sleep(150);
  expect(h.sent).toHaveLength(0);
}));
