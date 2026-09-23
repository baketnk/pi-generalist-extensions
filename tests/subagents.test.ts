import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { freezeSnapshot, SnapshotShelf } from "../lib/subagents/snapshot.ts";
import { InspectFiles } from "../lib/subagents/files.ts";
import { SubagentRuntime, runCard } from "../lib/subagents/runtime.ts";
import { type Launch } from "../lib/subagents/types.ts";
import { BoardClient } from "../lib/switchboard/client.ts";
import { serve } from "../lib/switchboard/server.ts";
import { secret } from "../lib/switchboard/shared.ts";
import { provisionWorker, registerBoardHost, retireWorker } from "../lib/subagents/bridge.ts";
import type { BoardRuntime } from "../lib/switchboard/runtime.ts";
import { openRuns } from "../lib/subagents/ui.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChildProcess } from "node:child_process";

const roots: string[] = [], runtimes: SubagentRuntime[] = [];
afterEach(async () => { for (const r of runtimes.splice(0)) await r.close().catch(() => {}); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup(worker = "subagent-ipc.ts", maxActive = 4) {
  const root = await mkdtemp(join(tmpdir(), "pi-subagents-test-")); roots.push(root);
  const cwd = join(root, "repo"); await mkdir(cwd); await writeFile(join(cwd, "README.md"), "fixture evidence\n");
  const runtime = new SubagentRuntime({ home: join(root, "state"), owner: "synthetic-parent", maxActive, workerEntry: fileURLToPath(new URL(`./fixtures/${worker}`, import.meta.url)) }); runtimes.push(runtime);
  const request = (task = "hold", operation = task): Omit<Launch, "id" | "version" | "owner"> => ({ cwd, agentDir: join(root, "config"), task, label: task, operation, mode: "fresh", model: { provider: "synthetic", id: "inspect" }, thinking: "off", instructions: [], seconds: 10, maxTurns: 4, maxTools: 12, maxOutputTokens: 1024 });
  return { root, cwd, runtime, request };
}
async function until(fn: () => boolean, ms = 5000) { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error("Fixture timed out"); await Bun.sleep(10); } }

test("fork captures final projection, isolates selected ancestry, and rejects half/orphan batches or failed latest projection", () => {
  const manager = SessionManager.inMemory("/tmp"), shelf = new SnapshotShelf();
  const user: AgentMessage = { role: "user", content: "synthetic parent marker", timestamp: 1 };
  const anchor = manager.appendMessage(user), original = JSON.stringify(manager.getEntries());
  const event = { type: "context_snapshot" as const, messages: [user], leafId: anchor, contextErrors: 0, providerRequestHooks: false };
  shelf.capture(event, manager.getSessionId(), manager.getBranch());
  event.messages.push({ role: "user", content: "later unrelated mutation", timestamp: 2 });
  const snap = shelf.select(manager.getSessionId(), manager.getBranch());
  expect(snap.messages).toEqual([user]); expect(JSON.stringify(manager.getEntries())).toBe(original);
  expect(() => shelf.select("another session", manager.getBranch())).toThrow();
  expect(() => shelf.select(manager.getSessionId(), [], anchor)).toThrow();
  const orphan = { role: "toolResult", toolCallId: "missing", toolName: "read", content: [{ type: "text", text: "fake" }], isError: false, timestamp: 3 } as AgentMessage;
  expect(() => freezeSnapshot({ ...event, messages: [orphan] }, manager.getSessionId(), manager.getBranch())).toThrow("orphan");
  const partial = { role: "assistant", content: [{ type: "toolCall", name: "read", id: "pending", arguments: {} }], timestamp: 3 } as AgentMessage;
  expect(() => freezeSnapshot({ ...event, messages: [user, partial] }, manager.getSessionId(), manager.getBranch())).toThrow("unfinished");
  shelf.capture({ ...event, contextErrors: 1 }, manager.getSessionId(), manager.getBranch());
  expect(() => shelf.select(manager.getSessionId(), manager.getBranch())).toThrow("Latest request");
  expect(shelf.select(manager.getSessionId(), manager.getBranch(), anchor).messages).toEqual([user]);
});

test("inspect grants block parent traversal, symlink/hardlink/private/binary/large files", async () => {
  const { cwd, root } = await setup(), files = new InspectFiles(cwd);
  await writeFile(join(root, "outside"), "private outside"); await symlink(join(root, "outside"), join(cwd, "alias"));
  await link(join(root, "outside"), join(cwd, "hard")); await writeFile(join(cwd, ".env"), "SECRET");
  await writeFile(join(cwd, "binary"), Buffer.from([0, 1])); await writeFile(join(cwd, "large"), Buffer.alloc(1024 * 1024 + 1, 1));
  await writeFile(join(cwd, "invalid-utf8"), Buffer.from([255]));
  for (const path of ["../outside", "alias", "hard", ".env", "binary", "large", "invalid-utf8"]) await expect(files.text(path)).rejects.toThrow();
  expect(await files.text("README.md")).toBe("fixture evidence\n");
  expect((await files.search("fixture")).matches).toEqual(["README.md:1: fixture evidence"]);
  const privateRoot = join(cwd, "custom-runner-state"); await mkdir(privateRoot); await writeFile(join(privateRoot, "worker.json"), "PRIVATE_CAPABILITY");
  const scoped = new InspectFiles(cwd, [privateRoot]);
  await expect(scoped.text("custom-runner-state/worker.json")).rejects.toThrow("private");
  expect((await scoped.list(".")).some(e => e.name === "custom-runner-state")).toBe(false);
  expect((await scoped.search("PRIVATE_CAPABILITY")).matches).toEqual([]);
});

test("worker count is agent chosen: zero, one, two, four, and at-ceiling rejection", async () => {
  for (const count of [0, 1, 2, 4]) {
    const { runtime, request } = await setup("subagent-ipc.ts", count);
    expect(runtime.activeCount).toBe(0);
    const runs = await Promise.all(Array.from({ length: count }, (_, i) => runtime.start(request("hold", `op-${i}`))));
    expect(runtime.activeCount).toBe(count);
    await expect(runtime.start(request("hold", "overflow"))).rejects.toThrow("ceiling");
    if (runs[0]) expect((await runtime.start(request("hold", "op-0"))).id).toBe(runs[0].id);
    await runtime.close(); expect(runtime.activeCount).toBe(0);
  }
});

test("configured worker limits above defaults are accepted and frozen into launch intent", async () => {
  const { runtime, request } = await setup();
  const chosen = { ...request("hold"), maxTurns: 48, maxTools: 160 };
  const run = await runtime.start(chosen);
  expect((await runtime.store.launch(run.id)).maxTurns).toBe(48);
  expect((await runtime.store.launch(run.id)).maxTools).toBe(160);
  expect((await runtime.start(chosen)).id).toBe(run.id);
  await expect(runtime.start({ ...chosen, maxTurns: 49 })).rejects.toThrow("different intent");
  await expect(runtime.start({ ...request("too-many-turns"), maxTurns: 1001 })).rejects.toThrow("resource limit");
  await expect(runtime.start({ ...request("too-many-tools"), maxTools: 4001 })).rejects.toThrow("resource limit");
});

test("progress peeking, parked clarification, join wake, report collection and observed cleanup are distinct", async () => {
  const { runtime, request } = await setup();
  const run = await runtime.start(request("block"));
  expect((await runtime.join([run.id], 3)).reason).toBe("needs-input");
  const page = await runtime.peek(run.id); expect(page.events.some(e => e.kind === "progress")).toBe(true);
  expect(runtime.status(run.id).collectedAt).toBeUndefined();
  await expect(runtime.input(run.id, "wrong", "scope")).rejects.toThrow("matching");
  await runtime.input(run.id, "question-1", "scope"); await until(() => runtime.status(run.id).process === "exited");
  expect(runtime.status(run.id).taskState).toBe("reported");
  expect((await runtime.collect(run.id)).record.report?.summary).toBe("Synthetic result");
  const collected = runtime.status(run.id).collectedAt;
  expect((await runtime.collect(run.id)).record.collectedAt).toBe(collected);
  expect((await runtime.peek(run.id, page.next)).events).toEqual([]);
  expect((await stat(runtime.store.path(run.id, "record.json"))).mode & 0o077).toBe(0);
  await expect(runtime.start({ ...request("block"), task: "changed" })).rejects.toThrow("different intent");
  const hold = await runtime.start(request("hold")); const joining = runtime.join([hold.id], 3); runtime.interruptJoin();
  expect((await joining).reason).toBe("interrupted");
});

test("deadline, SIGKILL escalation, process crash, stop fences queued launches and same-session ownership", async () => {
  const { runtime, request, root } = await setup();
  const crashed = await runtime.start(request("crash")); await until(() => runtime.status(crashed.id).process === "exited");
  expect(runtime.status(crashed.id).exitCode).toBe(7); expect(runtime.status(crashed.id).taskState).toBe("failed");
  const ignored = await runtime.start({ ...request("ignore"), seconds: 1 });
  await until(() => runtime.status(ignored.id).process === "exited");
  expect(runtime.status(ignored.id).taskState).toBe("timed-out"); expect(runtime.status(ignored.id).signal).toBe("SIGKILL");
  const duplicate = new SubagentRuntime({ home: join(root, "state"), owner: "synthetic-parent" });
  await expect(duplicate.initialize()).rejects.toThrow("locked");
  const queued = runtime.start(request("hold")); await runtime.cancelAll("stop while starting");
  await expect(queued).rejects.toThrow("invalidated");
  await runtime.close();
  const resumed = new SubagentRuntime({ home: join(root, "state"), owner: "synthetic-parent" }); runtimes.push(resumed); await resumed.initialize();
  expect(resumed.list()).toHaveLength(2); expect(resumed.activeCount).toBe(0);
});

test("actual SDK child: fork payload fidelity, explicit tools, fresh usage, parked input, no retries or sibling work after report", async () => {
  const { runtime, request } = await setup("subagent-sdk-worker.ts");
  const manager = SessionManager.inMemory("/tmp"), user = { role: "user" as const, content: "SYNTHETIC_FORK_MARKER", timestamp: 1 };
  const anchor = manager.appendMessage(user);
  const projected: AgentMessage[] = [
    { role: "compactionSummary", summary: "SYNTHETIC_COMPACTED_CONTEXT", tokensBefore: 2000, timestamp: 0 },
    { role: "custom", customType: "workpad-snapshot-v2", content: "SYNTHETIC_WORKPAD_SNAPSHOT", display: false, timestamp: 1 }, user,
  ];
  const snapshot = freezeSnapshot({ type: "context_snapshot", messages: projected, leafId: anchor, contextErrors: 0, providerRequestHooks: false }, manager.getSessionId(), manager.getBranch());
  for (const task of ["inspect", "block", "silent", "budget", "forbidden", "keepalive"]) {
    const run = await runtime.start({ ...request(task), ...(task === "inspect" ? { mode: "fork" as const, snapshot } : {}), maxTurns: task === "budget" ? 2 : 4 });
    const joined = await runtime.join([run.id], 5);
    if (task === "block") { expect(joined.reason).toBe("needs-input"); const before = runtime.status(run.id).turns; await Bun.sleep(50); expect(runtime.status(run.id).turns).toBe(before); await runtime.input(run.id, runtime.status(run.id).question!.id, "fixture scope"); }
    await until(() => runtime.status(run.id).process === "exited");
    const record = runtime.status(run.id), events = await runtime.peek(run.id, 0, 100);
    expect(record.persistenceError).toBeUndefined();
    expect(record.taskState, JSON.stringify({ record, events })).toBe(task === "silent" ? "incomplete" : task === "budget" ? "budget-exceeded" : "reported");
    const payloads = (await readFile(join(dirname(runtime.store.path(run.id, "launch.json")), "payloads.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(payloads.length).toBe(task === "silent" ? 1 : 2);
    expect(JSON.stringify(payloads[0].context).includes("SYNTHETIC_FORK_MARKER")).toBe(task === "inspect");
    expect(payloads[0].context.tools.map((t: { name: string }) => t.name).sort()).toEqual(["grep", "ls", "needs_input", "progress", "read", "report"]);
    expect(payloads[0].options.maxTokens).toBe(1024);
    expect(record.usage.input).toBe(payloads.length * 12); expect(record.usage.output).toBe(payloads.length * 3);
    expect(events.events.filter(e => e.kind === "tool-start" && e.text?.includes("SHOULD_NOT_EXIST"))).toHaveLength(0);
    if (task === "inspect") {
      expect(JSON.stringify(payloads[1])).toContain("fixture evidence");
      expect(JSON.stringify(payloads[0])).toContain("SYNTHETIC_COMPACTED_CONTEXT");
      expect(JSON.stringify(payloads[0])).toContain("SYNTHETIC_WORKPAD_SNAPSHOT");
      expect(payloads[1].context.messages.slice(0, payloads[0].context.messages.length)).toEqual(payloads[0].context.messages);
      expect(await readFile(record.sessionFile!, "utf8")).toContain("subagents:fork-context:v1");
    }
  }
}, 20000);

test("real SDK worker joins only its provisioned mailbox; parent retirement follows observed exit", async () => {
  const { runtime, request, root, cwd } = await setup("subagent-sdk-worker.ts");
  const paths = { root: join(root, "board"), socket: join(root, "board.sock") }, server = await serve(paths);
  const parent = new BoardClient(paths, secret());
  const parentCard = await parent.connect({ cwd, project: cwd, worktree: cwd, name: "parent", summary: "fixture", activity: "working" });
  let capability = "";
  const handlers = new Map<string, (request: unknown) => void>();
  const pi = { events: {
    on(name: string, fn: (request: unknown) => void) { handlers.set(name, fn); return () => { handlers.delete(name); }; },
    emit(name: string, request: unknown) { handlers.get(name)?.(request); },
  } } as unknown as ExtensionAPI;
  const hostRuntime = { state: "online", closed: false, start: async () => {}, requireClient: () => parent, card: parentCard, options: { paths } } as unknown as BoardRuntime;
  const unregister = registerBoardHost(pi, () => hostRuntime);
  pi.events.emit("generalist:subagents:board-host:v1", { accept: (host: object) => { expect(Object.keys(host).sort()).toEqual(["provision", "retire"]); } });
  runtime.options.provision = async (id, file) => {
    const child = await provisionWorker(pi, id, file);
    capability = JSON.parse(await readFile(file, "utf8")).token;
    expect(await provisionWorker(pi, id, file)).toEqual(child);
    return child;
  };
  runtime.options.retire = id => retireWorker(pi, id);
  try {
    const run = await runtime.start(request("block"));
    expect((await runtime.join([run.id], 5)).reason).toBe("needs-input");
    const child = server.store.inspect(parent.token, runtime.status(run.id).participant!);
    expect(child.parentId).toBe(parentCard.id); expect(child.runId).toBe(run.id); expect(child.online).toBe(true);
    expect(JSON.stringify(runtime.status(run.id))).not.toContain(capability);
    expect(JSON.stringify(await runtime.peek(run.id))).not.toContain(capability);
    await runtime.cancel(run.id);
    expect(runtime.status(run.id).cleanup).toBe("observed"); expect(runtime.status(run.id).coordinationError).toBeUndefined();
    expect(() => server.store.auth(capability)).toThrow("revoked");
  } finally { await runtime.close(); unregister(); await server.close(); }
});

test("SDK context admission makes no provider request; lost parent IPC stops parked inference", async () => {
  const { runtime, request } = await setup("subagent-sdk-worker.ts");
  await expect(runtime.start({ ...request(), instructions: [{ path: "AGENTS.md", content: "x".repeat(33000) }] })).rejects.toThrow("32 KiB");
  const oversized = await runtime.start(request("context-overflow"));
  await until(() => runtime.status(oversized.id).process === "exited");
  expect(runtime.status(oversized.id).taskState).toBe("budget-exceeded");
  expect(runtime.status(oversized.id).usage.input).toBe(0);
  await expect(readFile(join(dirname(runtime.store.path(oversized.id, "launch.json")), "payloads.jsonl"))).rejects.toThrow("ENOENT");
  const parked = await runtime.start(request("block")); await runtime.join([parked.id], 5);
  // Trusted fixture fault injection: sever only the channel of this owned ChildProcess.
  const owned = (runtime as unknown as { live: Map<string, { child: ChildProcess }> }).live.get(parked.id)!;
  owned.child.disconnect();
  await until(() => runtime.status(parked.id).process === "exited");
  expect(runtime.status(parked.id).cleanup).toBe("observed");
  expect(runtime.status(parked.id).report).toBeUndefined();
});

test("model-free peek renders bounded Unicode, updates, closes without collecting/cancelling, and dismisses on runtime shutdown", async () => {
  const { runtime, request } = await setup();
  const run = await runtime.start({ ...request("block"), label: "Waiting for scope" }); await runtime.join([run.id], 3);
  let component: any, done!: () => void, closed = false;
  const ctx = { mode: "tui", hasUI: true, ui: { custom: (factory: Function) => new Promise<void>(resolve => {
    done = () => { closed = true; resolve(); };
    component = factory({ terminal: { rows: 12 }, requestRender() {} }, { fg: (_color: string, text: string) => text }, { matches: (data: string, name: string) => data === name }, done);
  }) } } as unknown as ExtensionContext;
  const view = openRuns(ctx, runtime);
  for (const width of [1, 12, 45, 100]) for (const line of component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  const list = component.render(100).join("\n");
  expect(runtime.status(run.id).taskSummary).toBe("block");
  expect(list).toContain("╭"); expect(list).toContain("╰"); expect(list).toContain("block");
  component.handleInput("tui.select.confirm"); await Bun.sleep(15);
  expect(component.render(100).join("\n")).toContain("needs-input");
  component.handleInput("tui.select.cancel"); await view;
  expect(closed).toBe(true); expect(runtime.status(run.id).taskState).toBe("needs-input"); expect(runtime.status(run.id).collectedAt).toBeUndefined();
  closed = false; const next = openRuns(ctx, runtime); await runtime.close(); await next; expect(closed).toBe(true);
});

test("actual SDK worker uses resolved smaller/explicit provider models without expanding tools or mutating fork data", async () => {
  const { runtime, request } = await setup("subagent-sdk-worker.ts");
  const manager = SessionManager.inMemory("/tmp");
  const user = { role: "user" as const, content: "SYNTHETIC_MODEL_ROUTING_FORK", timestamp: 1 };
  const anchor = manager.appendMessage(user);
  const snapshot = freezeSnapshot({ type: "context_snapshot", messages: [user], leafId: anchor, contextErrors: 0, providerRequestHooks: false }, manager.getSessionId(), manager.getBranch());
  const frozen = JSON.stringify(snapshot);
  for (const model of [{ provider: "synthetic", id: "small" }, { provider: "other-synthetic", id: "small" }]) {
    const run = await runtime.start({ ...request("inspect", `${model.provider}/${model.id}`), model, mode: "fork", snapshot });
    await until(() => runtime.status(run.id).process === "exited");
    expect(runtime.status(run.id).taskState).toBe("reported"); expect(runtime.status(run.id).model).toEqual(model);
    const payloads = (await readFile(join(dirname(runtime.store.path(run.id, "launch.json")), "payloads.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(payloads.every(p => JSON.stringify(p.model) === JSON.stringify(model))).toBe(true);
    expect(JSON.stringify(payloads[0].context)).toContain("SYNTHETIC_MODEL_ROUTING_FORK");
    expect(payloads[0].context.tools.map((t: { name: string }) => t.name).sort()).toEqual(["grep", "ls", "needs_input", "progress", "read", "report"]);
    expect(JSON.stringify(snapshot)).toBe(frozen);
  }
}, 10000);

test("worker-side unknown model and missing auth fail before inference; smaller context never falls back", async () => {
  const { runtime, request } = await setup("subagent-sdk-worker.ts");
  for (const model of [{ provider: "synthetic", id: "missing" }, { provider: "no-auth", id: "small" }]) {
    const run = await runtime.start({ ...request("inspect", `${model.provider}/${model.id}`), model });
    await until(() => runtime.status(run.id).process === "exited");
    expect(runtime.status(run.id).taskState).toBe("failed"); expect(runtime.status(run.id).usage.input).toBe(0);
    await expect(readFile(join(dirname(runtime.store.path(run.id, "launch.json")), "payloads.jsonl"))).rejects.toThrow("ENOENT");
  }
  const small = await runtime.start({ ...request("context-overflow"), model: { provider: "synthetic", id: "small" } });
  await until(() => runtime.status(small.id).process === "exited");
  expect(runtime.status(small.id).taskState).toBe("budget-exceeded"); expect(runtime.status(small.id).usage.input).toBe(0);
}, 10000);

test("permissions default read-only, persist, reconcile legacy intents and refuse escalation on retry", async () => {
  const { runtime, request } = await setup();
  const run = await runtime.start(request());
  expect(run.permissions).toBe("read-only");
  const path = runtime.store.path(run.id, "launch.json");
  const intent = JSON.parse(await readFile(path, "utf8"));
  expect(intent.permissions).toBe("read-only");
  delete intent.permissions; // A pre-permissions persisted launch must still reconcile.
  await writeFile(path, JSON.stringify(intent));
  expect((await runtime.start({ ...request(), permissions: "read-only" })).id).toBe(run.id);
  await expect(runtime.start({ ...request(), permissions: "implement" })).rejects.toThrow("different intent");
  await expect(runtime.start({ ...request(), permissions: "invalid" as any })).rejects.toThrow("Invalid worker permissions");
  const implementation = await runtime.start({ ...request("hold", "implementation"), permissions: "implement" });
  expect(runCard(implementation).permissions).toBe("implement");
  expect(JSON.parse(await readFile(runtime.store.path(implementation.id, "record.json"), "utf8")).permissions).toBe("implement");
});

test("actual SDK permissions enforce read-only and permit write/edit/tests for fresh and fork implement workers", async () => {
  for (const permissions of [undefined, "read-only", "implement"] as const) for (const mode of ["fresh", "fork"] as const) {
    const { runtime, request, cwd } = await setup("subagent-sdk-worker.ts");
    const manager = SessionManager.inMemory(cwd);
    const history = { role: "user" as const, content: "Historical request: implement changes using shell and edits.", timestamp: 1 };
    const anchor = manager.appendMessage(history);
    const snapshot = mode === "fork" ? freezeSnapshot({ type: "context_snapshot", messages: [history], leafId: anchor, contextErrors: 0, providerRequestHooks: false }, manager.getSessionId(), manager.getBranch()) : undefined;
    const run = await runtime.start({ ...request("implement"), mode, snapshot, permissions });
    await until(() => runtime.status(run.id).process === "exited");
    const record = runtime.status(run.id);
    expect(record.taskState, JSON.stringify(record)).toBe("reported");
    expect(record.permissions).toBe(permissions ?? "read-only");
    const payloads = (await readFile(join(dirname(runtime.store.path(run.id, "launch.json")), "payloads.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const names = payloads[0].context.tools.map((t: { name: string }) => t.name).sort();
    if (permissions === "implement") {
      expect(names).toEqual(["bash", "edit", "find", "grep", "ls", "needs_input", "progress", "read", "report", "write"]);
      expect(await readFile(join(cwd, "implemented.txt"), "utf8")).toBe("after\n");
      const shellResult = payloads[3].context.messages.find((m: any) => m.role === "toolResult" && m.toolName === "bash");
      expect(shellResult.isError).toBe(false);
      expect(shellResult.content).toEqual([{ type: "text", text: "CHECK_PASSED" }]);
      expect(payloads[0].context.systemPrompt).toContain("NOT a sandbox");
    } else {
      expect(names).toEqual(["grep", "ls", "needs_input", "progress", "read", "report"]);
      await expect(readFile(join(cwd, "implemented.txt"))).rejects.toThrow("ENOENT");
      expect(payloads[0].context.systemPrompt).toContain("No shell or edits");
    }
    for (const payload of payloads.slice(1)) {
      expect(payload.context.tools).toEqual(payloads[0].context.tools);
      expect(payload.context.systemPrompt).toBe(payloads[0].context.systemPrompt);
      expect(payload.context.messages.slice(0, payloads[0].context.messages.length)).toEqual(payloads[0].context.messages);
    }
    await expect(readFile(join(cwd, "SHOULD_NOT_EXIST"))).rejects.toThrow("ENOENT");
    expect(await readFile(join(cwd, "README.md"), "utf8")).toBe("fixture evidence\n");
    expect(await readFile(record.sessionFile!, "utf8")).toContain(`"permissions":"${permissions ?? "read-only"}"`);
  }
}, 20000);
