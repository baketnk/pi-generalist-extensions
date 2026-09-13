import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, Text, matchesKey, truncateToWidth, visibleWidth, type Focusable, type Component } from "@earendil-works/pi-tui";
import type { BoardRuntime } from "./runtime.ts";
import { LEASE_MS, plain, type Card, type Mail, type Snapshot, type Offer } from "./shared.ts";

import type { OfferAction } from "./offers-ui.ts";

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
  inspectOffer?(id: string, signal: AbortSignal): Promise<Offer>;
}
const stamp = (time?: number) => time === undefined ? "unknown" : new Date(time).toISOString();
const age = (time: number | undefined, now: number) => time === undefined ? "unknown age" : `${Math.max(0, Math.floor((now - time) / 1000))}s ago`;
export function coverage(s: DashboardState, now: number): string {
  if (s.state !== "online") return `${s.state} · coverage unknown${s.snapshot ? " · retained snapshot is historical" : ""}`;
  if (!s.snapshot) return "starting subscription · coverage unknown";
  return `${s.snapshotAt === undefined || now - s.snapshotAt > LEASE_MS ? "stale" : "live"} · registered/partial project view · received ${age(s.snapshotAt, now)}`;
}
export function relationship(c: Card, own?: Card): string {
  if (c.id === own?.id) return "self";
  if (c.parentId === own?.id) return "direct child";
  if (c.id === own?.parentId) return "parent";
  if (own?.parentId && c.parentId === own.parentId) return "sibling";
  return "peer";
}
function cardDetails(c: Card, own: Card | undefined, now: number): string {
  return [
    `Participant: ${c.handle} (${c.id})`, `Task label (declared): ${c.name}`, `Summary (declared): ${c.summary || "none"}`,
    `Activity (adapter-reported): ${c.activity}; not task completion`,
    `Lease at observation: ${c.online ? "online" : "offline"}; heartbeat ${age(c.updatedAt, now)} (${stamp(c.updatedAt)})`,
    "Heartbeat age is not idle duration. Scheduling availability is not recorded.",
    `Relationship (service): ${relationship(c, own)}; parent ${c.parentId ?? "none"}; run link ${c.runId ?? "none"}`,
    "Run links do not report process state or collected results.",
    `Type: ${c.type}`, `Project: ${c.project}`, `Checkout: ${c.worktree}`, `Cwd: ${c.cwd}`,
    "Checkout identity is not a mutation grant, worktree isolation guarantee, or diff attribution.",
  ].map(plain).join("\n");
}
function mailDetails(m: Mail): string {
  return [
    `Mail: ${m.id} · ${m.kind}`, `From: ${m.senderHandle ?? m.sender} (${m.sender})`,
    `To: ${m.recipientHandle ?? m.recipient} (${m.recipient})`, `Reply to: ${m.replyTo ?? "none"}`,
    `Created: ${stamp(m.createdAt)}; expires: ${stamp(m.expiresAt)}`,
    `Fetched: ${stamp(m.fetchedAt)}; acknowledged: ${stamp(m.ackAt)}`,
    "External correspondence, not executable task authority. Viewing does not acknowledge or deliver to the model.",
    "", ...(m.body == null ? ["Body unavailable (expired or no longer retained)."] : m.body.split("\n")),
  ].map(plain).join("\n");
}

/** Model-free UI. Only metadata subscriptions and explicit refresh/body reads are capabilities. */
export class Dashboard implements Component, Focusable {
  private input = new Input();
  private searching = false;
  private _focused = false;
  get focused() { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.input.focused = value && this.searching; }
  private tab: "roster" | "inbox" | "offers" = "roster";
  private selected?: string;
  private list?: SelectList;
  private detail?: { text: Text; observed: string; offer?: Offer };
  private scroll = 0;
  private bodyHeight = 8;
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
      else this.update();
    });
    // Local age display only; never fetches or starts model work.
    this.timer = setInterval(() => this.update(), 1000); this.timer.unref();
  }
  private update() { if (!this.disposed) this.redraw(); }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.life.abort(); clearInterval(this.timer); this.unsubscribe();
  }
  close() { if (!this.disposed) { this.dispose(); this.done(); } }
  showOffers() { this.tab = "offers"; this.selected = undefined; this.input.setValue(""); }
  invalidate() { this.detail?.text.invalidate(); this.input.invalidate(); }
  private async operation(work: () => Promise<void>) {
    if (this.busy || this.disposed) return;
    this.busy = true; this.notice = ""; this.update();
    try { await work(); }
    catch (error) { if (!this.disposed) this.notice = plain(error instanceof Error ? error.message : "Dashboard operation failed"); }
    finally { this.busy = false; this.update(); }
  }
  private inspect(id: string) {
    const s = this.source.current();
    if (this.tab === "roster") {
      const card = [s.card, ...(s.snapshot?.peers ?? [])].find(c => c?.id === id);
      if (card) this.detail = { text: new Text(`${cardDetails(card, s.card, this.now())}\nSource snapshot generation: ${plain(s.snapshot?.version ?? "unknown")}`, 0, 0), observed: stamp(card.id === s.card?.id ? card.updatedAt : s.snapshotAt) };
      this.scroll = 0;
    } else if (this.tab === "offers") {
      void this.operation(async () => {
        if (!this.source.inspectOffer) throw new Error("Offer inspection unavailable.");
        const offer = await this.source.inspectOffer(id, this.life.signal);
        if (!this.disposed) {
          const content = [`Offer ${offer.id} · ${offer.state} · generation ${offer.generation}`,
            `Authority: ${offer.authority} (adapter-attested); creator ${offer.creator}; recipient ${offer.recipient}`,
            `Project: ${offer.project}`, `Checkout: ${offer.worktree}`,
            `Created: ${stamp(offer.createdAt)}; updated: ${stamp(offer.updatedAt)}; expires: ${stamp(offer.expiresAt)}`,
            "Acceptance, delivery, execution, and completion are separate facts.",
            ["delivery-claimed", "delivery-unknown"].includes(offer.state) ? "UNCERTAIN delivery: may or may not have reached Pi. Never automatically replay; inspect session history." : "Delivered means observed as a Pi user message, not completed or result-collected.",
            "Original human task (external text, preserved):", ...offer.originalTask.split("\n")].map(plain).join("\n");
          this.detail = { text: new Text(content, 0, 0), observed: stamp(this.now()), offer }; this.scroll = 0;
        }
      });
    } else {
      void this.operation(async () => {
        const mail = await this.source.read(id, this.life.signal);
        if (!this.disposed) { this.detail = { text: new Text(mailDetails(mail), 0, 0), observed: stamp(this.now()) }; this.scroll = 0; }
      });
    }
  }
  handleInput(data: string) {
    if (this.disposed) return;
    if (this.keys.matches(data, "tui.select.cancel")) {
      if (this.busy) this.close();
      else if (this.searching) { this.searching = false; this.input.focused = false; }
      else if (this.detail) this.detail = undefined;
      else this.close();
    } else if (this.busy) return;
    else if (this.searching) {
      if (this.keys.matches(data, "tui.select.confirm")) { this.searching = false; this.input.focused = false; }
      else {
        this.input.handleInput(data);
        const bounded = plain(this.input.getValue()).slice(0, 256);
        if (bounded !== this.input.getValue()) this.input.setValue(bounded);
        this.selected = undefined;
      }
    } else if (this.detail) {
      const action = ({ a: "accept", d: "decline", c: "cancel", s: "start", x: "resolve-unknown" } as const)[data as "a" | "d" | "c" | "s" | "x"];
      if (action && this.detail.offer) this.offerAction?.({ action, id: this.detail.offer.id });
      if (this.keys.matches(data, "tui.select.up")) this.scroll = Math.max(0, this.scroll - 1);
      if (this.keys.matches(data, "tui.select.down")) this.scroll++;
      if (this.keys.matches(data, "tui.select.pageUp")) this.scroll = Math.max(0, this.scroll - this.bodyHeight);
      if (this.keys.matches(data, "tui.select.pageDown")) this.scroll += this.bodyHeight;
    } else if (matchesKey(data, "tab")) {
      this.tab = this.tab === "roster" ? "inbox" : this.tab === "inbox" ? "offers" : "roster"; this.selected = undefined; this.input.setValue("");
    } else if (matchesKey(data, "o")) this.offerAction?.({ action: "create" });
    else if (matchesKey(data, "p")) this.offerAction?.({ action: "policy" });
    else if (matchesKey(data, "/")) { this.searching = true; this.input.focused = this.focused; }
    else if (matchesKey(data, "r")) void this.operation(async () => { await this.source.refresh(this.life.signal); });
    else this.list?.handleInput(data);
    this.update();
  }
  render(width: number): string[] {
    if (width < 1) return [];
    const s = this.source.current(), now = this.now(), snap = s.snapshot;
    const height = Math.max(1, Math.floor(this.rows() * 0.8));
    const status = this.theme.fg(s.state === "online" ? "muted" : "warning", coverage(s, now));
    const count = this.tab === "roster"
      ? `${snap?.peers.length ?? 0}/${snap?.total ?? "?"} other registrations + self; omitted ${snap ? Math.max(0, snap.total - snap.peers.length) : "unknown"}`
      : this.tab === "offers" ? `${snap?.offers?.length ?? 0}/${snap?.offerTotal ?? 0} offers; policy ${snap?.offerPolicy?.policy ?? "unknown"}; omitted ${Math.max(0, (snap?.offerTotal ?? 0) - (snap?.offers?.length ?? 0))}`
      : `${snap?.inbox.length ?? 0}/${snap?.pending ?? "?"} pending mail; omitted ${snap ? Math.max(0, snap.pending - snap.inbox.length) : "unknown"}`;
    const query = plain(this.input.getValue()).toLowerCase();
    const meta = this.detail ? `Inspection snapshot · observed ${this.detail.observed}` : `${this.tab === "roster" ? "[Roster] Inbox Offers" : this.tab === "inbox" ? "Roster [Inbox] Offers" : "Roster Inbox [Offers]"} · ${count}`;
    const filter = this.searching ? this.input.render(Math.max(1, width - 2))[0] ?? "" : `Filter: ${query || "none"} · ${this.busy ? "loading… (Esc cancels/closes)" : this.notice || s.error || "viewing is not acknowledgement"}`;
    const footer = this.detail ? "↑↓/PgUp/PgDn scroll · Esc back" : "↑↓ select · Enter inspect · Tab views · / filter · r refresh · Esc close";
    const controls = this.detail?.offer ? "a accept · d decline · c cancel · s start · x close uncertain"
      : this.detail ? "Snapshot only · activity/delivery ≠ completion" : "r refresh · o offer task · p offer policy";
    // Keep enough vertical room for a complete frame. Tiny terminals retain a
    // compact, borderless view rather than showing a clipped box without a bottom.
    const framed = width >= 3 && height >= 11;
    this.bodyHeight = Math.max(1, height - (framed ? 10 : 6));
    let body: string[];
    if (this.detail) {
      const lines = this.detail.text.render(width);
      this.scroll = Math.min(this.scroll, Math.max(0, lines.length - this.bodyHeight));
      body = lines.slice(this.scroll, this.scroll + this.bodyHeight);
    } else {
      const items = this.tab === "roster" ? [s.card, ...(snap?.peers ?? [])].filter((c): c is Card => !!c).map(c => ({
        value: c.id, label: plain(`${c.handle} · ${c.activity}${!c.online ? " (offline)" : now - c.updatedAt > LEASE_MS ? " (stale heartbeat)" : ""}`),
        description: plain(`${relationship(c, s.card)} · ${c.worktree === s.card?.worktree ? "same checkout" : c.worktree} · heartbeat ${age(c.updatedAt, now)} · ${c.name !== c.handle ? c.name + " · " : ""}${c.summary}`),
      })) : this.tab === "offers" ? (snap?.offers ?? []).map(o => ({ value: o.id,
        label: plain(`${o.id} · ${o.state} · ${o.recipient === s.card?.id ? "incoming" : "outgoing"}`),
        description: plain(`creator ${o.creator} → ${o.recipient} · generation ${o.generation} · expires ${stamp(o.expiresAt)}`),
      })) : (snap?.inbox ?? []).map(m => ({ value: m.id, label: plain(`${m.kind} · from ${m.senderHandle ?? m.sender} · ${m.id}`),
        description: plain(`created ${age(m.createdAt, now)} · expires ${stamp(m.expiresAt)} · ${m.fetchedAt ? "fetched, not acknowledged" : "not fetched"}`) }));
      const filtered = items.filter(i => `${i.value} ${i.label} ${i.description}`.toLowerCase().includes(query));
      this.list = new SelectList(filtered, this.bodyHeight, {
        selectedPrefix: t => this.theme.fg("accent", t), selectedText: t => this.theme.fg("accent", t),
        description: t => this.theme.fg("muted", t), scrollInfo: t => this.theme.fg("dim", t), noMatch: t => this.theme.fg("warning", t),
      });
      const index = Math.max(0, filtered.findIndex(i => i.value === this.selected));
      this.list.setSelectedIndex(index); this.selected = filtered[index]?.value;
      this.list.onSelectionChange = item => { this.selected = item.value; };
      this.list.onSelect = item => this.inspect(item.value);
      body = filtered.length ? this.list.render(width).slice(0, this.bodyHeight) : [snap ? "No matching registrations/mail/offers in this partial view." : "No snapshot; coverage unknown."];
    }
    while (body.length < this.bodyHeight) body.push("");
    if (!framed) {
      return [this.theme.fg("accent", this.theme.bold("Switchboard desk · no model calls")), status, meta, filter, ...body,
        this.theme.fg("dim", controls), this.theme.fg("dim", footer)]
        .slice(0, height).map(line => truncateToWidth(line, width, "…"));
    }
    const inner = width - 2;
    const border = (value: string) => this.theme.fg("borderAccent", value);
    const stripSgr = (value: string) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    const row = (value: string) => {
      // Detail and list renderers can include terminal resets; strip controls
      // before embedding them in the frame.
      const safe = plain(stripSgr(value));
      const clipped = stripSgr(truncateToWidth(safe, inner, "…"));
      return border("│") + clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped))) + border("│");
    };
    const divider = () => border(`├${"─".repeat(inner)}┤`);
    const title = stripSgr(truncateToWidth(" Switchboard desk · no model calls ", inner, "…"));
    const top = border("╭") + this.theme.fg("accent", this.theme.bold(title)) + border(`${"─".repeat(Math.max(0, inner - visibleWidth(title)))}╮`);
    const bottom = border(`╰${"─".repeat(inner)}╯`);
    const readOnlyHelp = "Inspect is read-only: it never messages or starts an agent. o offers a task; the recipient must accept, then start it.";
    return [top, row(status), row(meta), row(filter), divider(), ...body.map(row), divider(),
      row(this.theme.fg("dim", controls)), row(this.theme.fg("dim", footer)), row(this.theme.fg("dim", readOnlyHelp)), bottom];
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
          read: (id, signal) => runtime.requireClient().call<Mail>("read", { id }, signal),
          inspectOffer: (id, signal) => runtime.requireClient().call<Offer>("offer", { op: "inspect", id }, signal),
        }, theme, keys, () => tui.requestRender(), done, () => tui.terminal.rows, Date.now,
          onOffer ? selected => { action = selected; component?.close(); } : undefined);
        if (returningToOffers) component.showOffers();
        return component;
      }, { overlay: true, overlayOptions: { width: "95%", maxHeight: "80%" } });
    } finally { component?.dispose(); }
    if (action && onOffer && !runtime.closed) {
      try { await onOffer(action); }
      catch (error) { if (!runtime.closed) ctx.ui.notify(plain(error instanceof Error ? error.message : "Offer action failed"), "error"); }
      again = action.action !== "start"; returningToOffers = true;
    }
  }
}
