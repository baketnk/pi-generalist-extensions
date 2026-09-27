import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Input, Text, matchesKey, type Focusable, type Component } from "@earendil-works/pi-tui";
import type { BoardRuntime } from "./runtime.ts";
import { LEASE_MS, plain, type Card, type Directory, type Mail, type Snapshot, type Offer, type OfferSummary } from "./shared.ts";

import type { OfferAction } from "./offers-ui.ts";
import { fit, tableColumns, tableLine, tableWindow, type DashboardRow, type DashboardColumn } from "./dashboard-layout.ts";

type Tab = "agents" | "mail" | "offers";
type Row = DashboardRow & ({ kind: "agents"; value: Card } | { kind: "mail"; value: Mail } | { kind: "offers"; value: OfferSummary });
const TABS: Tab[] = ["agents", "mail", "offers"];
const COLUMNS: Record<Tab, DashboardColumn[]> = {
  agents: [
    { key: "title", label: "Sessions / Agents", width: 30, priority: 99 },
    { key: "handle", label: "Handle", width: 20, priority: 1 },
    { key: "status", label: "Status", width: 16, priority: 5 },
    { key: "model", label: "Model", width: 20, priority: 2 },
    { key: "relation", label: "Relation", width: 12, priority: 0 },
    { key: "time", label: "Heartbeat", width: 11, priority: 3 },
  ],
  mail: [
    { key: "title", label: "Message", width: 20, priority: 99 },
    { key: "status", label: "Status", width: 12, priority: 5 },
    { key: "kind", label: "Kind", width: 8, priority: 2 },
    { key: "from", label: "From", width: 18, priority: 4 },
    { key: "to", label: "To", width: 18, priority: 1 },
    { key: "time", label: "Created", width: 11, priority: 3 },
  ],
  offers: [
    { key: "title", label: "Offer", width: 20, priority: 99 },
    { key: "status", label: "State", width: 17, priority: 5 },
    { key: "direction", label: "Direction", width: 9, priority: 1 },
    { key: "to", label: "Recipient", width: 18, priority: 2 },
    { key: "time", label: "Updated", width: 11, priority: 3 },
  ],
};

const OPEN = "generalist:switchboard-dashboard:open";
type OpenRequest = { ctx: ExtensionContext; accept: (result: Promise<void>) => void };
/** Command-only bridge between independently loaded package extensions. No user-message dispatch. */
export function registerDashboardEntry(pi: ExtensionAPI, open: (ctx: ExtensionContext) => Promise<void>) {
  return pi.events.on(OPEN, data => { const request = data as OpenRequest; request.accept(open(request.ctx)); });
}
export async function requestDashboard(pi: ExtensionAPI, ctx: ExtensionContext) {
  let result: Promise<void> | undefined;
  pi.events.emit(OPEN, { ctx, accept: (value: Promise<void>) => { result = value; } } satisfies OpenRequest);
  if (!result) { if (ctx.hasUI) ctx.ui.notify("Switchboard dashboard unavailable; load the switchboard extension.", "warning"); return; }
  await result;
}

export interface DashboardState {
  state: BoardRuntime["state"]; error?: string; card?: Card; snapshot?: Snapshot; snapshotAt?: number;
}
export interface DashboardSource {
  current(): DashboardState;
  subscribe(listener: () => void): () => void;
  refresh(signal: AbortSignal): Promise<unknown>;
  read(id: string, signal: AbortSignal): Promise<Mail>;
  directory?(signal: AbortSignal): Promise<Directory>;
  mail?(signal: AbortSignal): Promise<{ pending: number; recent: number; messages: Mail[] }>;
  inspectOffer?(id: string, signal: AbortSignal): Promise<Offer>;
}
const stamp = (time?: number) => time == null ? "unknown" : new Date(time).toISOString();
const age = (time: number | undefined, now: number) => time === undefined ? "unknown age" : `${Math.max(0, Math.floor((now - time) / 1000))}s ago`;
export function coverage(s: DashboardState, now: number): string {
  if (s.state !== "online") return `Status: ${s.state}${s.snapshot ? " · Data: cached" : ""}`;
  if (!s.snapshot) return "Status: loading";
  return `Status: ${s.snapshotAt === undefined || now - s.snapshotAt > LEASE_MS ? "stale" : "live"} · Updated: ${age(s.snapshotAt, now)}`;
}
export function relationship(c: Card, own?: Card): string {
  if (c.id === own?.id) return "self";
  if (c.parentId === own?.id) return "direct child";
  if (c.id === own?.parentId) return "parent";
  if (own?.parentId && c.parentId === own.parentId) return "sibling";
  return "peer";
}
// Names/summaries are declared; activity is adapter-reported, not completion.
// Heartbeat age is not idle duration. Run links do not prove process state/results,
// and checkout identity grants neither mutation authority nor worktree isolation.
function cardDetails(c: Card, own: Card | undefined, now: number): string {
  return [
    `Name: ${c.name}`, `Activity: ${c.activity}`, `Model: ${c.model || "unknown"}`, `Summary: ${c.summary || "none"}`, "",
    `Participant: ${c.handle}`, `ID: ${c.id}`, `Relationship: ${relationship(c, own)}`,
    `Project: ${c.project}`, `Checkout: ${c.worktree}`, `Cwd: ${c.cwd}`, "",
    `Status: ${c.online ? "online" : c.retired ? "retired" : "offline"}`,
    `Heartbeat: ${age(c.updatedAt, now)} (${stamp(c.updatedAt)})`, `Registered: ${stamp(c.createdAt)}`,
    `Parent: ${c.parentId ?? "none"}`, `Run: ${c.runId ?? "none"}`, `Type: ${c.type}`,
  ].map(plain).join("\n");
}
// External correspondence stays human-only: previewing changes no receipts and
// supplies no task authority. Keep that contract here, not in every message pane.
function mailDetails(m: Mail): string {
  return [
    `${m.kind} · From: ${m.senderHandle ?? m.sender}`, `To: ${m.recipientHandle ?? m.recipient}`, "",
    ...(m.body == null ? ["Body: unavailable"] : m.body.split("\n")), "",
    `Mail: ${m.id}`, `Sender ID: ${m.sender}`, `Recipient ID: ${m.recipient}`, `Reply to: ${m.replyTo ?? "none"}`,
    `Created: ${stamp(m.createdAt)}`, `Expires: ${stamp(m.expiresAt)}`,
    `Fetched: ${stamp(m.fetchedAt)}`, `Acknowledged: ${stamp(m.ackAt)}`,
  ].map(plain).join("\n");
}

/** Model-free viewer. Selection reads use peek, never receipts or context publication. */
export class Dashboard implements Component, Focusable {
  private input = new Input();
  private searching = false;
  private _focused = false;
  get focused() { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.input.focused = value && this.searching; }
  private tab: Tab = "agents";
  private views: Record<Tab, { selected?: string; query: string }> = {
    agents: { query: "" }, mail: { query: "" }, offers: { query: "" },
  };
  private directory?: Directory;
  private mailbox?: { pending: number; recent: number; messages: Mail[] };
  private directoryAt?: number;
  private mailAt?: number;
  private lastLoad?: number;
  private loading = false;
  private selected?: string;
  private detail?: { text: Text; observed: string; offer?: Offer };
  private detailKey?: string;
  private detailRequest?: AbortController;
  private scroll = 0;
  private listHeight = 8;
  private detailHeight = 8;
  private detailsFocused = false;
  private busy = false;
  private notice = "";
  private disposed = false;
  private life = new AbortController();
  private unsubscribe: () => void;
  private timer: ReturnType<typeof setInterval>;
  private source: DashboardSource;
  private theme: Theme;
  private keys: { matches(data: string, action: any): boolean };
  private redraw: () => void;
  private done: () => void;
  private rows: () => number;
  private now: () => number;
  private offerAction?: (action: OfferAction) => void;
  constructor(source: DashboardSource, theme: Theme,
    keys: { matches(data: string, action: any): boolean }, redraw: () => void,
    done: () => void, rows: () => number, now = Date.now,
    offerAction?: (action: OfferAction) => void) {
    this.source = source; this.theme = theme; this.keys = keys; this.redraw = redraw;
    this.done = done; this.rows = rows; this.now = now; this.offerAction = offerAction;
    this.unsubscribe = source.subscribe(() => {
      if (source.current().state === "closed") this.close();
      else { this.reconcile(); this.update(); }
    });
    this.timer = setInterval(() => {
      if (this.lastLoad !== undefined && this.now() - this.lastLoad >= 15_000 && !this.busy && source.current().state === "online") void this.load();
      this.reconcile(); this.update();
    }, 1000); this.timer.unref();
  }
  private update() { if (!this.disposed) this.redraw(); }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.life.abort(); this.detailRequest?.abort();
    clearInterval(this.timer); this.unsubscribe();
  }
  close() { if (!this.disposed) { this.dispose(); this.done(); } }
  private switchTab(tab: Tab) {
    this.views[this.tab] = { selected: this.selected, query: this.input.getValue() };
    this.tab = tab; this.selected = this.views[tab].selected; this.input.setValue(this.views[tab].query);
    this.detailsFocused = false; this.resetDetail();
  }
  showOffers() { this.switchTab("offers"); }
  /** Separate human-only reads; never replace the adapter's project-scoped watch. */
  async load() {
    if ((!this.source.directory && !this.source.mail) || this.loading || this.disposed) return;
    this.loading = true; this.lastLoad = this.now();
    try {
      const [directory, mailbox] = await Promise.allSettled([
        this.source.directory?.(this.life.signal), this.source.mail?.(this.life.signal),
      ]);
      if (this.disposed) return;
      if (directory.status === "fulfilled" && directory.value) { this.directory = directory.value; this.directoryAt = this.now(); }
      if (mailbox.status === "fulfilled" && mailbox.value) { this.mailbox = mailbox.value; this.mailAt = this.now(); }
      const failure = [directory, mailbox].find(result => result.status === "rejected");
      this.notice = failure?.status === "rejected" ? plain(failure.reason instanceof Error ? failure.reason.message : "Dashboard refresh failed") : "";
      this.reconcile();
    } catch (error) { if (!this.disposed) this.notice = plain(error instanceof Error ? error.message : "Dashboard refresh failed"); }
    finally { this.loading = false; this.update(); }
  }
  invalidate() { this.detail?.text.invalidate(); this.input.invalidate(); }
  private async refresh() {
    if (this.busy || this.disposed) return;
    this.busy = true; this.notice = ""; this.update();
    try { await this.source.refresh(this.life.signal); await this.load(); }
    catch (error) { if (!this.disposed) this.notice = plain(error instanceof Error ? error.message : "Dashboard refresh failed"); }
    finally {
      // A failed watch refresh must not prevent an independent selected-body retry.
      this.busy = false; this.resetDetail(); this.reconcile(); this.update();
    }
  }
  private items(): Row[] {
    const s = this.source.current(), now = this.now();
    let rows: Row[];
    if (this.tab === "agents") {
      const agents = this.directory?.agents ?? [s.card, ...(s.snapshot?.peers ?? [])].filter((c): c is Card => !!c);
      rows = [...agents].sort((a, b) => a.project.localeCompare(b.project) ||
        (a.parentId ?? a.id).localeCompare(b.parentId ?? b.id) || Number(!!a.parentId) - Number(!!b.parentId) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
        .map(c => ({ kind: "agents", value: c, id: c.id, group: c.project,
          cells: { title: (c.parentId ? "↳ " : "") + (c.name || c.handle), handle: c.handle,
            status: c.retired ? "retired" : !c.online ? "offline" : now - c.updatedAt > LEASE_MS ? "stale heartbeat" : c.activity,
            model: c.model || "not reported", relation: relationship(c, s.card), time: age(c.updatedAt, now) },
          search: [c.id, c.handle, c.name, c.summary, c.project, c.worktree, c.cwd, c.model, c.activity, c.parentId, relationship(c, s.card)].join(" "),
        }));
    } else if (this.tab === "mail") {
      rows = (this.mailbox?.messages ?? s.snapshot?.inbox ?? []).map(m => ({ kind: "mail", value: m, id: m.id,
        cells: { title: m.id, status: m.ackAt != null ? "acknowledged" : m.expiresAt <= now ? "expired" : m.fetchedAt != null ? "fetched" : "unread",
          kind: m.kind, from: m.senderHandle ?? m.sender, to: m.recipientHandle ?? m.recipient, time: age(m.createdAt, now) },
        search: [m.id, m.sender, m.recipient, m.senderHandle, m.recipientHandle, m.kind, m.replyTo].join(" "),
      }));
    } else {
      rows = (s.snapshot?.offers ?? []).map(o => ({ kind: "offers", value: o, id: o.id,
        cells: { title: o.id, status: o.state, direction: o.recipient === s.card?.id ? "incoming" : "outgoing", to: o.recipient, time: age(o.updatedAt, now) },
        search: [o.id, o.creator, o.recipient, o.project, o.worktree, o.state].join(" "),
      }));
    }
    const query = plain(this.input.getValue()).toLowerCase();
    return rows.filter(row => plain(row.search + " " + Object.values(row.cells).join(" ")).toLowerCase().includes(query));
  }
  private resetDetail() {
    this.detailRequest?.abort(); this.detailRequest = undefined; this.detailKey = undefined;
    this.detail = undefined; this.scroll = 0;
  }
  private reconcile(): Row[] {
    if (this.disposed) return [];
    const rows = this.items();
    if (!rows.some(row => row.id === this.selected)) this.selected = rows[0]?.id;
    this.syncDetail(rows.find(row => row.id === this.selected));
    return rows;
  }
  private syncDetail(row?: Row) {
    if (!row) { this.resetDetail(); return; }
    const s = this.source.current();
    if (row.kind === "agents") {
      if (this.detailKey !== row.id) this.resetDetail();
      this.detailKey = row.id;
      const content = cardDetails(row.value, s.card, this.now());
      this.detail = { text: new Text(content, 0, 0), observed: stamp(this.directory ? this.directoryAt : s.snapshotAt) };
      return;
    }
    // Metadata/expiry changes invalidate the selected body. Ordinary render/age ticks do not fetch.
    const key = JSON.stringify([row.kind, row.value, row.value.expiresAt <= this.now(), s.state === "online"]);
    if (key === this.detailKey) return;
    this.resetDetail(); this.detailKey = key;
    if (s.state !== "online") {
      this.detail = { text: new Text("Details: unavailable", 0, 0), observed: "unknown" };
      return;
    }
    const controller = new AbortController(); this.detailRequest = controller;
    this.detail = { text: new Text("Loading selected " + (row.kind === "mail" ? "message" : "offer") + "…", 0, 0), observed: "pending" };
    // Rendering may reconcile selection. Defer I/O and fence rapid navigation, tab changes and close.
    queueMicrotask(async () => {
      if (this.disposed || controller.signal.aborted) return;
      try {
        let content: string, offer: Offer | undefined;
        if (row.kind === "mail") content = mailDetails(await this.source.read(row.id, controller.signal));
        else {
          if (!this.source.inspectOffer) throw new Error("Offer inspection unavailable.");
          offer = await this.source.inspectOffer(row.id, controller.signal);
          // Human origin is adapter-attested. Acceptance, delivery and completion
          // remain separate; uncertain delivery is never permission to replay.
          content = ["Offer: " + offer.id, "State: " + offer.state, "Generation: " + offer.generation,
            "Task:", ...offer.originalTask.split("\n"), "",
            "Authority: " + offer.authority, "Creator: " + offer.creator, "Recipient: " + offer.recipient,
            "Project: " + offer.project, "Checkout: " + offer.worktree,
            "Created: " + stamp(offer.createdAt), "Updated: " + stamp(offer.updatedAt), "Expires: " + stamp(offer.expiresAt)]
            .map(plain).join("\n");
        }
        if (!this.disposed && !controller.signal.aborted && key === this.detailKey) {
          this.detail = { text: new Text(content, 0, 0), observed: stamp(this.now()), offer };
          this.update();
        }
      } catch (error) {
        if (!this.disposed && !controller.signal.aborted && key === this.detailKey) {
          this.detail = { text: new Text(plain(error instanceof Error ? error.message : "Detail read failed") + "\nr retry", 0, 0), observed: "unavailable" };
          this.update();
        }
      }
    });
  }
  handleInput(data: string) {
    if (this.disposed) return;
    const rows = this.reconcile();
    if (this.keys.matches(data, "tui.select.cancel")) {
      if (this.searching) { this.searching = false; this.input.focused = false; }
      else this.close();
    } else if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      this.searching = false; this.input.focused = false;
      this.switchTab(TABS[(TABS.indexOf(this.tab) + (matchesKey(data, "tab") ? 1 : 2)) % 3]!);
    } else if (this.searching) {
      if (this.keys.matches(data, "tui.select.confirm")) { this.searching = false; this.input.focused = false; }
      else {
        this.input.handleInput(data);
        const bounded = plain(this.input.getValue()).slice(0, 256);
        if (bounded !== this.input.getValue()) this.input.setValue(bounded);
      }
    } else if (matchesKey(data, "left")) this.detailsFocused = false;
    else if (matchesKey(data, "right")) this.detailsFocused = true;
    else if (matchesKey(data, "o")) this.offerAction?.({ action: "create" });
    else if (matchesKey(data, "p")) this.offerAction?.({ action: "policy" });
    else if (matchesKey(data, "/")) { this.searching = true; this.input.focused = this.focused; }
    else if (matchesKey(data, "r")) void this.refresh();
    else {
      const action = ({ a: "accept", d: "decline", c: "cancel", s: "start", x: "resolve-unknown" } as const)[data as "a" | "d" | "c" | "s" | "x"];
      const offer = this.detail?.offer;
      if (action && this.tab === "offers" && offer && offer.id === this.selected) this.offerAction?.({ action, id: offer.id });
      const up = this.keys.matches(data, "tui.select.up"), down = this.keys.matches(data, "tui.select.down");
      const pageUp = this.keys.matches(data, "tui.select.pageUp"), pageDown = this.keys.matches(data, "tui.select.pageDown");
      if (up || down || pageUp || pageDown) {
        const amount = (up || pageUp ? -1 : 1) * (pageUp || pageDown ? (this.detailsFocused ? this.detailHeight : this.listHeight) : 1);
        if (this.detailsFocused) this.scroll = Math.max(0, this.scroll + amount);
        else {
          const index = Math.max(0, rows.findIndex(row => row.id === this.selected));
          this.selected = rows[Math.max(0, Math.min(rows.length - 1, index + amount))]?.id;
        }
      }
    }
    this.reconcile(); this.update();
  }
  private detailLines(width: number, height: number): string[] {
    const headingHeight = height >= 4 ? 2 : height >= 2 ? 1 : 0;
    this.detailHeight = Math.max(1, height - headingHeight);
    const text = this.detail?.text.render(width) ?? ["No selection."];
    this.scroll = Math.min(this.scroll, Math.max(0, text.length - this.detailHeight));
    const title = (this.tab === "agents" ? "Session details" : this.tab === "mail" ? "Message details" : "Offer details") + (this.detailsFocused ? " ‹ focused" : "");
    const observed = Date.parse(this.detail?.observed ?? "");
    const headings = [this.theme.fg("accent", this.theme.bold(title)),
      this.theme.fg("dim", "Snapshot " + (Number.isNaN(observed) ? this.detail?.observed ?? "—" : age(observed, this.now())) + " · " + (this.scroll + 1) + "/" + text.length)];
    const lines = [...headings.slice(0, headingHeight), ...text.slice(this.scroll, this.scroll + this.detailHeight)];
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }
  render(width: number): string[] {
    if (width < 1) return [];
    const s = this.source.current(), now = this.now(), snap = s.snapshot;
    const height = Math.max(1, Math.floor(this.rows()));
    const rows = this.reconcile();
    const margin = width >= 10 ? 2 : 0, inner = Math.max(1, width - margin * 2);
    const status = this.directory && this.tab === "agents" && s.state === "online"
      ? "Status: " + (this.directoryAt !== undefined && now - this.directoryAt > LEASE_MS ? "stale" : "live") + " · Updated: " + age(this.directoryAt, now)
      : this.mailbox && this.tab === "mail" && s.state === "online"
        ? "Status: " + (this.mailAt !== undefined && now - this.mailAt > LEASE_MS ? "stale" : "live") + " · Updated: " + age(this.mailAt, now)
        : coverage(s, now);
    // The directory is a bounded registration view, not a session/process census.
    // Offline retention is based on registration start, not last activity.
    const count = this.tab === "agents"
      ? this.directory ? `Agents: ${this.directory.agents.length}/${this.directory.total} · Projects: all · Recent: ${this.directory.recentWindowMs / 3_600_000}h · Omitted: ${this.directory.total - this.directory.agents.length}`
        : `Peers: ${snap?.peers.length ?? 0}/${snap?.total ?? "?"} · Self: ${s.card ? 1 : 0} · Omitted: ${snap ? Math.max(0, snap.total - snap.peers.length) : "unknown"}`
      : this.tab === "offers" ? `Offers: ${snap?.offers?.length ?? 0}/${snap?.offerTotal ?? 0} · Policy: ${snap?.offerPolicy?.policy ?? "unknown"} · Omitted: ${Math.max(0, (snap?.offerTotal ?? 0) - (snap?.offers?.length ?? 0))}`
      : this.mailbox ? `Pending: ${this.mailbox.pending} · Recent: ${this.mailbox.recent}`
        : `Pending: ${snap?.inbox.length ?? 0}/${snap?.pending ?? "?"} · Omitted: ${snap ? Math.max(0, snap.pending - snap.inbox.length) : "unknown"}`;
    const tabs = TABS.map(tab => {
      const label = tab === "agents" ? "Sessions/Agents" : tab === "mail" ? "Mail" : "Offers";
      return tab === this.tab ? this.theme.fg("accent", this.theme.bold("[" + label + "]")) : this.theme.fg("muted", label);
    }).join("   ");
    const filter = this.searching ? this.input.render(inner)[0] ?? "" : plain(this.notice || s.error ||
      (this.busy || this.loading ? "Refreshing…" : "Filter: " + (this.input.getValue() || "none") + " · " + "Matches: " + rows.length));
    const header = [this.theme.fg("accent", this.theme.bold("Switchboard command center")),
      tabs, this.theme.fg(s.state === "online" ? "dim" : "warning", status), this.theme.fg("dim", count), filter,
      this.theme.fg("borderMuted", "─".repeat(inner))];
    const navigation = inner >= 110
      ? "Tab/Shift+Tab views · ↑↓/PgUp/PgDn " + (this.detailsFocused ? "scroll details" : "select") + " · ←/→ pane · / filter · r refresh · Esc close"
      : "Esc close · Tab views · ↑↓ " + (this.detailsFocused ? "scroll" : "select") + " · ←/→ pane · / filter · r refresh";
    const footer = [this.theme.fg("dim", navigation),
      this.theme.fg("dim", this.tab === "offers" ? "o offer · p policy · a accept · d decline · c cancel · s start · x resolve" : "o offer task · p offer policy")];
    // Short terminals prioritize rows and one footer over the auxiliary header.
    const head = height >= 12 ? header : height >= 6 ? [header[1]!, header[4]!] : [];
    const foot = height >= 12 ? footer : height >= 2 ? [footer[0]!] : [];
    const bodyHeight = Math.max(1, height - head.length - foot.length);
    const sideBySide = inner >= 90;
    const detailWidth = sideBySide ? 38 : inner;
    const tableWidth = sideBySide ? inner - detailWidth - 3 : inner;
    const tableHeight = sideBySide ? bodyHeight : bodyHeight >= 3 ? Math.max(1, Math.floor((bodyHeight - 1) / 2)) : bodyHeight;
    this.listHeight = Math.max(1, tableHeight - 1);
    const columns = tableColumns(COLUMNS[this.tab], tableWidth);
    const table = tableHeight > 1 ? [this.theme.fg(this.detailsFocused ? "muted" : "accent", tableLine(Object.fromEntries(columns.map(c => [c.key, c.label])), columns))] : [];
    for (const line of tableWindow(rows, this.selected, this.listHeight)) {
      table.push("group" in line ? this.theme.fg("dim", plain(line.group)) :
        this.theme.fg(line.row.id === this.selected ? "accent" : "text", tableLine(line.row.cells, columns, line.row.id === this.selected)));
    }
    if (!rows.length) table.push("No matching records.");
    while (table.length < tableHeight) table.push("");
    let body: string[];
    if (sideBySide) {
      const detail = this.detailLines(detailWidth, bodyHeight);
      body = table.slice(0, tableHeight).map((line, i) => fit(line, tableWidth) + this.theme.fg("borderMuted", " │ ") + fit(detail[i] ?? "", detailWidth));
    } else {
      body = table.slice(0, tableHeight);
      if (bodyHeight > tableHeight) body.push(this.theme.fg("borderMuted", "─".repeat(inner)), ...this.detailLines(detailWidth, bodyHeight - tableHeight - 1));
    }
    const lines = [...head, ...body, ...foot].slice(0, height);
    while (lines.length < height) lines.push("");
    // Only generated styling/input controls reach here; external data was sanitized at its boundary.
    return lines.map(line => " ".repeat(margin) + fit(line, inner) + " ".repeat(margin));
  }
}

export async function openDashboard(ctx: ExtensionContext, runtime: BoardRuntime, onOffer?: (action: OfferAction) => Promise<void>) {
  if (ctx.mode !== "tui") { if (ctx.hasUI) ctx.ui.notify("Switchboard dashboard requires TUI mode; use /switchboard status or CLI watch.", "warning"); return; }
  let again = true, returningToOffers = false;
  while (again && !runtime.closed) {
    again = false;
    let component: Dashboard | undefined, action: OfferAction | undefined;
    try {
      await ctx.ui.custom<void>((tui, theme, keys, done) => {
        component = new Dashboard({
          current: () => runtime,
          subscribe: fn => runtime.subscribe(fn),
          refresh: signal => runtime.refresh(signal),
          read: (id, signal) => runtime.requireClient().call<Mail>("peek", { id }, signal),
          directory: signal => runtime.requireClient().call<Directory>("directory", {}, signal),
          mail: signal => runtime.requireClient().call<{ pending: number; recent: number; messages: Mail[] }>("mail", { recent: 50 }, signal),
          inspectOffer: (id, signal) => runtime.requireClient().call<Offer>("offer", { op: "inspect", id }, signal),
        }, theme, keys, () => tui.requestRender(), done, () => tui.terminal.rows, Date.now,
          onOffer ? selected => { action = selected; component?.close(); } : undefined);
        if (returningToOffers) component.showOffers();
        void component.load();
        return component;
      }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 } });
    } finally { component?.dispose(); }
    if (action && onOffer && !runtime.closed) {
      try { await onOffer(action); }
      catch (error) { if (!runtime.closed) ctx.ui.notify(plain(error instanceof Error ? error.message : "Offer action failed"), "error"); }
      again = action.action !== "start"; returningToOffers = true;
    }
  }
}
