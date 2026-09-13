import { test, expect } from "bun:test";
import { BoardStore } from "../lib/switchboard/store.ts";
import { secret, type Mail } from "../lib/switchboard/shared.ts";
import { openMail, mailLabel } from "../lib/switchboard/mail-ui.ts";
import { serve } from "../lib/switchboard/server.ts";
import { BoardClient } from "../lib/switchboard/client.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const card = { name: "fixture", summary: "", activity: "idle", project: "/repo", cwd: "/repo", worktree: "/repo" } as const;
test("mail keeps all 128 pending plus bounded recent, with deterministic ordering and no body/fetch/ack effects", () => {
  let now = 100_000;
  const s = new BoardStore(":memory:", () => now), a = secret(), b = secret(), outsider = secret();
  const pa = s.connect(a, { runtime: "a", card }), pb = s.connect(b, { runtime: "b", card });
  s.connect(outsider, { runtime: "o", card, type: "observer" });
  try {
    // Multiple senders avoid conflating send-rate and mailbox quotas.
    const pending: Mail[] = [], acknowledged: Mail[] = [];
    for (let i = 0; i < 188; i++) {
      if (i % 30 === 0) { now += 61_000; s.connect(a, { runtime: "a", card }); s.connect(b, { runtime: "b", card }); }
      const m = s.send(a, "a", { recipient: pb.id, key: `m${i}`, body: "private body", kind: "handoff" });
      if (i < 60) { now++; s.ack(b, "b", m.id); acknowledged.push(m); } else pending.push(m);
    }
    const before = s.snapshot(b), page = s.mail(b, "b");
    expect(page.pending).toBe(128); expect(page.recent).toBe(50); expect(page.messages).toHaveLength(178);
    expect(page.messages.slice(128).map(m => m.id)).toEqual(acknowledged.slice(-50).reverse().map(m => m.id));
    expect(page.messages.slice(0, 128).map(m => m.id)).toEqual([...pending].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).map(m => m.id));
    expect(JSON.stringify(page)).not.toContain("private body");
    expect(s.peek(b, "b", pending[0]!.id)).toMatchObject({ body: "private body", fetchedAt: null, ackAt: null });
    expect(s.snapshot(b)).toEqual(before);
    s.read(b, "b", pending[0]!.id, true);
    expect(mailLabel(s.peek(b, "b", pending[0]!.id), now)).toContain("fetched · pending");
    expect(s.mail(b, "b", 0).messages).toHaveLength(128);
    expect(s.mail(a, "a").messages).toHaveLength(0); // own incoming, not sent or somebody else's mailbox
    for (const value of [-1, 101, 1.5, "50", null]) expect(() => s.mail(b, "b", value)).toThrow("recent");
    s.connect(outsider, { runtime: "o", card, type: "observer" });
    expect(() => s.mail(outsider, "o")).toThrow("Observer");
    expect(() => s.peek(outsider, "o", pending[0]!.id)).toThrow("unavailable");
    expect(() => s.mail(b, "wrong-runtime")).toThrow("superseded");
    expect(pa.id).not.toBe(pb.id);
  } finally { s.close(); }
});

test("expired bodies stay hidden before pruning; recent includes expired unacknowledged metadata", () => {
  let now = 100_000;
  const s = new BoardStore(":memory:", () => now), a = secret(), b = secret();
  s.connect(a, { runtime: "a", card }); const pb = s.connect(b, { runtime: "b", card });
  try {
    const exp = s.send(a, "a", { recipient: pb.id, key: "exp", body: "gone", ttlSeconds: 1 });
    const ack = s.send(a, "a", { recipient: pb.id, key: "ack", body: "also gone", kind: "handoff" });
    s.ack(b, "b", ack.id); now += 1001;
    expect(s.mail(b, "b")).toMatchObject({ pending: 0, recent: 2 });
    expect(s.peek(b, "b", exp.id).body).toBeNull();
    expect(mailLabel(s.peek(b, "b", exp.id), now)).toContain("expired");
    now += 86_400_000; s.connect(b, { runtime: "b", card });
    expect(s.peek(b, "b", ack.id).body).toBeNull();
    now += 14 * 86_400_000; s.connect(b, { runtime: "b", card }); s.prune();
    expect(s.mail(b, "b").messages).toHaveLength(0);
  } finally { s.close(); }
});

test("mail UI only lists/peeks, returns to selector, and stops across session changes", async () => {
  const mail = { id: "m_1", sender: "p_sender", recipient: "p_recipient", kind: "note", createdAt: 1, expiresAt: Date.now() + 10000, body: "human only" } as Mail;
  const calls: string[] = []; let count = 0, shown = "", current = true;
  const client = { call: async (action: string) => { calls.push(action); return action === "mail" ? { pending: 1, recent: 0, messages: [mail] } : mail; } };
  const runtime = { closed: false, requireClient: () => client } as any;
  const ctx = { hasUI: true, ui: { select: async (_title: string, choices: string[]) => count++ === 0 ? choices[0] : "Close" } } as any;
  await openMail(ctx, runtime, 50, () => current, async m => { shown = m.body!; });
  expect(calls).toEqual(["mail", "peek", "mail"]); expect(shown).toBe("human only");
  calls.length = 0;
  ctx.ui.select = async (_title: string, choices: string[]) => { current = false; return choices[0]; };
  await openMail(ctx, runtime, 50, () => current, async () => { throw new Error("stale view"); });
  expect(calls).toEqual(["mail"]);
});

test("mail and peek RPC authorize own mailbox and leave snapshot receipts unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "switchboard-mail-")), paths = { root, socket: join(root, "board.sock") };
  const board = await serve(paths), a = new BoardClient(paths, secret()), b = new BoardClient(paths, secret());
  try {
    await a.connect(card); const pb = await b.connect(card);
    const m = await a.send("mail", { recipient: pb.id, body: "peek body" }) as Mail;
    const before = await b.snapshot();
    expect(await b.call("mail")).toMatchObject({ pending: 1, recent: 0 });
    expect(await b.call("peek", { id: m.id })).toMatchObject({ body: "peek body", fetchedAt: null, ackAt: null });
    expect(await b.snapshot()).toEqual(before);
    await b.call("ack", { id: m.id });
    expect(await b.call("mail")).toMatchObject({ pending: 0, recent: 1 });
  } finally { await board.close(); await rm(root, { recursive: true, force: true }); }
});
