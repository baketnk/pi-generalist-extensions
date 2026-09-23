import { expect, test } from "bun:test";
import loop from "../extensions/loop.ts";
import { DEFAULT_LOOP_LIMIT, LOOP_LIMIT_ENTRY, loopLimit } from "../lib/loop-config.ts";

function harness(outcomes: Array<"stop" | "aborted" | "error" | "cancelled" | "throw"> = []) {
  const commands: Record<string, any> = {};
  const notices: string[] = [];
  const statuses: Array<[string, string | undefined]> = [];
  const promptStatuses: Array<string | undefined> = [];
  let status: string | undefined;
  const sessions: Array<{ file: string; prompt?: string; parent?: string }> = [{ file: "original" }];
  let current = sessions[0];
  let branch: any[] = [];
  let busy = false;
  const ctx = (): any => ({
    hasUI: true, isIdle: () => !busy, ui: {
      notify: (text: string) => notices.push(text),
      setStatus: (key: string, value?: string) => { expect(key).toBe("generalist-loop"); status = value; statuses.push([current.file, value]); },
    },
    sessionManager: { getSessionFile: () => { if (current !== sessions.at(-1)) throw Error("stale session"); return current.file; }, getBranch: () => branch },
    newSession: async ({ parentSession, withSession }: any) => {
      if (current !== sessions.at(-1)) throw Error("stale session");
      const outcome = outcomes[sessions.length - 1] ?? "stop";
      if (outcome === "cancelled") return { cancelled: true };
      current = { file: `session-${sessions.length}`, parent: parentSession };
      sessions.push(current); branch = []; status = undefined; // Replacement UI starts with no status.
      await withSession({ ...ctx(), sendUserMessage: async (prompt: string) => {
        current.prompt = prompt;
        promptStatuses.push(status);
        if (outcome === "throw") throw new Error("Synthetic send failure");
        branch.push({ type: "message", message: { role: "assistant", stopReason: outcome } });
      } });
      return { cancelled: false };
    },
  });
  loop({ registerCommand: (name: string, def: any) => commands[name] = def } as any);
  return { commands, ctx, sessions, notices, statuses, promptStatuses, setBranch: (entries: any[]) => branch = entries, setBusy: (value: boolean) => busy = value };
}

test("/loop awaits each prompt in a separate linked session with no repeated loop command", async () => {
  const h = harness();
  h.setBranch([{ type: "custom", customType: LOOP_LIMIT_ENTRY, data: 2 }]);
  await h.commands.loop.handler("  do  this\nwith spaces  ", h.ctx());
  expect(h.sessions).toEqual([
    { file: "original" },
    { file: "session-1", parent: "original", prompt: "do  this\nwith spaces" },
    { file: "session-2", parent: "session-1", prompt: "do  this\nwith spaces" },
  ]);
  expect(h.notices.at(-1)).toBe("Loop finished: 2 sessions.");
  expect(h.promptStatuses).toEqual(["loop:1/2", "loop:2/2"]);
  expect(h.statuses).toEqual([
    ["original", "loop:1/2"], ["session-1", "loop:1/2"],
    ["session-1", "loop:2/2"], ["session-2", "loop:2/2"], ["session-2", undefined],
  ]);
});

test("explicit count overrides branch default; split arguments are joined", async () => {
  const h = harness();
  await h.commands.loop.handler(["3", "check", "the code"], h.ctx());
  expect(h.sessions.slice(1).map(session => session.prompt)).toEqual(["check the code", "check the code", "check the code"]);
});

test("invalid commands and busy agent do not create sessions", async () => {
  const h = harness();
  for (const args of ["", "0 task", "1001 task", "1.5 task", "2", "-1 task"]) await h.commands.loop.handler(args, h.ctx());
  h.setBusy(true);
  await h.commands.loop.handler("do something", h.ctx());
  expect(h.sessions).toHaveLength(1);
  expect(h.statuses).toEqual([]);
  expect(h.notices.at(-1)).toContain("Wait for the current response");
});

test("/loop stops on cancellation, abort or error instead of continuing after a failed session", async () => {
  for (const outcome of ["cancelled", "aborted", "error"] as const) {
    const h = harness([outcome]);
    await h.commands.loop.handler("3 task", h.ctx());
    expect(h.sessions).toHaveLength(outcome === "cancelled" ? 1 : 2);
    expect(h.notices.at(-1)).toContain("Loop stopped");
    expect(h.statuses.at(-1)).toEqual([outcome === "cancelled" ? "original" : "session-1", undefined]);
  }
});

test("/loop clears progress if sending throws in the replacement session", async () => {
  const h = harness(["throw"]);
  await expect(h.commands.loop.handler("3 task", h.ctx())).rejects.toThrow("Synthetic send failure");
  expect(h.promptStatuses).toEqual(["loop:1/3"]);
  expect(h.statuses.at(-1)).toEqual(["session-1", undefined]);
});

test("branch-specific limits ignore malformed entries", () => {
  const entries: any[] = [];
  const ctx = { sessionManager: { getBranch: () => entries } } as any;
  expect(loopLimit(ctx)).toBe(DEFAULT_LOOP_LIMIT);
  entries.push({ type: "custom", customType: LOOP_LIMIT_ENTRY, data: 4 });
  entries.push({ type: "custom", customType: LOOP_LIMIT_ENTRY, data: "100" });
  expect(loopLimit(ctx)).toBe(4);
});
