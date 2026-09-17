import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, readdir, utimes, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { serve } from "../lib/switchboard/server.ts";
import { BoardRuntime, WakeHub } from "../lib/switchboard/runtime.ts";
import { BoardClient, ensureService, rpc } from "../lib/switchboard/client.ts";
import { exposure, participantCounts, projectObservations, type Observation } from "../lib/switchboard/context.ts";
import { secret, hash, privateFile } from "../lib/switchboard/shared.ts";

async function until(predicate: () => boolean) { for (let i = 0; i < 200; i++) { if (predicate()) return; await Bun.sleep(10); } throw new Error("Timed out waiting for fixture state"); }
const user = (content: string, timestamp = 1): any => ({ role: "user", content, timestamp });
const wire = (messages: any[]) => convertToLlm(messages).map(m => JSON.stringify(m)).join("\n");

test("opt-out runtime: default registration, metadata-only hints, reload binding, project/session controls", async () => {
  const root = await mkdtemp(join(tmpdir(), "switchboard-adapter-"));
  const paths = { root, socket: join(root, "board.sock") };
  const board = await serve(paths);
  const live: BoardRuntime[] = [];
  const make = (sessionId: string, mode = "tui", disabled = false) => {
    const r = new BoardRuntime({ paths, sessionId, cwd: root, name: sessionId, mode, model: `fixture/${sessionId}`, disabled, ensure: async () => {}, intervalMs: 100 }); live.push(r); return r;
  };
  try {
    const a = make("a"), b = make("b");
    await a.start(); await b.start(); await until(() => a.snapshot?.total === 1 && b.snapshot?.total === 1);
    expect(a.snapshot?.peers[0]?.model).toBe("fixture/b");
    expect(exposure(a)?.roster).toMatchObject({ cards: [{ model: "fixture/b" }] });
    expect(exposure(a)!.relevant).toBe(true);
    const m = await b.requireClient().send("test-mail", { recipient: a.card!.id, body: "DO NOT AUTO-INJECT THIS BODY" }) as { id: string };
    await until(() => a.snapshot?.pending === 1);
    expect(JSON.stringify(exposure(a))).not.toContain("DO NOT AUTO-INJECT");
    expect(exposure(a)!.hints[0]!.id).toBe(m.id);
    await a.hint([m.id]); expect(exposure(a)!.hints).toHaveLength(0);
    await a.configure("manual"); expect(exposure(a)!.key).toBe("inactive"); expect(a.state).toBe("online");
    const original = a.card!.id, originalHandle = a.card!.handle; await a.close();
    const resumed = make("a"); await resumed.start(); expect(resumed.card!.id).toBe(original); expect(resumed.manual).toBe(true);
    expect(resumed.card!.handle).toBe(originalHandle);
    expect(resumed.binding!.hinted).toContain(m.id);
    await resumed.configure("off"); expect(resumed.state).toBe("off");
    resumed.update({ summary: "tree navigated" }); await resumed.sync(); expect(resumed.state).toBe("off");
    await resumed.configure("on"); expect(resumed.state).toBe("online");
    await b.configure("project-off"); await resumed.sync(); expect(resumed.state).toBe("off");
    await b.configure("project-on"); await resumed.sync(); expect(resumed.state).toBe("online");
    const fork = make("fork"); await fork.start(); expect(fork.card!.id).not.toBe(original); expect(fork.binding!.hinted).toBeUndefined();
    const headless = make("unprovisioned", "print"); await headless.start(); expect(headless.state).toBe("off"); expect(headless.client).toBeUndefined();
    const off = make("disabled", "tui", true); await off.start(); expect(off.client).toBeUndefined();
    // No registration content comes from a prompt/transcript. Name hooks are explicit.
    const bHandle = b.card!.handle;
    b.update({ name: "", summary: "" }); await b.sync();
    expect(b.card!.name).toBe(bHandle);
    b.update({ name: "renamed", summary: "declared task" }); await b.sync();
    expect(b.card!.handle).toBe(bHandle);
    await until(() => resumed.snapshot?.peers.some(p => p.name === "renamed") === true);
    b.update({ model: "fixture/beta" }); await b.sync();
    await until(() => resumed.snapshot?.peers.some(p => p.model === "fixture/beta") === true);
  } finally { await Promise.all(live.map(r => r.close())); await board.close(); await rm(root, { recursive: true, force: true }); }
});

test("reload-all queues every other connected agent once for programmatic non-interrupting reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "switchboard-reload-"));
  const paths = { root, socket: join(root, "board.sock") };
  const board = await serve(paths);
  let queued = 0;
  const a = new BoardRuntime({ paths, sessionId: "a", cwd: root, name: "a", mode: "tui", ensure: async () => {}, intervalMs: 100, onReload: () => { queued++; } });
  const b = new BoardRuntime({ paths, sessionId: "b", cwd: root, name: "b", mode: "tui", ensure: async () => {}, intervalMs: 100 });
  try {
    await a.start(); await b.start();
    await until(() => a.snapshot?.total === 1 && b.snapshot?.total === 1);
    await expect(b.requireClient().queueReloadAll()).resolves.toEqual({ queued: 1 });
    await until(() => queued === 1);
    await a.refresh();
    expect(queued).toBe(1);
    expect(a.snapshot?.reloadPending).toBe(false);
  } finally { await a.close(); await b.close(); await board.close(); await rm(root, { recursive: true, force: true }); }
});

test("participant counts separate direct subagents from peers", () => {
  const own = { id: "p_self" } as any;
  const cards = [
    { id: "p_peer" },
    { id: "p_child_a", parentId: "p_self" },
    { id: "p_child_b", parentId: "p_self" },
  ] as any[];
  expect(participantCounts(cards, own)).toEqual({ peers: 1, subagents: 2 });
  expect(participantCounts(cards)).toEqual({ peers: 3, subagents: 0 });
});

test("append-only observations: quiet alone, stable wire prefixes, retries, forks, compaction, complete tool pairs", () => {
  const journal: Observation[] = [];
  const base = [user("start")];
  const none = { key: "empty", roster: [], hints: [], relevant: false };
  const active = { key: "peers", roster: [{ name: "peer" }], hints: [], relevant: true };
  const project = (messages: any[], desired: any = active, epoch = "root", session = "a", now = 100_000) => projectObservations(messages, journal, session, epoch, desired, now, e => journal.push(e));
  expect(project(base, none).messages).toEqual(base); expect(journal).toHaveLength(0);
  const first = project(base).messages;
  expect(project(base).messages).toEqual(first); expect(journal).toHaveLength(1);
  const longer = [...base, user("more", 2)];
  expect(wire(project(longer).messages).startsWith(wire(first) + "\n")).toBe(true);
  const mail = { ...active, hints: [{ id: "m_1", sender: "p_b", kind: "question" }] };
  project(longer, mail);
  const n = journal.length; project(longer, mail); expect(journal).toHaveLength(n);
  const compacted = project([user("compacted", 3)], active, "compact-1").messages;
  expect(compacted.filter((m: any) => m.role === "custom")).toHaveLength(1);
  expect(JSON.stringify(compacted)).not.toContain("m_1");
  expect(project(base, none, "root", "fork").messages).toEqual(base);
  const paired: any[] = [...longer, { role: "assistant", content: [{ type: "toolCall", id: "t", name: "read", arguments: {} }], timestamp: 4 }, { role: "toolResult", toolCallId: "t", toolName: "read", content: [], isError: false, timestamp: 5 }];
  const output = project(paired, { ...active, key: "changed" }, "root", "a", 200_000).messages;
  const callIndex = output.findIndex((m: any) => m.role === "assistant");
  expect(output[callIndex + 1]!.role).toBe("toolResult");
  expect(wire(output)).toContain("not user instructions");
  project(paired, { ...none, key: "inactive" }, "root", "a", 200_001);
  expect(journal.at(-1)!.rosterKey).toBe("inactive");
});

test("interruptible wait yields on mail/user input, checks already pending work, and cleans up on timeout/abort", async () => {
  const hub = new WakeHub();
  let waiting = hub.wait(1000, () => undefined); hub.emit("mail"); expect(await waiting).toBe("mail");
  waiting = hub.wait(1000, () => undefined); hub.emit("user_input"); expect(await waiting).toBe("user_input");
  expect(await hub.wait(1000, () => "mail")).toBe("mail");
  expect(await hub.wait(1, () => undefined)).toBe("timeout");
  const abort = new AbortController(); waiting = hub.wait(1000, () => undefined, abort.signal); abort.abort(new Error("fixture abort"));
  await expect(waiting).rejects.toThrow("fixture abort"); expect(hub.listeners.size).toBe(0);
});

test("default autostart is singleton under concurrent clients, actual Node daemon; isolated paths only", async () => {
  const root = await mkdtemp(join(tmpdir(), "switchboard-bootstrap-"));
  const paths = { root, socket: join(root, "board.sock") }; let pid: number | undefined;
  try {
    await Promise.all([ensureService(paths), ensureService(paths), ensureService(paths)]);
    const health = await rpc<{ pid: number }>(paths, ""); pid = health.pid;
    expect(pid).toBeGreaterThan(0); expect(pid).not.toBe(process.pid);
    await ensureService(paths); expect((await rpc<{ pid: number }>(paths, "")).pid).toBe(pid);
  } finally {
    if (pid) { process.kill(pid, "SIGTERM"); await until(() => { try { process.kill(pid!, 0); return false; } catch { return true; } }); }
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("private leaf files and old outbox retries fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "switchboard-private-"));
  const paths = { root, socket: join(root, "board.sock") };
  const board = await serve(paths);
  const client = new BoardClient(paths, secret()), other = new BoardClient(paths, secret());
  try {
    const card = { project: root, worktree: root, cwd: root, name: "fixture", summary: "", activity: "idle" as const };
    await client.connect(card); const target = await other.connect(card);
    await client.send("old-operation", { recipient: target.id, body: "retained" });
    const dir = join(root, "outbox", hash(client.token));
    const file = join(dir, (await readdir(dir))[0]!);
    const old = new Date(Date.now() - 15 * 86_400_000); await utimes(file, old, old);
    await expect(client.retry("old-operation")).rejects.toThrow("horizon expired");
    expect((await other.snapshot()).pending).toBe(1);
    const publicFile = join(root, "public.json"); await writeFile(publicFile, "{}", { mode: 0o644 }); await chmod(publicFile, 0o644);
    await expect(privateFile(publicFile)).rejects.toThrow("private");
    await chmod(publicFile, 0o600); const alias = join(root, "alias.json"); await symlink(publicFile, alias);
    await expect(privateFile(alias)).rejects.toThrow("private");
  } finally { await board.close(); await rm(root, { recursive: true, force: true }); }
});

test("real Node/Pi SDK: headless worker roster + tool wait, mail/user interruption, no idle inference", async () => {
  const root = await mkdtemp(join(tmpdir(), "switchboard-sdk-"));
  try {
    const proc = spawn("node", [fileURLToPath(new URL("./fixtures/switchboard-sdk.ts", import.meta.url)), root], { env: { PATH: process.env.PATH, HOME: root }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; proc.stdout!.on("data", b => { stdout += b; }); proc.stderr!.on("data", b => { stderr += b; });
    const code = await new Promise<number | null>((resolve, reject) => { const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error(`SDK timeout: ${stderr}`)); }, 15_000); proc.once("exit", c => { clearTimeout(timer); resolve(c); }); proc.once("error", reject); });
    expect({ code, stderr: code ? stderr : "" }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain('"mailWait":true'); expect(stdout).toContain('"userWait":true');
  } finally { await rm(root, { recursive: true, force: true }); }
}, 20_000);
