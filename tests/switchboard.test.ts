import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BoardStore } from "../lib/switchboard/store.ts";
import { BoardClient, bindingAt, rpc } from "../lib/switchboard/client.ts";
import { secret, projectAt, VERSION, type Snapshot } from "../lib/switchboard/shared.ts";
import { formatSwitchboard } from "../lib/switchboard/presentation.ts";

const card = (name: string, project = "/repo/.git") => ({ name, project, cwd: "/repo", worktree: "/repo", summary: "", activity: "idle" as const, model: "fixture/alpha" });
function fixture() {
  let now = 100_000;
  const store = new BoardStore(":memory:", () => now);
  const a = secret(), b = secret(), observer = secret();
  const pa = store.connect(a, { runtime: "a", card: card("a") });
  const pb = store.connect(b, { runtime: "b", card: card("b") });
  store.connect(observer, { runtime: "o", card: card("observer"), type: "observer" });
  return { store, a, b, observer, pa, pb, advance: (ms: number) => { now += ms; } };
}
describe("switchboard durable contract", () => {
  test("human presentation uses tables and explicit empty states instead of JSON", () => {
    const peers = formatSwitchboard("peers", { total: 1, omitted: 0, peers: [{ ...card("reviewer"), id: "p_1", type: "agent", online: true, updatedAt: 1, location: "same checkout", activity: "working" }] });
    expect(peers).toContain("Name"); expect(peers).toContain("Model"); expect(peers).toContain("fixture/alpha"); expect(peers).toContain("Activity"); expect(peers).toContain("reviewer");
    expect(peers).not.toContain('"peers"'); expect(peers).not.toContain("{");
    expect(formatSwitchboard("inbox", { pending: 0, messages: [] })).toBe("No messages");
  });
  test("client omits optional existingOnly unless fail-closed worker reconnect is requested", async () => {
    const client = new BoardClient({ root: "/unused", socket: "/unused" }, secret());
    const calls: Array<{ action: string; args: Record<string, unknown> }> = [];
    client.call = async (action: string, args: Record<string, unknown> = {}) => {
      calls.push({ action, args }); return {} as any;
    };
    await client.connect(card("normal"));
    await client.connect(card("worker"), "agent", undefined, true);
    expect(calls[0]).toEqual({ action: "connect", args: { card: card("normal"), type: "agent" } });
    expect(calls[1]).toEqual({ action: "connect", args: { card: card("worker"), type: "agent", existingOnly: true } });
  });
  test("directory scope, lease expiry, body privacy and observer restrictions", () => {
    const f = fixture(); try {
      f.store.connect(secret(), { runtime: "elsewhere", card: card("other", "/elsewhere") });
      const initial = f.store.snapshot(f.a);
      expect(initial.peers.map(p => p.name)).toEqual(["b"]);
      f.store.send(f.a, "a", { recipient: f.pb.id, key: "1", body: "private body" });
      expect(JSON.stringify(f.store.snapshot(f.observer))).not.toContain("private body");
      expect(f.store.snapshot(f.b).inbox[0]!.body).toBeUndefined();
      expect(() => f.store.send(f.observer, "o", { recipient: f.pa.id, key: "2", body: "no" })).toThrow("Observer");
      expect(() => f.store.read(f.observer, "o", f.store.snapshot(f.b).inbox[0]!.id, true)).toThrow("unavailable");
      f.advance(61_000);
      expect(f.store.snapshot(f.a).peers).toHaveLength(0);
      expect(f.store.snapshot(f.b).pending).toBe(1);
    } finally { f.store.close(); }
  });
  test("idempotency precedes quotas; changed keys fail, fetched and ack differ", () => {
    const f = fixture(); try {
      const envelope = { recipient: f.pb.id, key: "stable", body: "hello", kind: "question" };
      const m = f.store.send(f.a, "a", envelope);
      expect(f.store.send(f.a, "a", envelope).id).toBe(m.id);
      expect(() => f.store.send(f.a, "a", { ...envelope, body: "changed" })).toThrow("different content");
      expect(f.store.read(f.b, "b", m.id, true).fetchedAt).toBeDefined();
      expect(f.store.snapshot(f.b).pending).toBe(1);
      expect(() => f.store.ack(f.a, "a", m.id)).toThrow("recipient");
      const reply = f.store.send(f.b, "b", { key: "reply", recipient: f.pa.id, kind: "reply", replyTo: m.id, body: "yes" });
      expect(reply.replyTo).toBe(m.id);
      expect(f.store.snapshot(f.b).pending).toBe(1);
      f.store.ack(f.b, "b", m.id);
      expect(f.store.snapshot(f.b).pending).toBe(0);
      expect(() => f.store.send(f.a, "a", { ...envelope, key: "bad-reply", kind: "reply", replyTo: m.id })).toThrow("original sender");
    } finally { f.store.close(); }
  });
  test("expiry, prune, bounded bodies and revoked recipients", () => {
    const f = fixture(); try {
      expect(() => f.store.send(f.a, "a", { recipient: f.pb.id, key: "big", body: "界".repeat(6000) })).toThrow("UTF-8");
      const m = f.store.send(f.a, "a", { recipient: f.pb.id, key: "expire", body: "soon old", ttlSeconds: 1 });
      f.advance(1001); f.store.prune();
      expect(f.store.snapshot(f.b).pending).toBe(0);
      expect(f.store.read(f.b, "b", m.id, true).body).toBeNull();
      expect(f.store.send(f.a, "a", { recipient: f.pb.id, key: "expire", body: "soon old", ttlSeconds: 1 }).id).toBe(m.id);
      f.store.archive(f.b, "b");
      expect(() => f.store.snapshot(f.b)).toThrow("revoked");
      expect(() => f.store.send(f.a, "a", { recipient: f.pb.id, key: "late", body: "late" })).toThrow("recipient");
    } finally { f.store.close(); }
  });
  test("attachments fenced, no spoofed parent; worker capabilities don't grant parent inbox", () => {
    const f = fixture(); try {
      expect(() => f.store.connect(f.a, { runtime: "competitor", card: card("a") })).toThrow("another runtime");
      expect(() => f.store.connect(secret(), { runtime: "fake", card: { ...card("fake"), parentId: f.pa.id } })).toThrow("Unexpected");
      expect(() => f.store.connect(secret(), { runtime: "lost-worker", card: card("lost"), existingOnly: true })).toThrow("no longer exists");
      const worker = f.store.provision(f.a, "a", "run-1");
      const child = f.store.connect(worker.token, { runtime: "child", card: card("reviewer") });
      expect(child.parentId).toBe(f.pa.id);
      expect(child.runId).toBe("run-1");
      expect(() => f.store.provision(worker.token, "child", "recursive")).toThrow("top-level");
      const m = f.store.send(f.b, "b", { recipient: f.pa.id, key: "parent", body: "parent-only" });
      expect(() => f.store.read(worker.token, "child", m.id, true)).toThrow("unavailable");
      f.advance(61_000);
      f.store.connect(f.a, { runtime: "replacement", card: card("a") });
      f.store.detach(f.a, "a");
      expect(f.store.inspect(f.b, f.pa.id).online).toBe(true);
      expect(() => f.store.heartbeat(f.a, "a")).toThrow("superseded");
    } finally { f.store.close(); }
  });
  test("worker provisioning recovers lost responses before quotas and retirement stays parent-scoped", () => {
    const f = fixture(); try {
      const capability = secret();
      const worker = f.store.provision(f.a, "a", "recoverable", capability);
      for (let i = 1; i < 16; i++) f.store.provision(f.a, "a", `run-${i}`);
      expect(f.store.provision(f.a, "a", "recoverable", capability)).toEqual(worker);
      expect(() => f.store.provision(f.a, "a", "overflow", secret())).toThrow("quota");
      expect(() => f.store.provision(f.a, "a", "recoverable", secret())).toThrow("original persisted");
      expect(() => f.store.provision(f.a, "a", "recoverable")).toThrow("original persisted");
      f.store.connect(worker.token, { runtime: "child", card: card("worker"), existingOnly: true });
      expect(f.store.retireWorker(f.b, "b", "recoverable")).toEqual({ retired: false, absent: true });
      expect(f.store.inspect(f.b, worker.id).online).toBe(true);
      expect(() => f.store.retireWorker(worker.token, "child", "recoverable")).toThrow("top-level");
      expect(f.store.retireWorker(f.a, "a", "recoverable").retired).toBe(true);
      expect(f.store.retireWorker(f.a, "a", "recoverable").retired).toBe(true);
      expect(() => f.store.provision(f.a, "a", "recoverable", capability)).toThrow("retired");
      expect(() => f.store.auth(worker.token)).toThrow("revoked");
      expect(f.store.provision(f.a, "a", "replacement", secret()).id).not.toBe(worker.id);
    } finally { f.store.close(); }
  });
  test("heartbeats do not change snapshot versions without material state changes", () => {
    const f = fixture(); try {
      const before = f.store.snapshot(f.a);
      f.advance(1000); f.store.heartbeat(f.b, "b", card("b"));
      expect(f.store.snapshot(f.a).version).toBe(before.version);
      f.store.heartbeat(f.b, "b", { ...card("b"), summary: "new focus" });
      expect(f.store.snapshot(f.a).version).not.toBe(before.version);
    } finally { f.store.close(); }
  });
  test("SQLite refusal rolls back acceptance and preserves the request key for a real retry", () => {
    const f = fixture(); try {
      f.store.db.exec("CREATE TRIGGER fail_send BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END");
      const envelope = { recipient: f.pb.id, key: "retry-after-failure", body: "hello" };
      expect(() => f.store.send(f.a, "a", envelope)).toThrow();
      expect(f.store.one("SELECT count(*) AS n FROM operations")!.n).toBe(0);
      expect(f.store.snapshot(f.b).pending).toBe(0);
      f.store.db.exec("DROP TRIGGER fail_send");
      expect(f.store.send(f.a, "a", envelope).id).toBeDefined();
      f.advance(31 * 86_400_000);
      f.store.connect(f.a, { runtime: "a", card: card("a") });
      f.store.prune();
      expect(f.store.auth(f.a).id).toBe(f.pa.id); // live but unchanged name isn't an abandoned identity
    } finally { f.store.close(); }
  });
  test("send-rate failures don't partially accept messages", () => {
    const f = fixture(); try {
      for (let i = 0; i < 30; i++) f.store.send(f.a, "a", { recipient: f.pb.id, key: String(i), body: "x" });
      expect(() => f.store.send(f.a, "a", { recipient: f.pb.id, key: "31", body: "x" })).toThrow("quota");
      expect(f.store.snapshot(f.b).pending).toBe(30);
      expect(f.store.one("SELECT count(*) AS n FROM operations")!.n).toBe(30);
      expect(f.store.send(f.a, "a", { recipient: f.pb.id, key: "0", body: "x" }).id).toBeDefined();
    } finally { f.store.close(); }
  });
});

test("Node service: socket requests, long-poll, revoked stream, restart/offline delivery, private bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "switchboard-test-"));
  const paths = { root, socket: join(root, "board.sock") };
  let proc: ReturnType<typeof spawn> | undefined;
  async function start() {
    proc = spawn("node", [fileURLToPath(new URL("./fixtures/switchboard-service.ts", import.meta.url)), root], { env: { PATH: process.env.PATH, HOME: root }, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Service startup timeout")), 5000);
      proc!.once("error", reject);
      proc!.stdout!.once("data", () => { clearTimeout(timer); resolve(); });
      proc!.once("exit", code => { clearTimeout(timer); if (code) reject(new Error(`Service startup exited ${code}`)); });
    });
  }
  async function stop() { if (!proc || proc.exitCode !== null) return; await new Promise<void>(resolve => { proc!.once("exit", () => resolve()); proc!.kill("SIGTERM"); }); }
  try {
    await start();
    const bound = await bindingAt(paths, "session-a:/canonical/session.jsonl");
    expect((await bindingAt(paths, "session-a:/canonical/session.jsonl")).binding.token).toBe(bound.binding.token);
    expect((await bindingAt(paths, "session-a:/copied/session.jsonl")).binding.token).not.toBe(bound.binding.token);
    const a = new BoardClient(paths, bound.binding.token), b = new BoardClient(paths, secret());
    await a.connect(card("a") as any); const pb = await b.connect(card("b") as any);
    const initial = await b.snapshot();
    const watch = b.call<Snapshot>("watch", { since: initial.version });
    expect(await a.call("inspect", { id: pb.handle })).toMatchObject({ id: pb.id, handle: pb.handle });
    const result = await a.send("operation-1", { recipient: pb.handle, body: "durable message" }) as { id: string };
    expect((await watch).pending).toBe(1);
    expect((await a.retry("operation-1") as { id: string }).id).toBe(result.id);
    expect(await readFile(bound.file, "utf8")).toContain(bound.binding.token);
    await stop(); await start();
    expect((await a.snapshot()).peers).toHaveLength(0);
    await a.connect(card("a") as any);
    expect(await b.connect(card("renamed") as any)).toMatchObject({ id: pb.id, handle: pb.handle });
    expect((await b.snapshot()).pending).toBe(1);
    expect(await b.call("read")).toMatchObject({ id: result.id, body: "durable message", ackAt: null });
    expect(await b.call("read")).toMatchObject({ id: result.id });
    expect(await a.call("read")).toMatchObject({ empty: true });
    const pending = await b.snapshot();
    const revoked = b.call("watch", { since: pending.version }).catch(e => e.status);
    await b.call("archive"); expect(await revoked).toBe(401);
    expect(await rpc<{ version: number }>(paths, "", undefined)).toMatchObject({ version: VERSION });
  } finally { await stop(); await rm(root, { recursive: true, force: true }); }
}, 20_000);

test("project identity canonicalizes aliases and distinguishes linked worktrees", async () => {
  const { execFileSync } = await import("node:child_process"); const { symlink } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "switchboard-git-"));
  try {
    const repo = join(root, "repo"), tree = join(root, "tree"), alias = join(root, "alias");
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"]);
    execFileSync("git", ["-C", repo, "worktree", "add", "--detach", "-q", tree]); await symlink(repo, alias);
    expect(await projectAt(alias)).toEqual(await projectAt(repo));
    const a = await projectAt(repo), b = await projectAt(tree);
    expect(a.project).toBe(b.project); expect(a.worktree).not.toBe(b.worktree);
  } finally { await rm(root, { recursive: true, force: true }); }
});
