import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKER_LIMITS, loadWorkerLimits, saveWorkerLimits, validateWorkerLimits, workerLimitsPath } from "../lib/subagents/limits.ts";
import { configureWorkerLimits } from "../extensions/generalist-settings.ts";
import registerSubagents from "../extensions/subagents.ts";

test("subagent limits persist, reject invalid settings and unsafe files, and default when missing", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-worker-limits-"));
  try {
    expect(loadWorkerLimits(agentDir)).toEqual(DEFAULT_WORKER_LIMITS);
    const limits = { version: 1 as const, turns: 48, tools: 160 };
    saveWorkerLimits(agentDir, limits);
    expect(loadWorkerLimits(agentDir)).toEqual(limits);
    expect(JSON.parse(await readFile(workerLimitsPath(agentDir), "utf8"))).toEqual(limits);
    for (const invalid of [{ ...limits, turns: 0 }, { ...limits, turns: 1001 }, { ...limits, tools: 4001 },
      { ...limits, tools: 3.5 }, { ...limits, extra: true }, { ...limits, version: 2 }]) {
      expect(() => validateWorkerLimits(invalid)).toThrow();
      expect(() => saveWorkerLimits(agentDir, invalid as any)).toThrow();
    }
    await writeFile(workerLimitsPath(agentDir), "{invalid json");
    expect(() => loadWorkerLimits(agentDir)).toThrow();
    await rm(workerLimitsPath(agentDir));
    await symlink(join(agentDir, "missing"), workerLimitsPath(agentDir));
    expect(() => loadWorkerLimits(agentDir)).toThrow();
    expect(() => saveWorkerLimits(agentDir, limits)).toThrow("symlink");
  } finally { await rm(agentDir, { recursive: true, force: true }); }
});

test("human /subagents limits command inspects, saves and rejects invalid budgets", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-worker-limits-command-"));
  try {
    let command: any; const notices: string[] = [];
    registerSubagents({ registerFlag() {}, on() {}, registerTool() {}, registerCommand(_name: string, definition: any) { command = definition; } } as any, { agentDir });
    const ctx: any = { hasUI: true, ui: { notify: (text: string) => notices.push(text) } };
    await command.handler("limits", ctx);
    expect(notices.at(-1)).toContain("24 turns, 80 tool calls");
    await command.handler("limits 48 160", ctx);
    expect(loadWorkerLimits(agentDir)).toEqual({ version: 1, turns: 48, tools: 160 });
    for (const input of ["limits 0 160", "limits 48 4001", "limits 12.5 10", "limits 48", "limits -1 1"]) {
      await expect(command.handler(input, ctx)).rejects.toThrow();
      expect(loadWorkerLimits(agentDir)).toEqual({ version: 1, turns: 48, tools: 160 });
    }
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("Generalist limits picker saves atomically after both inputs, cancellation and invalid values leave prior choice", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-worker-limits-ui-"));
  try {
    const notices: string[] = [], answers: (string | undefined)[] = ["48", "160"];
    const ctx: any = { hasUI: true, ui: { input: async () => answers.shift(), notify: (text: string) => notices.push(text) } };
    await configureWorkerLimits(ctx, agentDir);
    expect(loadWorkerLimits(agentDir)).toEqual({ version: 1, turns: 48, tools: 160 });
    expect(notices.at(-1)).toContain("Existing runs are unchanged");
    answers.push("70", undefined);
    await configureWorkerLimits(ctx, agentDir);
    expect(loadWorkerLimits(agentDir).turns).toBe(48);
    answers.push("70", "nope");
    await expect(configureWorkerLimits(ctx, agentDir)).rejects.toThrow("Subagent limits");
    expect(loadWorkerLimits(agentDir).tools).toBe(160);
    ctx.hasUI = false;
    await expect(configureWorkerLimits(ctx, agentDir)).rejects.toThrow("requires TUI or RPC");
  } finally { await rm(agentDir, { recursive: true, force: true }); }
});
