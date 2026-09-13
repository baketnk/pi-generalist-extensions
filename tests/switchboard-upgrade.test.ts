import { test, expect } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, rm, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { ensureService, rpc, UpgradeRequired } from "../lib/switchboard/client.ts";
import { BoardRuntime } from "../lib/switchboard/runtime.ts";
import { VERSION } from "../lib/switchboard/shared.ts";
import { daemonEvents, recordDaemonEvent } from "../lib/switchboard/diagnostics.ts";
import switchboard from "../extensions/switchboard.ts";

async function fixture(fn: (paths: { root: string; socket: string }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "switchboard-upgrade-"));
  try { await fn({ root, socket: join(root, "board.sock") }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("newer daemon is never killed; heartbeat reports upgrade even on expired attachment", async () => fixture(async paths => {
  // A real disposable PID ensures the old unconditional SIGTERM implementation fails this test safely.
  const child = spawn("node", ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  const exit = once(child, "exit");
  const server = createServer((req, res) => {
    req.resume();
    res.setHeader("x-switchboard-version", String(VERSION + 1));
    if (req.url === "/v1/health") res.end(JSON.stringify({ version: VERSION + 1, pid: child.pid }));
    else { res.statusCode = 409; res.end(JSON.stringify({ error: "Attachment expired" })); }
  });
  try {
    await new Promise<void>(resolve => server.listen(paths.socket, resolve)); await chmod(paths.socket, 0o600);
    await expect(ensureService(paths)).rejects.toBeInstanceOf(UpgradeRequired);
    await expect(rpc(paths, "", { action: "heartbeat" })).rejects.toBeInstanceOf(UpgradeRequired);
    await Bun.sleep(25); expect(child.signalCode).toBeNull(); expect(child.exitCode).toBeNull();
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); child.kill("SIGTERM"); await exit; }
}));

test("upgrade reload defers busy state, rechecks readiness after persistence, queues once, and survives reload without looping", async () => fixture(async paths => {
  let queued = 0;
  const make = () => new BoardRuntime({ paths, cwd: paths.root, sessionId: "fixture", mode: "tui", intervalMs: 100000,
    ensure: async () => { throw new UpgradeRequired(VERSION + 1); }, onReload: () => { queued++; } });
  const r = make();
  try {
    await r.start(); expect(r.upgradeVersion).toBe(VERSION + 1);
    await r.reloadForUpgrade(() => false); expect(queued).toBe(0);
    let checks = 0;
    await r.reloadForUpgrade(() => ++checks === 1); expect(queued).toBe(0);
    expect(r.binding!.upgradeAttempt).toBeUndefined();
    await Promise.all([r.reloadForUpgrade(() => true), r.reloadForUpgrade(() => true)]);
    expect(queued).toBe(1);
    expect(JSON.parse(await readFile(r.bindingFile!, "utf8")).upgradeAttempt).toBe(VERSION + 1);
    await r.reloadForUpgrade(() => true); expect(queued).toBe(1);
  } finally { await r.close(); }
  const resumed = make();
  try {
    await resumed.start(); await resumed.reloadForUpgrade(() => true); expect(queued).toBe(1);
    resumed.upgradeVersion = VERSION + 2;
    await resumed.reloadForUpgrade(() => true); expect(queued).toBe(2);
  } finally { await resumed.close(); }
}));

test("upgrade auto-reload does not run for headless, opted-out, or closed runtime", async () => fixture(async paths => {
  let queued = 0;
  const r = new BoardRuntime({ paths, cwd: paths.root, sessionId: "fixture", mode: "tui", intervalMs: 100000,
    ensure: async () => { throw new UpgradeRequired(VERSION + 1); }, onReload: () => { queued++; } });
  try {
    await r.start(); r.binding!.off = true; await r.reloadForUpgrade(() => true);
    r.binding!.off = false; r.options.mode = "print"; await r.reloadForUpgrade(() => true);
    r.options.mode = "tui"; await r.close(); await r.reloadForUpgrade(() => true);
    expect(queued).toBe(0);
  } finally { await r.close(); }
}));

test("extension upgrade gate respects busy, queued input and prompts; enqueue is command-only and once", async () => fixture(async paths => {
  const hooks = new Map<string, Function[]>(), queued: any[] = [];
  let idle = false, pending = false, status = "";
  const pi: any = {
    on: (name: string, fn: Function) => hooks.set(name, [...(hooks.get(name) ?? []), fn]),
    events: { on: () => () => {} }, registerTool() {}, registerCommand() {}, getSessionName: () => "fixture",
    sendUserMessage: (...args: any[]) => queued.push(args),
    appendEntry: () => { throw new Error("Upgrade must not append model context"); },
  };
  const ctx: any = { cwd: paths.root, mode: "tui", hasUI: true, isIdle: () => idle, hasPendingMessages: () => pending,
    sessionManager: { getSessionId: () => "adapter", getSessionFile: () => undefined },
    ui: { setStatus: (_key: string, value: string) => { status = value; } },
  };
  const emit = async (name: string) => { for (const fn of hooks.get(name) ?? []) await fn({}, ctx); await Bun.sleep(15); };
  switchboard(pi, { paths, ensure: async () => { throw new UpgradeRequired(VERSION + 1); } });
  try {
    await emit("session_start");
    expect(status).toContain("unavailable"); expect(queued).toHaveLength(0);
    idle = true; pending = true; await emit("agent_settled"); expect(queued).toHaveLength(0);
    pending = false; await emit("ui_prompt_start"); expect(queued).toHaveLength(0);
    await emit("ui_prompt_end");
    expect(queued).toEqual([["/switchboard-reload", { deliverAs: "followUp", expandPromptTemplates: true }]]);
    await emit("agent_settled"); expect(queued).toHaveLength(1);
  } finally { await emit("session_shutdown"); }
}));

test("bounded lifecycle diagnostics contain only fixed metadata", async () => fixture(async paths => {
  for (let i = 0; i < 70; i++) await recordDaemonEvent(paths, i % 2 ? "SIGTERM" : "start");
  const events = await daemonEvents(paths);
  expect(events).toHaveLength(64); expect(events.at(-1)!.event).toBe("SIGTERM");
  expect(Object.keys(events[0]!).sort()).toEqual(["at", "event", "pid", "version"]);
}));
