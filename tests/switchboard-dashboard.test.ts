import { expect, test } from "bun:test";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { Dashboard, coverage, registerDashboardEntry, requestDashboard, type DashboardSource, type DashboardState } from "../lib/switchboard/dashboard.ts";
import { BoardRuntime } from "../lib/switchboard/runtime.ts";
import type { Card, Mail } from "../lib/switchboard/shared.ts";

const now = 100_000;
const card = (id: string, extra: Partial<Card> = {}): Card => ({ id, handle: `handle-${id}`, name: `task-${id}`, summary: "declared work", activity: "idle", updatedAt: now, online: true, type: "agent", cwd: "/project", project: "/project/.git", worktree: "/project", ...extra });
const mail: Mail = { id: "m_one", sender: "p_other", recipient: "p_self", kind: "question", createdAt: now - 1000, expiresAt: now + 10000 };
const theme: any = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const keys = { matches: (data: string, action: string) => matchesKey(data, ({ "tui.select.cancel": "escape", "tui.select.confirm": "enter", "tui.select.up": "up", "tui.select.down": "down", "tui.select.pageUp": "pageUp", "tui.select.pageDown": "pageDown" } as any)[action] ?? "escape") };
function fixture(read?: DashboardSource["read"]) {
  const state: DashboardState = { state: "online", card: card("p_self"), snapshotAt: now, snapshot: {
    peers: [card("p_other", { parentId: "p_self", summary: "\x1b[31m hostile\u202e text 狸" })], total: 5, inbox: [mail], pending: 3, reloadPending: false, version: "fixture-generation",
  } };
  const listeners = new Set<() => void>(); let renders = 0, closed = 0, reads = 0, refreshes = 0;
  let clock = now, rows = 30;
  const ui = new Dashboard({ current: () => state,
    subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    refresh: async () => { refreshes++; },
    read: async (id, signal) => { reads++; return read ? read(id, signal) : { ...mail, fetchedAt: now, body: "untrusted\n/shell NO\x1b]52;c;bad\x07" }; },
  }, theme, keys, () => { renders++; }, () => { closed++; }, () => rows, () => clock);
  return { ui, state, listeners, tick: () => { for (const fn of listeners) fn(); }, counts: () => ({ renders, closed, reads, refreshes }), clock: (n: number) => { clock = n; }, rows: (n: number) => { rows = n; } };
}

test("model-free dashboard renders partial counts, declared provenance, filters and live updates", () => {
  const f = fixture();
  try {
    let text = f.ui.render(180).join("\n");
    expect(text).toContain("╭"); expect(text).toContain("╰");
    expect(text).toContain("Inspect is read-only"); expect(text).toContain("recipient must accept");
    expect(text).toContain("registered/partial"); expect(text).toContain("omitted 4");
    expect(text).toContain("direct child"); expect(text).toContain("same checkout");
    expect(text).not.toContain("\x1b"); expect(text).not.toContain("\u202e");
    f.ui.handleInput("/"); f.ui.handleInput("other"); f.ui.handleInput("\r");
    text = f.ui.render(180).join("\n"); expect(text).toContain("handle-p_other"); expect(text).not.toContain("handle-p_self");
    f.state.snapshot!.peers[0]!.activity = "working"; f.tick();
    expect(f.ui.render(180).join("\n")).toContain("working");
    f.ui.handleInput("\r"); text = f.ui.render(180).join("\n");
    expect(text).toContain("Summary (declared)"); expect(text).toContain("Heartbeat age is not idle duration");
    expect(text).toContain("not task completion");
    expect(f.counts().reads).toBe(0); expect(f.counts().refreshes).toBe(0);
  } finally { f.ui.dispose(); }
});

test("offline, stale, unavailable and empty coverage never become a worker availability claim", () => {
  const f = fixture();
  try {
    f.clock(now + 70_000); expect(f.ui.render(180).join("\n")).toContain("stale");
    f.state.state = "unavailable"; expect(f.ui.render(180).join("\n")).toContain("retained snapshot is historical");
    f.state.snapshot = undefined; expect(f.ui.render(180).join("\n")).toContain("coverage unknown");
    expect(coverage({ state: "off" }, now)).toContain("coverage unknown");
  } finally { f.ui.dispose(); }
});

test("inbox remains metadata-only until explicit inspection; reading never acks or publishes", async () => {
  const f = fixture();
  try {
    f.ui.handleInput("\t"); let text = f.ui.render(180).join("\n");
    expect(text).toContain("omitted 2"); expect(text).not.toContain("untrusted"); expect(f.counts().reads).toBe(0);
    f.ui.handleInput("\r"); await Bun.sleep(0);
    text = f.ui.render(180).join("\n"); expect(text).toContain("untrusted"); expect(text).toContain("not executable task authority");
    expect(text).not.toContain("\x1b"); expect(f.counts().reads).toBe(1);
    expect(f.state.snapshot!.inbox[0]!.ackAt).toBeUndefined();
    f.ui.handleInput("\x1b"); f.ui.render(180); f.ui.handleInput("r"); await Bun.sleep(0);
    expect(f.counts().refreshes).toBe(1);
    f.ui.handleInput("\x1b"); expect(f.listeners.size).toBe(0); expect(f.counts().closed).toBe(1);
  } finally { f.ui.dispose(); }
});

test("selection stays on stable participant ID when subscription order changes", () => {
  const f = fixture();
  try {
    f.ui.render(100); f.ui.handleInput("\x1b[B");
    f.state.snapshot!.peers.unshift(card("p_new")); f.tick(); f.ui.render(100); f.ui.handleInput("\r");
    expect(f.ui.render(180).join("\n")).toContain("Participant: handle-p_other");
  } finally { f.ui.dispose(); }
});

test("tiny/wide terminals, Unicode, resize, and detail scrolling stay bounded", async () => {
  const f = fixture(async () => ({ ...mail, body: "狸".repeat(4000) + "\n" + "line\n".repeat(100) }));
  try {
    for (const width of [1, 2, 10, 40, 80, 180]) for (const rows of [3, 10, 30]) {
      f.rows(rows); const lines = f.ui.render(width);
      expect(lines.length).toBeLessThanOrEqual(Math.max(1, Math.floor(rows * 0.8)));
      expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
    }
    f.rows(30); f.ui.handleInput("\t"); f.ui.render(80); f.ui.handleInput("\r"); await Bun.sleep(0);
    for (let i = 0; i < 100; i++) f.ui.handleInput("\x1b[6~");
    for (const width of [1, 2, 10, 40, 80]) expect(f.ui.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
  } finally { f.ui.dispose(); }
});

test("close aborts pending read, detaches listener, fences late response; runtime close dismisses", async () => {
  let resolve!: (m: Mail) => void, signal: AbortSignal | undefined;
  const f = fixture((_id, s) => { signal = s; return new Promise(r => { resolve = r; }); });
  f.ui.handleInput("\t"); f.ui.render(80); f.ui.handleInput("\r"); f.ui.handleInput("\x1b");
  expect(signal?.aborted).toBe(true); expect(f.listeners.size).toBe(0);
  const counts = f.counts(); resolve({ ...mail, body: "late" }); await Bun.sleep(0);
  expect(f.counts()).toEqual(counts); f.ui.dispose(); expect(f.counts().closed).toBe(1);
  const g = fixture(); g.state.state = "closed"; g.tick(); expect(g.listeners.size).toBe(0); expect(g.counts().closed).toBe(1);
});

test("errors stay in dashboard and escaped; no fallback operation", async () => {
  const f = fixture(async () => { throw new Error("service\x1b error"); });
  try {
    f.ui.handleInput("\t"); f.ui.render(100); f.ui.handleInput("\r"); await Bun.sleep(0);
    expect(f.ui.render(180).join("\n")).toContain("service  error");
    expect(f.counts().reads).toBe(1); expect(f.counts().refreshes).toBe(0);
  } finally { f.ui.dispose(); }
});

test("Generalist entry bridge is direct UI-only and unregisters cleanly", async () => {
  const listeners = new Map<string, (data: unknown) => void>(); let opened = 0; const notices: string[] = [];
  const pi: any = { events: { on: (name: string, fn: any) => { listeners.set(name, fn); return () => listeners.delete(name); }, emit: (name: string, data: unknown) => listeners.get(name)?.(data) } };
  const ctx: any = { hasUI: true, ui: { notify: (text: string) => notices.push(text) } };
  await requestDashboard(pi, ctx); expect(notices[0]).toContain("load the switchboard extension");
  const off = registerDashboardEntry(pi, async context => { expect(context).toBe(ctx); opened++; });
  await requestDashboard(pi, ctx); expect(opened).toBe(1); off(); expect(listeners.size).toBe(0);
});

test("runtime observer subscription adds no registration resources, stamps snapshots, closes once", async () => {
  const r = new BoardRuntime({ paths: { root: "/unused", socket: "/unused" }, cwd: "/unused", sessionId: "synthetic", mode: "tui", disabled: true });
  let changes = 0; const off = r.subscribe(() => { changes++; });
  await r.start(); expect(changes).toBe(1); expect(r.client).toBeUndefined();
  r.accept({ peers: [], total: 0, inbox: [], pending: 0, reloadPending: false, version: "empty" });
  expect(r.snapshotAt).toBeGreaterThan(0); expect(changes).toBe(2);
  off(); await r.close(); expect(changes).toBe(2); await r.close();
});
