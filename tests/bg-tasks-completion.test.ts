import { expect, test } from "bun:test";
import { Check } from "typebox/value";
import { validateToolArguments } from "@earendil-works/pi-ai";
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
  expect(missing.nextCalls).toEqual([]);
});

async function fixture(run: (h: any) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "bg-delivery-"));
  const old = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const events: Record<string, Function> = {}, sent: any[] = [], records: any[] = [];
  const tools: Record<string, any> = {}; let idle = true;
  const listeners = new Set<() => void>();
  const ctx: any = { cwd: root, mode: "rpc", hasUI: false, isIdle: () => idle, sessionManager: { getSessionId: () => "synthetic" } };
  bgTasks({ on: (name: string, fn: Function) => { events[name] = fn; }, registerTool: (value: any) => { tools[value.name] = value; }, registerCommand() {},
    appendEntry: (_name: string, record: any) => { records.push(record); for (const notify of listeners) notify(); },
    sendMessage: (message: any, options: any) => { sent.push({ message, options }); },
  } as any);
  const call = (name: string, args: any, signal?: AbortSignal) => tools[name].execute("fixture", args, signal, undefined, ctx);
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
    await run({ root, events, sent, records, tools, call, settled, ctx, idle: (value: boolean) => { idle = value; } });
  } finally {
    await events.session_shutdown({}, ctx);
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
    await rm(root, { recursive: true, force: true });
  }
}

test("seven static strict action-specific schemas reject unrelated fields and placeholders at host validation", async () => fixture(async h => {
  expect(Object.keys(h.tools).sort()).toEqual(["bg_start", "bg_list", "bg_status", "bg_output", "bg_wait", "bg_cancel", "bg_mute_notifications"].sort());
  const valid: Record<string, any> = {
    bg_start: { launchKey: "key", command: "true" }, bg_list: {}, bg_status: { jobId: "real-id" }, bg_output: { jobId: "real-id" },
    bg_wait: { jobIds: ["real-id"], waitMode: "any" }, bg_cancel: { jobIds: ["real-id"] }, bg_mute_notifications: { jobIds: ["real-id"] },
  };
  for (const [name, tool] of Object.entries(h.tools) as [string, any][]) {
    expect(tool.description.startsWith("Recipe:")).toBe(true);
    expect(tool.promptGuidelines[0].startsWith("Recipe:")).toBe(true);
    expect(tool.parameters.additionalProperties).toBe(false);
    expect(Check(tool.parameters, valid[name])).toBe(true);
    for (const extra of [{ action: "start" }, { id: "" }, { all: true }, { timeoutSeconds: 2 }, { unrelated: null }]) {
      expect(Check(tool.parameters, { ...valid[name], ...extra })).toBe(false);
      expect(() => validateToolArguments(tool, { type: "toolCall", id: "validation", name, arguments: { ...valid[name], ...extra } })).toThrow();
    }
    for (const field of tool.parameters.required ?? []) {
      for (const value of [undefined, null, "", []]) expect(Check(tool.parameters, { ...valid[name], [field]: value })).toBe(false);
    }
  }
  for (const name of ["bg_wait", "bg_cancel", "bg_mute_notifications"]) {
    expect(Check(h.tools[name].parameters, { ...valid[name], jobIds: ["a", "a"] })).toBe(false);
  }
  expect(Check(h.tools.bg_wait.parameters, { ...valid.bg_wait, waitMode: "next" })).toBe(false);
  expect(Check(h.tools.bg_start.parameters, { ...valid.bg_start, runTimeoutSeconds: 0 })).toBe(false);
  expect(Check(h.tools.bg_start.parameters, { ...valid.bg_start, command: " " })).toBe(false);
  const empty = await h.call("bg_list", {});
  expect(empty.details.jobs).toEqual([]);
  expect(empty.details.nextCalls).toEqual([]);
}));

test("launch keys reserve identical intent without respawn, reject changed intent, and expose real next calls", async () => fixture(async h => {
  const args = Object.freeze({ launchKey: "once", command: "printf evidence", notify: "off" });
  const [a, b] = await Promise.all([h.call("bg_start", args), h.call("bg_start", args)]);
  const jobId = a.details.jobId;
  expect(b.details.jobId).toBe(jobId);
  expect(a.content[0].text).toContain(JSON.stringify(jobId));
  expect(a.details.nextCalls).toContainEqual({ tool: "bg_wait", arguments: { jobIds: [jobId], waitMode: "all", waitTimeoutSeconds: 60 } });
  await expect(h.call("bg_start", { ...args, command: "printf different" })).rejects.toThrow('"code":"LAUNCH_KEY_CONFLICT"');
  const listed = await h.call("bg_list", {});
  expect(listed.details.jobs).toHaveLength(1);
  expect(listed.content[0].text).toContain('launchKey="once"');
  await h.call("bg_wait", { jobIds: [jobId], waitMode: "all", waitTimeoutSeconds: 2 });
  const page = await h.call("bg_output", { jobId, limit: 2 });
  expect(page.details.nextCursor).toBe(`${jobId}:2`);
  const next = page.details.nextCalls[0];
  expect(next).toEqual({ tool: "bg_output", arguments: { jobId, cursor: `${jobId}:2` } });
  const finalPage = await h.call(next.tool, next.arguments);
  expect(finalPage.content[0].text).toStartWith("idence");
  expect(finalPage.details.nextCalls).toEqual([]); // No status/output loop at EOF.
  const status = await h.call("bg_status", { jobId });
  expect(status.details.nextCalls).toEqual([{ tool: "bg_output", arguments: { jobId, cursor: `${jobId}:0` } }]);
  for (const call of a.details.nextCalls) expect(Check(h.tools[call.tool].parameters, call.arguments)).toBe(true);
}));

test("failed launch keys remain reserved; errors are thrown JSON with repair and no automatic retry", async () => fixture(async h => {
  const args = { launchKey: "failed", command: "true", cwd: join(h.root, "missing") };
  let first: any;
  try { await h.call("bg_start", args); throw new Error("expected failure"); } catch (error: any) { first = JSON.parse(error.message); }
  expect(first).toMatchObject({ code: "START_FAILED", retryUnchanged: false, effect: "unknown" });
  expect(first.repair).toContain("Never change launchKey");
  expect(first.nextCalls).toEqual([{ tool: "bg_list", arguments: {} }]);
  await expect(h.call("bg_start", { ...args, cwd: h.root })).rejects.toThrow("LAUNCH_KEY_CONFLICT");
  await expect(h.call("bg_start", args)).rejects.toThrow("START_FAILED");
  expect((await h.call("bg_list", {})).details.jobs).toEqual([]);
  try { await h.call("bg_cancel", { jobIds: [] }); } catch (error: any) {
    expect(JSON.parse(error.message)).toMatchObject({ code: "INVALID_ARGUMENTS", retryUnchanged: false, effect: "none" });
  }
}));

test("missing output terminates repair hints instead of recommending the failed read again", async () => fixture(async h => {
  const start = await h.call("bg_start", { launchKey: "lost-output", command: "printf evidence", notify: "off" });
  const jobId = start.details.jobId;
  await h.call("bg_wait", { jobIds: [jobId], waitMode: "all", waitTimeoutSeconds: 2 });
  await rm(start.details.job.logPath);
  for (let i = 0; i < 2; i++) {
    try { await h.call("bg_output", { jobId, cursor: `${jobId}:0` }); throw new Error("expected failure"); } catch (error: any) {
      expect(JSON.parse(error.message)).toMatchObject({ code: "OUTPUT_UNAVAILABLE", retryUnchanged: false, nextCalls: [] });
    }
  }
  expect((await h.call("bg_status", { jobId })).details.nextCalls).toEqual([]);
  expect((await h.call("bg_list", {})).details.nextCalls).toEqual([]);
  const waited = await h.call("bg_wait", { jobIds: [jobId], waitMode: "all", waitTimeoutSeconds: 2 });
  expect(waited.details.completions[0].outputError).toContain("missing");
  expect(waited.details.nextCalls).toEqual([]);
}));

test("capacity rejection is repairable after settlement without changing launchKey", async () => fixture(async h => {
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) ids.push((await h.call("bg_start", { launchKey: `held-${i}`, command: "sleep 30", notify: "off" })).details.jobId);
  const args = { launchKey: "after-capacity", command: "printf repaired", notify: "off" };
  for (let i = 0; i < 2; i++) {
    try { await h.call("bg_start", args); throw new Error("expected rejection"); } catch (error: any) {
      const failure = JSON.parse(error.message);
      expect(failure).toMatchObject({ code: "CAPACITY_REACHED", effect: "not_started", retryUnchanged: false });
      expect(failure.nextCalls[0].tool).toBe("bg_wait");
    }
  }
  expect((await h.call("bg_list", {})).details.jobs).toHaveLength(4);
  await h.call("bg_cancel", { jobIds: [ids[0]] });
  const accepted = await h.call("bg_start", args);
  expect(accepted.details.jobId).toBeTruthy();
  await h.call("bg_wait", { jobIds: [accepted.details.jobId], waitMode: "all", waitTimeoutSeconds: 2 });
}));

test("wait/cancel/mute affect only explicit IDs and validate whole selection before effects", async () => fixture(async h => {
  const first = (await h.call("bg_start", { launchKey: "one", command: "sleep 30", notify: "off" })).details.jobId;
  const second = (await h.call("bg_start", { launchKey: "two", command: "sleep 30" })).details.jobId;
  await expect(h.call("bg_cancel", { jobIds: [first, "missing"] })).rejects.toThrow('"code":"UNKNOWN_JOB"');
  expect((await h.call("bg_status", { jobId: first })).details.job.stopReason).toBeUndefined();
  await h.call("bg_cancel", { jobIds: [first] });
  const waited = await h.call("bg_wait", { jobIds: [first], waitMode: "any", waitTimeoutSeconds: 1 });
  expect(waited.details.running).toEqual([]);
  expect(waited.details.completed.map((job: any) => job.id)).toEqual([first]);
  const unchanged = (await h.call("bg_status", { jobId: second })).details.job;
  expect(unchanged.stopReason).toBeUndefined();
  expect(unchanged.notify).toBe("always");
  await h.call("bg_mute_notifications", { jobIds: [second] });
  expect((await h.call("bg_status", { jobId: second })).details.job.notify).toBe("off");
}));

test("busy completions share one append-only boundary, not a late follow-up wake", async () => fixture(async h => {
  await h.events.before_agent_start({}, h.ctx); h.idle(false);
  await h.call("bg_start", { launchKey: "printf first", command: "printf first" });
  await h.call("bg_start", { launchKey: "printf second; exit 3", command: "printf second; exit 3" });
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
  await h.call("bg_start", { launchKey: "printf one", command: "printf one" });
  await h.call("bg_start", { launchKey: "printf two", command: "printf two" });
  await h.settled(2); await Bun.sleep(150);
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0].message.details.completions).toHaveLength(2);
  expect(h.sent[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
}));

test("wait returns output and queued completions exactly once", async () => fixture(async h => {
  await h.events.before_agent_start({}, h.ctx); h.idle(false);
  await h.call("bg_start", { launchKey: "printf already", command: "printf already" }); await h.settled(1);
  await h.call("bg_start", { launchKey: "sleep 0.02; printf waited", command: "sleep 0.02; printf waited" });
  const ids = (await h.call("bg_list", {})).details.jobs.map((job: any) => job.id);
  const result = await h.call("bg_wait", { jobIds: ids, waitMode: "all", waitTimeoutSeconds: 2 });
  expect(result.details.completions).toHaveLength(2);
  expect(result.content[0].text).toContain("waited"); expect(result.content[0].text).toContain("already");
  expect(await h.events.turn_end({ entries: [], message: { role: "assistant", stopReason: "stop" } }, h.ctx)).toBeUndefined();
  expect(h.sent).toHaveLength(0);
}));

test("abort suppresses late wakes, preserves observations for the next explicit prompt", async () => fixture(async h => {
  await h.events.before_agent_start({}, h.ctx);
  await h.call("bg_start", { launchKey: "sleep 0.02; printf after-abort", command: "sleep 0.02; printf after-abort" });
  await h.events.agent_end({ messages: [{ role: "assistant", stopReason: "aborted" }] });
  await h.settled(1); await Bun.sleep(150);
  expect(h.sent).toHaveLength(0);
  const next = await h.events.before_agent_start({}, h.ctx);
  expect(next.message.content).toContain("after-abort");
}));

test("mute by selected ID silences a settled completion still awaiting delivery", async () => fixture(async h => {
  await h.events.before_agent_start({}, h.ctx);
  const started = await h.call("bg_start", { launchKey: "printf ignored", command: "printf ignored" });
  await h.settled(1);
  const ignored = await h.call("bg_mute_notifications", { jobIds: [started.details.job.id] });
  expect(ignored.details.jobs[0].notify).toBe("off");
  expect(await h.events.turn_end({ entries: [], message: { role: "assistant", stopReason: "stop" } }, h.ctx)).toBeUndefined();
  expect(h.sent).toHaveLength(0);
}));

test("branch changes and shutdown fence queued idle delivery", async () => fixture(async h => {
  await h.call("bg_start", { launchKey: "printf old-branch", command: "printf old-branch" }); await h.settled(1);
  await h.events.session_tree({}, h.ctx); await Bun.sleep(150);
  expect(h.sent).toHaveLength(0);
  await h.call("bg_start", { launchKey: "printf before-reload", command: "printf before-reload" }); await h.settled(2);
  await h.events.session_shutdown({}, h.ctx); await h.events.session_start({}, h.ctx); await Bun.sleep(150);
  expect(h.sent).toHaveLength(0);
}));
