import { expect, test } from "bun:test";
import { HANDLE_WORDS, participantHandle } from "../lib/switchboard/handles.ts";
import { BoardStore } from "../lib/switchboard/store.ts";
import { hash, secret, type Mail } from "../lib/switchboard/shared.ts";
import { shortCard } from "../lib/switchboard/context.ts";
import { formatSwitchboard } from "../lib/switchboard/presentation.ts";

const card = (name = "", project = "/repo") => ({ name, project, cwd: project, worktree: project, summary: "", activity: "idle" as const });

test("v1 handle vocabulary is fixed, unique, bounded and has 32 bits of name space", () => {
  expect(HANDLE_WORDS).toHaveLength(256);
  expect(new Set(HANDLE_WORDS).size).toBe(256);
  expect(Object.isFrozen(HANDLE_WORDS)).toBe(true);
  expect(HANDLE_WORDS.every(word => /^[a-z]{2,7}$/.test(word))).toBe(true);
  expect(hash(HANDLE_WORDS.join("\n"))).toBe("c13b6740ce2bbafbeec5df685cb81e46dee175aa8c102383fad28c348b826a8d");
  expect(participantHandle("p_0000000000000000")).toBe("acorn-crown-jay-glow");
  expect(participantHandle("p_0000000000000337")).toBe("anchor-reed-ocean-dog");
});

test("stable handles route directly, independently of mutable labels, activity and project", () => {
  const store = new BoardStore(":memory:");
  const a = secret(), b = secret();
  try {
    const pa = store.connect(a, { runtime: "a", card: card() });
    const pb = store.connect(b, { runtime: "b", card: card("unnamed · 01a09c66") });
    expect(pa.name).toBe(pa.handle); expect(pb.name).toBe(pb.handle);
    expect(shortCard(pa).name).toBeUndefined();
    expect(shortCard(pa).handle).toBe(pa.handle);
    expect(formatSwitchboard("peers", { peers: [shortCard(pa)] })).toContain(pa.handle);
    const renamed = store.heartbeat(b, "b", card("tests", "/elsewhere"));
    expect(renamed.handle).toBe(pb.handle);
    expect(store.snapshot(a).peers).toHaveLength(0);
    expect(store.inspect(a, pb.handle).id).toBe(pb.id);
    expect(() => store.inspect(a, "tests")).toThrow("exact ID or full handle");
    expect(() => store.inspect(a, pb.handle.split("-").slice(0, 2).join("-"))).toThrow();
    expect(() => store.inspect(a, pb.handle.toUpperCase())).toThrow();
    // Labels cannot shadow somebody else's handle or ID.
    store.heartbeat(a, "a", card(pb.handle));
    expect(store.inspect(a, pb.handle).id).toBe(pb.id);
    store.detach(b, "b");
    const envelope = { recipient: pb.handle, key: "named", body: "offline mail" };
    const sent = store.send(a, "a", envelope);
    expect(sent.recipient).toBe(pb.id);
    expect(sent.senderHandle).toBe(pa.handle); expect(sent.recipientHandle).toBe(pb.handle);
    expect(store.snapshot(b).inbox[0]!.senderHandle).toBe(pa.handle);
    expect(store.snapshot(b).inbox[0]!.body).toBeUndefined();
    expect(store.connect(b, { runtime: "resumed", card: card("new label") }).handle).toBe(pb.handle);
    const reply = store.send(b, "resumed", { recipient: pa.handle, key: "reply", kind: "reply", replyTo: sent.id, body: "yes" });
    expect(reply.recipient).toBe(pa.id);
    const worker = store.provision(a, "a", "worker");
    const child = store.connect(worker.token, { runtime: "child", card: card() });
    expect(child.handle).toBe(participantHandle(worker.id)); expect(child.parentId).toBe(pa.id);
    expect(() => store.connect(secret(), { runtime: "spoof", card: { ...card(), handle: pb.handle } })).toThrow("Unexpected");
    store.archive(b, "resumed");
    expect(store.send(a, "a", envelope).id).toBe(sent.id);
    expect(() => store.send(a, "a", { ...envelope, key: "new-send" })).toThrow("archived");
  } finally { store.close(); }
});

test("real 32-bit collision fails closed, including offline/cross-project identities; retries remain pinned", () => {
  const store = new BoardStore(":memory:");
  const a = secret(), b = secret(), c = secret();
  try {
    store.connect(a, { runtime: "a", card: card() });
    const pb = store.connect(b, { runtime: "b", card: card() });
    const left = "p_0000000000000337", right = "p_0000000000010a3b";
    expect(participantHandle(left)).toBe(participantHandle(right));
    store.run("UPDATE participants SET id=? WHERE id=?", left, pb.id);
    const envelope = { recipient: participantHandle(left), key: "before-collision", body: "pinned" };
    const accepted = store.send(a, "a", envelope);
    const pc = store.connect(c, { runtime: "c", card: card("other", "/elsewhere") });
    store.run("UPDATE participants SET id=? WHERE id=?", right, pc.id);
    store.detach(c, "c");
    expect(store.snapshot(a).peers).toHaveLength(1);
    expect(() => store.inspect(a, envelope.recipient)).toThrow("Ambiguous");
    expect(() => store.send(a, "a", { ...envelope, key: "ambiguous" })).toThrow("Ambiguous");
    expect(store.one("SELECT count(*) AS n FROM operations")!.n).toBe(1);
    expect(store.send(a, "a", envelope).id).toBe(accepted.id);
    expect(store.send(a, "a", { ...envelope, recipient: right, key: "exact" }).recipient).toBe(right);
    expect(store.inspect(a, left).id).toBe(left);
  } finally { store.close(); }
});

test("ID-free read is oldest pending, bounded to one body, repeats until explicit ack", () => {
  let now = 100_000;
  const store = new BoardStore(":memory:", () => now);
  const a = secret(), b = secret(), observer = secret();
  try {
    const pa = store.connect(a, { runtime: "a", card: card() });
    const pb = store.connect(b, { runtime: "b", card: card() });
    const po = store.connect(observer, { runtime: "o", card: card(), type: "observer" });
    expect(store.readNext(b, "b")).toEqual({ empty: true, note: "No pending messages." });
    expect(() => store.send(a, "a", { recipient: po.handle, key: "observer", body: "no" })).toThrow("Non-addressable");
    const first = store.send(a, "a", { recipient: pb.handle, key: "first", body: "one" });
    now++;
    const second = store.send(a, "a", { recipient: pb.handle, key: "second", body: "two" });
    store.send(b, "b", { recipient: pa.handle, key: "outgoing", body: "not incoming" });
    expect(store.readNext(b, "b")).toMatchObject({ id: first.id, body: "one", ackAt: null, fetchedAt: now });
    expect(store.readNext(b, "b")).toMatchObject({ id: first.id });
    expect(store.snapshot(b).pending).toBe(2);
    expect(store.readNext(observer, "o")).toHaveProperty("empty", true);
    expect(() => store.readNext(b, "wrong")).toThrow("superseded");
    store.ack(b, "b", first.id);
    expect((store.readNext(b, "b") as Mail).id).toBe(second.id);
    store.ack(b, "b", second.id);
    const expiring = store.send(a, "a", { recipient: pb.handle, key: "expired", body: "old", ttlSeconds: 1 });
    now += 1001;
    expect(store.readNext(b, "b")).toHaveProperty("empty", true);
    expect(store.read(b, "b", expiring.id, true).body).toBeNull();
    expect(formatSwitchboard("read", store.readNext(b, "b"))).toBe("No pending messages");
  } finally { store.close(); }
});
