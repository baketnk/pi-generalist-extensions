import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BoardStore } from "../lib/switchboard/store.ts";
import { BoardClient } from "../lib/switchboard/client.ts";
import { serve } from "../lib/switchboard/server.ts";
import { actOnOffer, taskMessage, OfferDeliveryTracker } from "../lib/switchboard/offers-ui.ts";
import { secret, type Offer } from "../lib/switchboard/shared.ts";

const card = { project: "/repo/.git", worktree: "/repo", cwd: "/repo", name: "fixture", summary: "", activity: "idle" };
function fixture(path = ":memory:") {
  let now = 100_000;
  const store = new BoardStore(path, () => now), a = secret(), b = secret(), other = secret(), observer = secret();
  const pa = store.connect(a, { runtime: "a", card }), pb = store.connect(b, { runtime: "b", card });
  store.connect(other, { runtime: "other", card }); store.connect(observer, { runtime: "observer", card, type: "observer" });
  const request = (token: string, runtime: string, op: string, args: object = {}) => store.offers.request(token, runtime, { op, ...args }) as Offer;
  const envelope = { recipient: pb.id, worktree: card.worktree, originalTask: "Review tests\nexact original human wording", generation: 0, authority: "human-ui", key: "offer-one" };
  const create = (extra: object = {}) => request(a, "a", "create", { ...envelope, ...extra });
  return { store, a, b, other, observer, pa, pb, request, envelope, create, advance: (ms: number) => { now += ms; } };
}

test("offers are distinct from mail: metadata-only private list, exact authority and idempotency", () => {
  const f = fixture();
  try {
    f.store.send(f.a, "a", { key: "mail", recipient: f.pb.id, body: "TASK: executable magic?" });
    expect(f.store.snapshot(f.b).offers).toEqual([]);
    const offer = f.create(); expect(offer.state).toBe("offered"); expect(offer.authority).toBe("human-ui");
    expect(offer.originalTask).toBe(f.envelope.originalTask);
    expect(f.create().id).toBe(offer.id);
    expect(() => f.create({ originalTask: "different" })).toThrow("different content");
    expect(f.store.snapshot(f.b).offers?.length).toBe(1);
    expect(JSON.stringify(f.store.snapshot(f.b))).not.toContain("exact original human wording");
    expect(f.store.snapshot(f.observer).offers).toEqual([]);
    expect(f.store.snapshot(f.other).offers).toEqual([]);
    expect(() => f.request(f.other, "other", "inspect", { id: offer.id })).toThrow("unavailable");
    expect(() => f.request(f.observer, "observer", "inspect", { id: offer.id })).toThrow("Only attached agent");
    expect(() => f.create({ key: "bad", authority: "peer-mail" })).toThrow("human UI");
    expect(() => f.create({ key: "big", originalTask: "狸".repeat(6000) })).toThrow("UTF-8");
    expect(f.store.snapshot(f.b).pending).toBe(1);
  } finally { f.store.close(); }
});

test("atomic generation transitions separate accept, claim, queue delivery and completion", () => {
  const f = fixture();
  try {
    const offer = f.create();
    expect(() => f.request(f.a, "a", "accept", { id: offer.id, generation: 0 })).toThrow("recipient");
    const accepted = f.request(f.b, "b", "accept", { id: offer.id, generation: 0 });
    expect(accepted.state).toBe("accepted");
    expect(() => f.request(f.b, "b", "accept", { id: offer.id, generation: 0 })).toThrow("Stale");
    const claimed = f.request(f.b, "b", "claim-delivery", { id: offer.id, generation: accepted.generation });
    expect(claimed.state).toBe("delivery-claimed");
    expect(() => f.request(f.b, "b", "claim-delivery", { id: offer.id, generation: accepted.generation })).toThrow("Stale");
    expect(() => f.request(f.a, "a", "cancel", { id: offer.id, generation: claimed.generation })).toThrow("before delivery");
    const delivered = f.request(f.b, "b", "delivered", { id: offer.id, generation: claimed.generation });
    expect(delivered.state).toBe("delivered"); expect(delivered).not.toHaveProperty("result");
    expect(() => f.request(f.b, "b", "claim-delivery", { id: offer.id, generation: delivered.generation })).toThrow("state");
  } finally { f.store.close(); }
});

test("manual/queue/off policy, offline recipients, generation/scope/checkout fences", () => {
  const f = fixture();
  try {
    f.store.detach(f.b, "b"); expect(() => f.create()).toThrow("offline");
    f.store.connect(f.b, { runtime: "b", card });
    f.request(f.b, "b", "policy-set", { policy: "queue", generation: 0 });
    f.store.detach(f.b, "b"); expect(() => f.create()).toThrow("Stale candidate");
    const offer = f.create({ generation: 1 }); expect(offer.state).toBe("offered");
    f.store.connect(f.b, { runtime: "b", card });
    expect(() => f.request(f.b, "b", "policy-set", { policy: "manual", generation: 0 })).toThrow("Stale policy");
    f.request(f.b, "b", "policy-set", { policy: "off", generation: 1 });
    expect(() => f.request(f.b, "b", "accept", { id: offer.id, generation: 0 })).toThrow("policy/checkout");
    f.request(f.b, "b", "policy-set", { policy: "manual", generation: 2 });
    f.store.heartbeat(f.b, "b", { ...card, worktree: "/other-tree" });
    expect(() => f.request(f.b, "b", "accept", { id: offer.id, generation: 0 })).toThrow("policy/checkout");
    expect(() => f.create({ key: "new", generation: 3 })).toThrow("checkout changed");
    f.store.heartbeat(f.b, "b", { ...card, project: "/other-project" });
    expect(() => f.create({ key: "new", generation: 3 })).toThrow("same project");
    expect(() => f.request(f.a, "a", "policy-get", { recipient: f.pb.id })).toThrow("outside project");
  } finally { f.store.close(); }
});

test("expiry, decline/cancel, quota and SQL refusal leave no partial accepted work", () => {
  const f = fixture();
  try {
    const first = f.create({ ttlSeconds: 60 }); f.advance(60_001);
    f.store.connect(f.a, { runtime: "a", card }); f.store.connect(f.b, { runtime: "b", card });
    expect(f.request(f.b, "b", "inspect", { id: first.id }).state).toBe("expired");
    expect(() => f.request(f.b, "b", "accept", { id: first.id, generation: 0 })).toThrow("Stale");
    const declined = f.create({ key: "decline" });
    expect(f.request(f.b, "b", "decline", { id: declined.id, generation: 0 }).state).toBe("declined");
    const cancelled = f.create({ key: "cancel" });
    expect(f.request(f.a, "a", "cancel", { id: cancelled.id, generation: 0 }).state).toBe("cancelled");
    f.store.db.exec("CREATE TRIGGER refuse_offer BEFORE INSERT ON offers BEGIN SELECT RAISE(FAIL, 'refusal'); END;");
    expect(() => f.create({ key: "retryable" })).toThrow();
    f.store.db.exec("DROP TRIGGER refuse_offer"); expect(f.create({ key: "retryable" }).state).toBe("offered");
    f.advance(60_001); f.store.connect(f.a, { runtime: "a", card }); f.store.connect(f.b, { runtime: "b", card });
    for (let i = 0; i < 7; i++) f.create({ key: `quota-${i}` });
    expect(() => f.create({ key: "over-quota" })).toThrow("quota");
    const receipt = f.create({ key: "retryable" }); expect(receipt.state).toBe("offered");
  } finally { f.store.close(); }
});

test("reload/daemon restart keeps uncertain claims, never replays and explicitly resolves unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "offers-restart-")); const path = join(root, "board.sqlite");
  const f = fixture(path); let reopened: BoardStore | undefined;
  try {
    const offer = f.create(); const accepted = f.request(f.b, "b", "accept", { id: offer.id, generation: 0 });
    const claimed = f.request(f.b, "b", "claim-delivery", { id: offer.id, generation: accepted.generation });
    f.store.close(); reopened = new BoardStore(path, () => 101_000);
    reopened.connect(f.b, { runtime: "b-reloaded", card });
    expect(reopened.offers.request(f.b, "b-reloaded", { op: "inspect", id: offer.id })).toMatchObject({ state: "delivery-claimed" });
    expect(() => reopened!.offers.request(f.b, "b-reloaded", { op: "delivered", id: offer.id, generation: claimed.generation })).toThrow("never automatically replayed");
    const resolved = reopened.offers.request(f.b, "b-reloaded", { op: "resolve-unknown", id: offer.id, generation: claimed.generation }) as Offer;
    expect(resolved.state).toBe("delivery-unknown");
    expect(() => reopened!.offers.request(f.b, "b-reloaded", { op: "claim-delivery", id: offer.id, generation: resolved.generation })).toThrow("state");
    const fork = secret(); reopened.connect(fork, { runtime: "fork", card });
    expect(() => reopened!.offers.request(fork, "fork", { op: "inspect", id: offer.id })).toThrow("unavailable");
  } finally { reopened?.close(); await rm(root, { recursive: true, force: true }); }
});

test("socket watch and durable offer retry resolve a lost creation response to the same offer", async () => {
  const root = await mkdtemp(join(tmpdir(), "offers-wire-")), paths = { root, socket: join(root, "board.sock") };
  const board = await serve(paths), a = new BoardClient(paths, secret()), b = new BoardClient(paths, secret());
  try {
    await a.connect(card as any); const target = await b.connect(card as any);
    const initial = await b.snapshot(); const watch = b.call<any>("watch", { since: initial.version });
    const envelope = { recipient: target.id, worktree: card.worktree, originalTask: "exact task", generation: 0, authority: "human-ui" };
    const call = a.call.bind(a); let lose = true;
    a.call = async (...args: any[]) => { const result = await (call as any)(...args); if (lose) { lose = false; throw new Error("simulated lost response"); } return result; };
    await expect(a.createOffer("stable-operation", envelope)).rejects.toThrow("offer-retry stable-operation");
    const updated = await watch; expect(updated.offers).toHaveLength(1); expect(JSON.stringify(updated)).not.toContain("exact task");
    const offer = await a.retryOffer("stable-operation"); expect(offer.id).toBe(updated.offers[0].id);
    expect((await b.snapshot()).offerTotal).toBe(1);
    await expect(a.createOffer("stable-operation", { ...envelope, originalTask: "different" })).rejects.toThrow("different content");
    const accepted = await b.call<Offer>("offer", { op: "accept", id: offer.id, generation: 0 });
    const simultaneous = await Promise.allSettled([1, 2].map(() => b.call<Offer>("offer", { op: "claim-delivery", id: offer.id, generation: accepted.generation })));
    expect(simultaneous.filter(r => r.status === "fulfilled")).toHaveLength(1);
  } finally { await board.close(); await rm(root, { recursive: true, force: true }); }
});

function uiFixture() {
  const f = fixture(); const offer = f.create(); f.request(f.b, "b", "accept", { id: offer.id, generation: 0 });
  const sent: string[] = [], notices: string[] = []; let idle = true, pending = false, current = true;
  const client = { call: async (_action: string, args: any) => f.store.offers.request(f.b, "b", args) };
  const runtime: any = { closed: false, card: f.pb, requireClient: () => client, refresh: async () => f.store.snapshot(f.b) };
  const ctx: any = { isIdle: () => idle, hasPendingMessages: () => pending,
    ui: { confirm: async () => true, notify: (text: string) => notices.push(text) } };
  const pi: any = { sendUserMessage: (text: string) => sent.push(text) };
  const delivery = new OfferDeliveryTracker();
  return { ...f, offer, sent, notices, ctx, pi, runtime, delivery, start: () => actOnOffer(pi, ctx, runtime, { action: "start", id: offer.id }, () => current, delivery),
    busy: () => { idle = false; }, pending: () => { pending = true; }, switchSession: () => { current = false; } };
}

test("human-confirmed start appends exact original task once; busy/queued work defers", async () => {
  const f = uiFixture();
  try {
    await f.start(); expect(f.sent).toEqual([taskMessage({ ...f.offer, state: "delivery-claimed" })]);
    expect(f.request(f.b, "b", "inspect", { id: f.offer.id }).state).toBe("delivery-claimed");
    await f.delivery.observe({ role: "user", content: [{ type: "text", text: f.sent[0] }] });
    expect(f.request(f.b, "b", "inspect", { id: f.offer.id }).state).toBe("delivered");
    await expect(f.start()).rejects.toThrow("Accept the offer first"); expect(f.sent).toHaveLength(1);
  } finally { f.store.close(); }
  for (const mode of ["busy", "pending"] as const) {
    const g = uiFixture(); try { g[mode](); await expect(g.start()).rejects.toThrow("active or queued"); expect(g.sent).toEqual([]); expect(g.request(g.b, "b", "inspect", { id: g.offer.id }).state).toBe("accepted"); } finally { g.store.close(); }
  }
});

test("cancelled confirmation/session replacement cannot deliver, failed Pi queue stays uncertain", async () => {
  const f = uiFixture();
  try {
    f.ctx.ui.confirm = async () => false; await f.start(); expect(f.sent).toEqual([]);
    f.ctx.ui.confirm = async () => { f.switchSession(); return true; };
    await expect(f.start()).rejects.toThrow("Session changed"); expect(f.sent).toEqual([]);
  } finally { f.store.close(); }
  const g = uiFixture();
  try {
    g.pi.sendUserMessage = () => { throw new Error("Pi queue rejected"); };
    await expect(g.start()).rejects.toThrow("Pi queue rejected");
    expect(g.request(g.b, "b", "inspect", { id: g.offer.id }).state).toBe("delivery-claimed");
    await expect(g.start()).rejects.toThrow("Accept the offer first"); expect(g.sent).toEqual([]);
  } finally { g.store.close(); }
});
test("void send return, transformed input and cleared runtime tracker do not claim delivery", async () => {
  const f = uiFixture();
  try {
    await f.start();
    expect(f.request(f.b, "b", "inspect", { id: f.offer.id }).state).toBe("delivery-claimed");
    await f.delivery.observe({ role: "user", content: "transformed/handled task" });
    await f.delivery.observe({ role: "assistant", content: f.sent[0] });
    expect(f.request(f.b, "b", "inspect", { id: f.offer.id }).state).toBe("delivery-claimed");
    f.delivery.clear();
    await f.delivery.observe({ role: "user", content: f.sent[0] });
    expect(f.request(f.b, "b", "inspect", { id: f.offer.id }).state).toBe("delivery-claimed");
  } finally { f.store.close(); }
});

test("Node/Pi SDK: dashboard/Generalist UI, explicit offer delivery and provider-prefix preservation", async () => {
  const root = await mkdtemp(join(tmpdir(), "dashboard-sdk-test-"));
  try {
    const proc = spawn("node", [fileURLToPath(new URL("./fixtures/switchboard-dashboard-sdk.ts", import.meta.url)), root], {
      env: { PATH: process.env.PATH, HOME: root }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    proc.stdout!.on("data", b => { stdout += b; }); proc.stderr!.on("data", b => { stderr += b; });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error(`Dashboard SDK timeout: ${stderr}`)); }, 15_000);
      proc.once("exit", code => { clearTimeout(timer); resolve(code); });
      proc.once("error", error => { clearTimeout(timer); reject(error); });
    });
    expect({ code, stderr: code ? stderr : "" }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain('"explicitOfferDelivery":true'); expect(stdout).toContain('"providerPrefix":true');
  } finally { await rm(root, { recursive: true, force: true }); }
}, 20_000);
