import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { BoardClient, bindingAt, ensureService, UpgradeRequired, type Binding } from "./client.ts";
import { atomicJson, clipped, hash, jsonFile, plain, projectAt, type Activity, type Card, type Paths, type Snapshot } from "./shared.ts";

export type WakeReason = "mail" | "user_input" | "timeout" | "unavailable" | "closed";
export class WakeHub {
  listeners = new Set<(reason: WakeReason) => void>();
  emit(reason: WakeReason) { for (const fn of [...this.listeners]) fn(reason); }
  wait(milliseconds: number, ready: () => WakeReason | undefined, signal?: AbortSignal): Promise<WakeReason> {
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); clearInterval(checker); this.listeners.delete(finish); signal?.removeEventListener("abort", abort); };
      const finish = (reason: WakeReason) => { cleanup(); resolve(reason); };
      const abort = () => { cleanup(); reject(signal?.reason ?? new Error("Wait aborted.")); };
      const timer = setTimeout(() => finish("timeout"), milliseconds);
      const checker = setInterval(() => { const reason = ready(); if (reason) finish(reason); }, 100);
      this.listeners.add(finish); signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort(); else { const reason = ready(); if (reason) finish(reason); }
    });
  }
}
export interface RuntimeOptions {
  paths: Paths; cwd: string; sessionId: string; sessionFile?: string; name?: string;
  mode: string; workerFile?: string; disabled?: boolean;
  onChange?: () => void; onReload?: () => void; ensure?: typeof ensureService; intervalMs?: number;
}
export class BoardRuntime {
  options: RuntimeOptions;
  state: "starting" | "off" | "online" | "unavailable" | "closed" = "starting";
  error?: string; card?: Card; snapshot?: Snapshot; client?: BoardClient;
  upgradeVersion?: number;
  snapshotAt?: number;
  private observers = new Set<() => void>();
  /** Human views share the existing watch; no second socket or context publication. */
  subscribe(listener: () => void): () => void {
    if (this.closed) return () => {};
    this.observers.add(listener);
    return () => { this.observers.delete(listener); };
  }
  binding?: Binding; bindingFile?: string; policyFile?: string;
  inputCard?: { name: string; summary: string; activity: Activity; project: string; worktree: string; cwd: string };
  wake = new WakeHub();
  private life = new AbortController();
  private watching?: AbortController;
  private timer?: ReturnType<typeof setInterval>;
  private syncTail: Promise<void> = Promise.resolve();
  private diskTail: Promise<void> = Promise.resolve();
  private initial?: Promise<void>;
  private earlyActivity: Activity = "idle";
  private reloadClaiming = false;
  private reloadQueued = false;
  private upgradeClaiming = false;
  constructor(options: RuntimeOptions) { this.options = options; }
  get manual() { return this.binding?.manual === true; }
  get closed() { return this.life.signal.aborted; }
  start(): Promise<void> { return this.initial ??= this.initialize(); }
  private async initialize() {
    try {
      if (this.options.disabled || (this.options.mode !== "tui" && !this.options.workerFile)) { this.state = "off"; this.changed(); return; }
      const project = await projectAt(this.options.cwd);
      this.life.signal.throwIfAborted();
      const sessionFile = this.options.sessionFile ? await realpath(this.options.sessionFile).catch(() => this.options.sessionFile!) : "ephemeral";
      const { binding, file } = await bindingAt(this.options.paths, JSON.stringify([this.options.sessionId, sessionFile]));
      this.binding = binding; this.bindingFile = file;
      if (this.options.workerFile) {
        const worker = await jsonFile<{ token: string } | undefined>(this.options.workerFile, undefined);
        if (!worker || !/^[a-f0-9]{64}$/.test(worker.token)) throw new Error("Invalid private worker capability file.");
        // The launch contract supplies the worker capability; never publish it in session history.
        binding.token = worker.token;
      }
      this.client = new BoardClient(this.options.paths, binding.token);
      this.policyFile = join(this.options.paths.root, `project-${hash(project.project)}.json`);
      this.inputCard = { ...project, name: clipped(plain(this.options.name || ""), 160), summary: "", activity: this.earlyActivity };
      this.life.signal.throwIfAborted();
      await this.sync();
      if (!this.closed) { this.timer = setInterval(() => void this.sync(), this.options.intervalMs ?? 15_000); this.timer.unref(); }
    } catch (e) { if (!this.closed) this.unavailable(e); }
  }
  private changed() {
    if (!this.closed) this.options.onChange?.();
    for (const listener of [...this.observers]) {
      try { listener(); } catch { this.observers.delete(listener); } // A disposed/broken view must not break the service watch.
    }
  }
  private unavailable(error: unknown) {
    if (error instanceof UpgradeRequired) this.upgradeVersion = error.daemonVersion;
    this.state = "unavailable"; this.error = plain(error instanceof Error ? error.message : "Coordination unavailable");
    this.watching?.abort(); this.watching = undefined; this.wake.emit("unavailable"); this.changed();
  }
  sync(): Promise<void> {
    const next = this.syncTail.then(async () => {
      if (this.closed || !this.client || !this.inputCard) return;
      try {
        const policy = await jsonFile<{ off?: boolean }>(this.policyFile!, {});
        if (this.binding!.off || policy.off) {
          this.watching?.abort(); this.watching = undefined;
          if (this.state === "online") await this.client.call("detach", {}, this.life.signal).catch(() => {});
          this.state = "off"; this.snapshot = undefined; this.wake.emit("unavailable"); this.changed(); return;
        }
        if (this.state !== "online") {
          await (this.options.ensure ?? ensureService)(this.options.paths, this.life.signal);
          this.card = await this.client.connect(this.inputCard, "agent", this.life.signal, !!this.options.workerFile);
        } else this.card = await this.client.call<Card>("heartbeat", { card: this.inputCard }, this.life.signal);
        if (this.closed) return;
        this.state = "online"; this.error = undefined; this.upgradeVersion = undefined;
        if (!this.watching) {
          const watcher = new AbortController(); this.watching = watcher;
          void this.watch(watcher);
        }
        this.changed();
      } catch (e) { if (!this.closed) this.unavailable(e); }
    });
    this.syncTail = next.catch(() => {}); return next;
  }
  private async watch(watcher: AbortController) {
    try {
      let since: string | undefined;
      while (!this.closed && !watcher.signal.aborted) {
        const snapshot = await this.client!.call<Snapshot>("watch", { since }, watcher.signal);
        if (this.closed || watcher.signal.aborted) return;
        since = snapshot.version; this.accept(snapshot);
      }
    } catch (e) { if (!this.closed && !watcher.signal.aborted) this.unavailable(e); }
  }
  accept(snapshot: Snapshot) {
    const old = new Set(this.snapshot?.inbox.map(m => m.id));
    this.snapshot = snapshot; this.snapshotAt = Date.now();
    if (snapshot.inbox.some(m => !old.has(m.id))) this.wake.emit("mail");
    if (snapshot.reloadPending && !this.reloadClaiming && !this.reloadQueued) void this.claimReload();
    this.changed();
  }
  private async claimReload() {
    this.reloadClaiming = true;
    try {
      const result = await this.requireClient().takeReload(this.life.signal);
      if (!this.closed && result.pending) { this.reloadQueued = true; this.options.onReload?.(); }
    } catch (e) { if (!this.closed) this.unavailable(e); }
    finally { this.reloadClaiming = false; }
  }
  async refresh(signal?: AbortSignal): Promise<Snapshot> {
    const snapshot = await this.requireClient().snapshot(signal);
    if (!this.closed) this.accept(snapshot);
    return snapshot;
  }
  requireClient(): BoardClient {
    if (this.closed || this.state !== "online" || !this.client) throw new Error(`Switchboard ${this.state}${this.error ? `: ${this.error}` : ""}.`);
    return this.client;
  }
  update(input: { name?: string; summary?: string; activity?: Activity }) {
    if (input.activity) this.earlyActivity = input.activity;
    if (input.name !== undefined) this.options.name = input.name;
    if (!this.inputCard) return;
    if (input.name !== undefined) this.inputCard.name = clipped(plain(input.name), 160);
    if (input.summary !== undefined) this.inputCard.summary = clipped(plain(input.summary), 480);
    if (input.activity) this.inputCard.activity = input.activity;
    // Serialize publication with reconnect/disable so old callbacks cannot reattach.
    void this.sync();
  }
  async saveBinding() {
    const next = this.diskTail.then(() => this.bindingFile && this.binding ? atomicJson(this.bindingFile, this.binding) : undefined);
    this.diskTail = next.then(() => {}, () => {}); await next;
  }
  /** UI supplies settled/no-pending-input readiness. Persist BEFORE enqueue to avoid
   * reload loops when the installed source is still older than the daemon. */
  async reloadForUpgrade(idle: () => boolean): Promise<void> {
    const version = this.upgradeVersion;
    if (!idle() || this.options.mode !== "tui" || !version || !this.binding || this.closed ||
        this.state === "off" || this.binding.off || this.upgradeClaiming || this.reloadQueued ||
        (this.binding.upgradeAttempt ?? 0) >= version || !this.options.onReload) return;
    this.upgradeClaiming = true;
    const previous = this.binding.upgradeAttempt;
    try {
      this.binding.upgradeAttempt = version;
      await this.saveBinding();
      if (!idle()) { this.binding.upgradeAttempt = previous; await this.saveBinding(); return; }
      if (!this.closed && !["off", "closed"].includes(this.state) && this.upgradeVersion === version && !this.binding.off) {
        this.reloadQueued = true; this.options.onReload();
      }
    } catch { /* A failed persistence/queue must not create an automatic retry loop. */ }
    finally { this.upgradeClaiming = false; }
  }
  async hint(ids: string[]) {
    if (!this.binding || !ids.length) return;
    this.binding.hinted = [...new Set([...(this.binding.hinted ?? []), ...ids])].slice(-4096);
    await this.saveBinding();
  }
  async configure(action: "on" | "off" | "manual" | "auto" | "project-on" | "project-off") {
    await this.start();
    if (!this.binding) throw new Error("Registration disabled by environment or unprovisioned headless mode.");
    if (action.startsWith("project-")) await atomicJson(this.policyFile!, { off: action === "project-off" });
    else {
      if (action === "on" || action === "off") this.binding.off = action === "off";
      else this.binding.manual = action === "manual";
      await this.saveBinding();
    }
    await this.sync();
  }
  wait(seconds: number, userPending: () => boolean, signal?: AbortSignal) {
    return this.wake.wait(seconds * 1000, () => userPending() ? "user_input" : this.closed ? "closed" : this.state !== "online" ? "unavailable" : this.snapshot?.pending ? "mail" : undefined, signal);
  }
  async close() {
    if (this.closed) return;
    this.life.abort(); this.watching?.abort(); if (this.timer) clearInterval(this.timer);
    this.wake.emit("closed"); this.state = "closed";
    this.changed(); this.observers.clear();
    await this.syncTail; await this.diskTail;
    await this.client?.call("detach", {}, AbortSignal.timeout(1500)).catch(() => {});
  }
}
