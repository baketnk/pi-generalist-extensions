import { expect, test } from "bun:test";
import { CURSOR_MARKER, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { Dashboard, coverage, registerDashboardEntry, requestDashboard, type DashboardSource, type DashboardState } from "../lib/switchboard/dashboard.ts";
import { BoardRuntime } from "../lib/switchboard/runtime.ts";
import { tableColumns, tableLine, tableWindow } from "../lib/switchboard/dashboard-layout.ts";
import type { Card, Directory, Mail, Offer } from "../lib/switchboard/shared.ts";

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

const DOWN = "\x1b[B", UP = "\x1b[A", RIGHT = "\x1b[C", LEFT = "\x1b[D", PAGE_DOWN = "\x1b[6~";
const stripStyle = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const screen = (ui: Dashboard, width = 180) => stripStyle(ui.render(width).join("\n"));
const details = (ui: Dashboard) => ui.render(180).filter(line => line.includes(" │ ")).map(line => stripStyle(line.split(" │ ")[1]!).trim()).join(" ");
const selectFilter = (ui: Dashboard, query: string) => { ui.handleInput("/"); ui.handleInput(query); ui.handleInput("\r"); };
const expectTaskFacingCopy = (text: string) => {
  for (const explainer of [
    "viewing is not acknowledgement", "Viewing never", "no model calls", "coverage unknown",
    "not a session/process census", "(declared)", "(adapter-reported)", "adapter-attested",
    "not task completion", "Heartbeat age is not", "Scheduling availability", "Run links do not",
    "Checkout identity is not", "not executable task authority", "offline entries are limited",
    "Acceptance, delivery, execution", "Delivered means", "Never automatically replay",
  ]) expect(text).not.toContain(explainer);
};

test("fullscreen table has live selection details, spaced columns, local filtering and provenance", () => {
  const f = fixture();
  try {
    const lines = f.ui.render(180), text = stripStyle(lines.join("\n"));
    expect(lines).toHaveLength(30); expect(lines.every(line => visibleWidth(line) === 180)).toBe(true);
    expect(text).toContain("Switchboard command center"); expect(text).toContain("Session details");
    expect(text).toContain("Status"); expect(text).toContain("Model"); expect(text).toContain("Heartbeat");
    expect(text).toContain("Status: live"); expect(text).toContain("Omitted: 4");
    expect(text).not.toContain("Enter inspect"); expect(text).not.toContain("\x1b"); expect(text).not.toContain("\u202e");
    selectFilter(f.ui, "other");
    expect(details(f.ui)).toContain("task-p_other"); expect(details(f.ui)).toContain("Summary:");
    expect(details(f.ui)).toContain("Relationship: direct child");
    f.state.snapshot!.peers[0]!.activity = "working"; f.tick();
    expect(details(f.ui)).toContain("Activity: working");
    f.ui.handleInput(RIGHT); f.ui.handleInput(PAGE_DOWN);
    expect(details(f.ui)).toContain("Heartbeat:");
    f.rows(80); expectTaskFacingCopy(screen(f.ui));
    expect(f.counts().reads).toBe(0); expect(f.counts().refreshes).toBe(0);
  } finally { f.ui.dispose(); }
});

test("human desk loads all-project agents and flat pending/recent mail without changing scoped watch", async () => {
  const f = fixture();
  const own = f.state.card!, remote = card("p_remote", { project: "/other/.git", worktree: "/other", cwd: "/other", online: false, createdAt: now - 5000 });
  const child = card("p_child", { parentId: remote.id, project: "/other/.git", worktree: "/other", cwd: "/other", online: false, retired: true });
  const closed: Mail = { ...mail, id: "m_closed", ackAt: now - 50 };
  let directories = 0, mailReads = 0, peeks = 0, refreshes = 0;
  const source: DashboardSource = { current: () => f.state, subscribe: fn => { f.listeners.add(fn); return () => f.listeners.delete(fn); },
    refresh: async () => { refreshes++; }, read: async id => { peeks++; return { ...closed, id, body: "recent body" }; },
    directory: async () => { directories++; return { agents: [own, remote, child], total: 3, recentWindowMs: 86_400_000, observedAt: now } satisfies Directory; },
    mail: async () => { mailReads++; return { pending: 1, recent: 1, messages: [mail, closed] }; } };
  const ui = new Dashboard(source, theme, keys, () => {}, () => {}, () => 30, () => now);
  try {
    await ui.load();
    const text = screen(ui);
    expect(text).toContain("Projects: all"); expect(text).toContain("/other/.git"); expect(text).toContain("retired");
    expect(text).toContain("↳ task-p_child"); expect(f.state.snapshot!.peers).toHaveLength(1);
    ui.handleInput("\t");
    expect(screen(ui)).toContain("Pending: 1 · Recent: 1"); expect(screen(ui)).toContain("acknowledged");
    // Selection reads only one body; rapid filtering cancels the queued first read.
    selectFilter(ui, "closed"); await Bun.sleep(0);
    expect(details(ui)).toContain("recent body"); expect(peeks).toBe(1);
    ui.handleInput("r"); await Bun.sleep(0);
    expect([directories, mailReads, refreshes]).toEqual([2, 2, 1]);
    f.state.state = "unavailable"; f.tick(); expect(screen(ui)).toContain("Status: unavailable");
    expect(details(ui)).not.toContain("recent body");
  } finally { ui.dispose(); f.ui.dispose(); }
  expect(f.listeners.size).toBe(0);
});

test("connection status and stale data remain visible as concise labels", () => {
  const f = fixture();
  try {
    f.clock(now + 70_000); expect(screen(f.ui)).toContain("stale");
    f.state.state = "unavailable"; expect(screen(f.ui)).toContain("Status: unavailable · Data: cached");
    f.state.snapshot = undefined; expect(screen(f.ui)).toContain("Status: unavailable");
    expect(coverage({ state: "off" }, now)).toBe("Status: off");
  } finally { f.ui.dispose(); }
});

test("selection automatically peeks mail once, never mutates receipts, and Escape closes directly", async () => {
  const f = fixture();
  try {
    f.ui.handleInput("\t"); expect(screen(f.ui)).toContain("Omitted: 2");
    await Bun.sleep(0);
    expect(details(f.ui)).toContain("untrusted"); expect(details(f.ui)).toContain("From: p_other");
    expect(screen(f.ui)).not.toContain("\x1b"); expect(f.counts().reads).toBe(1);
    expect(screen(f.ui, 160)).toMatchSnapshot("mail table and automatic preview");
    expectTaskFacingCopy(screen(f.ui));
    for (let i = 0; i < 3; i++) { f.ui.render(180); f.ui.handleInput("\r"); f.tick(); }
    await Bun.sleep(0); expect(f.counts().reads).toBe(1);
    expect(f.state.snapshot!.inbox[0]!.ackAt).toBeUndefined(); expect(f.state.snapshot!.inbox[0]!.fetchedAt).toBeUndefined();
    f.ui.handleInput("r"); await Bun.sleep(0); expect(f.counts().refreshes).toBe(1); expect(f.counts().reads).toBe(2);
    f.ui.handleInput("\x1b"); expect(f.listeners.size).toBe(0); expect(f.counts().closed).toBe(1);
  } finally { f.ui.dispose(); }
});

test("stable selection survives reorder, per-tab filters survive Tab/Shift+Tab, removed selection clears details", () => {
  const f = fixture();
  try {
    f.ui.render(180); f.ui.handleInput(DOWN);
    f.state.snapshot!.peers.unshift(card("p_new")); f.tick();
    expect(details(f.ui)).toContain("task-p_other");
    // Tab works while editing too, preserving the per-view query without Enter.
    f.ui.handleInput("/"); f.ui.handleInput("other");
    f.ui.handleInput("\t"); expect(screen(f.ui)).toContain("[Mail]");
    f.ui.handleInput("\t"); expect(screen(f.ui)).toContain("[Offers]");
    f.ui.handleInput("\x1b[Z"); expect(screen(f.ui)).toContain("[Mail]");
    f.ui.handleInput("\x1b[Z"); expect(screen(f.ui)).toContain("Filter: other");
    expect(details(f.ui)).toContain("task-p_other");
    f.state.snapshot!.peers = []; f.tick();
    expect(screen(f.ui)).toContain("No matching records"); expect(details(f.ui)).toContain("No selection");
    expect(details(f.ui)).not.toContain("task-p_other");
  } finally { f.ui.dispose(); }
});

test("tiny/wide terminals, Unicode, resizing and long detail scrolling fill exactly the viewport", async () => {
  const f = fixture(async () => ({ ...mail, body: "狸".repeat(4000) + "\n" + "line\n".repeat(100) + "END OF BODY" }));
  try {
    for (let tab = 0; tab < 3; tab++) {
      for (const width of [1, 2, 10, 40, 80, 93, 94, 120, 180]) for (const rows of [1, 3, 6, 10, 12, 30]) {
        f.rows(rows); const lines = f.ui.render(width);
        expect(lines).toHaveLength(rows); expect(lines.every(line => visibleWidth(line) === width)).toBe(true);
      }
      f.ui.handleInput("\t");
    }
    f.rows(30); f.ui.handleInput("\t"); await Bun.sleep(0);
    expect(screen(f.ui, 80)).toContain("Message details"); expect(screen(f.ui, 80)).not.toContain(" │ ");
    f.ui.handleInput(RIGHT);
    for (let i = 0; i < 250; i++) { f.ui.handleInput(PAGE_DOWN); f.ui.render(80); }
    expect(screen(f.ui, 80)).toContain("Acknowledged:");
    // Returning to list focus does not lose the selected record.
    f.ui.handleInput(LEFT); expect(screen(f.ui, 180)).toContain("› m_one");
  } finally { f.ui.dispose(); }
});

test("close aborts pending read, detaches listener, fences late response; runtime close dismisses", async () => {
  let resolve!: (m: Mail) => void, signal: AbortSignal | undefined;
  const f = fixture((_id, s) => { signal = s; return new Promise(r => { resolve = r; }); });
  f.ui.handleInput("\t"); await Bun.sleep(0); f.ui.handleInput("\x1b");
  expect(signal?.aborted).toBe(true); expect(f.listeners.size).toBe(0);
  const counts = f.counts(); resolve({ ...mail, body: "late" }); await Bun.sleep(0);
  expect(f.counts()).toEqual(counts); f.ui.dispose(); expect(f.counts().closed).toBe(1);
  const g = fixture(); g.state.state = "closed"; g.tick(); expect(g.listeners.size).toBe(0); expect(g.counts().closed).toBe(1);
});

test("rapid navigation cancels stale reads without blocking keys or leaking late bodies/errors", async () => {
  const pending: { id: string; signal: AbortSignal; resolve: (m: Mail) => void; reject: (e: Error) => void }[] = [];
  const f = fixture((id, signal) => new Promise((resolve, reject) => pending.push({ id, signal, resolve, reject })));
  f.state.snapshot!.inbox.push({ ...mail, id: "m_two" }, { ...mail, id: "m_three" });
  try {
    f.ui.handleInput("\t"); await Bun.sleep(0); expect(pending[0]!.id).toBe("m_one");
    f.ui.handleInput(DOWN); await Bun.sleep(0); expect(pending[0]!.signal.aborted).toBe(true);
    expect(pending[1]!.id).toBe("m_two");
    pending[1]!.resolve({ ...mail, id: "m_two", body: "CURRENT BODY" }); await Bun.sleep(0);
    pending[0]!.resolve({ ...mail, body: "STALE BODY" }); await Bun.sleep(0);
    expect(details(f.ui)).toContain("CURRENT BODY"); expect(screen(f.ui)).not.toContain("STALE BODY");
    f.ui.handleInput(DOWN); await Bun.sleep(0); f.ui.handleInput("\t");
    pending[2]!.reject(new Error("STALE ERROR")); await Bun.sleep(0);
    expect(screen(f.ui)).toContain("[Offers]"); expect(screen(f.ui)).not.toContain("STALE ERROR");
  } finally { f.ui.dispose(); }
});

test("expired/changed mail metadata invalidates selected body; read failures wait for explicit refresh", async () => {
  let fail = false;
  const f = fixture(async () => { if (fail) throw new Error("service\x1b error"); return { ...mail, body: "retained body" }; });
  try {
    f.ui.handleInput("\t"); await Bun.sleep(0); expect(details(f.ui)).toContain("retained body");
    fail = true; f.clock(mail.expiresAt + 1); f.tick();
    expect(details(f.ui)).not.toContain("retained body"); await Bun.sleep(0);
    expect(details(f.ui)).toContain("service  error"); expect(f.counts().reads).toBe(2);
    f.tick(); f.ui.render(180); await Bun.sleep(0); expect(f.counts().reads).toBe(2);
    fail = false; f.ui.handleInput("r"); await Bun.sleep(0); expect(f.counts().reads).toBe(3);
  } finally { f.ui.dispose(); }
});

test("full and narrow layouts have readable, deterministic table/details snapshots", () => {
  const f = fixture();
  try {
    expect(screen(f.ui, 160)).toMatchSnapshot("wide sessions");
    expect(screen(f.ui, 80)).toMatchSnapshot("stacked sessions");
  } finally { f.ui.dispose(); }
});

test("columns align by display cells and grouped pagination never hides the selected row", () => {
  const sourceColumns = [
    { key: "title", label: "Title", width: 20, priority: 99 },
    { key: "status", label: "Status", width: 10, priority: 2 },
    { key: "model", label: "Model", width: 10, priority: 1 },
  ];
  const columns = tableColumns(sourceColumns, 60);
  for (const title of ["short", "狸".repeat(100), "👩‍💻 é ".repeat(40), "hostile\x1b[31m\u202e"]) {
    const line = stripStyle(tableLine({ title, status: "idle", model: "test-model" }, columns));
    expect(visibleWidth(line.slice(0, line.indexOf("idle")))).toBe(38);
    expect(visibleWidth(line)).toBe(60); expect(line).not.toContain("\x1b"); expect(line).not.toContain("\u202e");
  }
  expect(tableColumns(sourceColumns, 35).map(c => c.key)).toEqual(["title", "status"]);
  const rows = Array.from({ length: 40 }, (_, i) => ({ id: String(i), group: `/project/${Math.floor(i / 5)}`, cells: {}, search: "" }));
  for (const height of [1, 2, 3, 5, 10, 20]) for (const row of rows) {
    const window = tableWindow(rows, row.id, height);
    expect(window.length).toBeLessThanOrEqual(height);
    expect(window.some(line => "row" in line && line.row.id === row.id)).toBe(true);
  }
  const f = fixture();
  try {
    const paneRow = f.ui.render(160).find(line => line.includes(" │ "))!;
    expect(visibleWidth(paneRow.split(" │ ")[1]!)).toBe(40); // 38-cell pane + outer margin.
    f.state.snapshot!.peers = rows.map(row => card(row.id, { project: row.group }));
    f.ui.render(160); f.ui.handleInput(PAGE_DOWN);
    expect(f.ui.render(160).filter(line => line.includes("› "))).toHaveLength(1);
  } finally { f.ui.dispose(); }
});

test("compact stacked details show content, and IME cursor/theme controls survive safe framing", () => {
  const f = fixture();
  try {
    for (const height of [6, 7, 8, 10]) {
      f.rows(height);
      expect(screen(f.ui, 80)).toContain("Name:");
    }
    f.rows(30); f.ui.focused = true; f.ui.handleInput("/"); f.ui.handleInput("狸");
    expect(f.ui.render(80).join("\n")).toContain(CURSOR_MARKER);
    f.ui.handleInput("\x1b"); expect(f.counts().closed).toBe(0);
    expect(f.ui.render(80).join("\n")).not.toContain(CURSOR_MARKER);
    f.ui.handleInput("\x1b"); expect(f.counts().closed).toBe(1);
  } finally { f.ui.dispose(); }
});

test("offer selection is automatic and read-only; metadata changes fence old bodies and actions", async () => {
  const f = fixture();
  const offer: Offer = { id: "q_one", creator: "p_other", recipient: "p_self", project: "/project/.git", worktree: "/project",
    originalTask: "PRIVATE ORIGINAL TASK", authority: "human-ui", state: "offered", generation: 1, policyGeneration: 1,
    createdAt: now, updatedAt: now, expiresAt: now + 10000 };
  const { originalTask, ...summary } = offer;
  f.state.snapshot!.offers = [summary]; f.state.snapshot!.offerTotal = 1;
  const reads: { signal: AbortSignal; resolve: (o: Offer) => void }[] = [], actions: unknown[] = [];
  const ui = new Dashboard({ current: () => f.state, subscribe: () => () => {}, refresh: async () => {}, read: async () => mail,
    inspectOffer: (_id, signal) => new Promise(resolve => reads.push({ signal, resolve })),
  }, theme, keys, () => {}, () => {}, () => 30, () => now, action => actions.push(action));
  try {
    ui.showOffers(); ui.render(180); await Bun.sleep(0); expect(reads).toHaveLength(1); expect(actions).toHaveLength(0);
    ui.handleInput("s"); expect(actions).toHaveLength(0); // Loading is not an action target.
    f.state.snapshot!.offers![0] = { ...summary, state: "accepted", generation: 2 };
    ui.render(180); expect(reads[0]!.signal.aborted).toBe(true); await Bun.sleep(0);
    reads[0]!.resolve(offer); await Bun.sleep(0); expect(details(ui)).not.toContain(originalTask);
    reads[1]!.resolve({ ...offer, state: "accepted", generation: 2 }); await Bun.sleep(0);
    expect(details(ui)).toContain(originalTask); expect(details(ui)).toContain("Authority: human-ui"); expect(actions).toHaveLength(0);
    expect(screen(ui, 160)).toMatchSnapshot("offers table and automatic preview");
    expectTaskFacingCopy(screen(ui));
    ui.handleInput("a"); expect(actions).toEqual([{ action: "accept", id: "q_one" }]);
    f.state.snapshot!.offers = []; ui.handleInput("s"); expect(actions).toHaveLength(1);
    expect(details(ui)).toContain("No selection");
  } finally { ui.dispose(); f.ui.dispose(); }
});

test("selected-body retry works even when watch refresh fails; refresh errors stay sanitized", async () => {
  const f = fixture(); let reads = 0;
  const ui = new Dashboard({ current: () => f.state, subscribe: () => () => {},
    refresh: async () => { throw new Error("watch\x1b refresh failed"); },
    read: async () => { if (++reads === 1) throw new Error("peek unavailable"); return { ...mail, body: "retried successfully" }; },
  }, theme, keys, () => {}, () => {}, () => 30, () => now);
  try {
    ui.handleInput("\t"); await Bun.sleep(0); expect(details(ui)).toContain("peek unavailable");
    ui.handleInput("r"); await Bun.sleep(0);
    expect(details(ui)).toContain("retried successfully"); expect(screen(ui)).toContain("watch  refresh failed"); expect(reads).toBe(2);
  } finally { ui.dispose(); f.ui.dispose(); }
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
