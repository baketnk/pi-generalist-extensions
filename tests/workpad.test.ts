import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import workpad, { WORKPAD_MESSAGE, WORKPAD_PATH } from "../extensions/workpad.ts";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "workpad-"));
  const events: Record<string, Function> = {}, sent: any[] = [], entries: any[] = [];
  const pi: any = {
    on: (name: string, fn: Function) => { events[name] = fn; }, registerFlag() {}, registerCommand() {},
    getFlag: () => false, appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    sendMessage: (message: any, options: any) => sent.push({ message, options }),
  };
  const ctx: any = { cwd: dir, hasUI: false, sessionManager: { getBranch: () => entries } };
  const enabled = workpad(pi);
  events.session_start!({}, ctx);
  const write = (text: string) => { mkdirSync(join(dir, ".pi"), { recursive: true }); writeFileSync(join(dir, WORKPAD_PATH), text); };
  return { dir, events, sent, ctx, enabled, write, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

test("off by default: no system prompt change and nothing re-sent after compaction", async () => {
  const h = harness();
  try {
    h.write("notes");
    expect(h.events.before_agent_start!({ systemPrompt: "base" }, h.ctx)).toBeUndefined();
    await h.events.session_compact!({}, h.ctx);
    expect(h.sent).toEqual([]);
  } finally { h.clean(); }
});

test("enabled: constant system-prompt addition, applied once, and one appended message after compaction", async () => {
  const h = harness();
  try {
    h.enabled.set(true, h.ctx);
    const first = h.events.before_agent_start!({ systemPrompt: "base" }, h.ctx).systemPrompt as string;
    expect(first).toContain(WORKPAD_PATH);
    expect(h.events.before_agent_start!({ systemPrompt: first }, h.ctx)).toBeUndefined();
    await h.events.session_compact!({}, h.ctx); // no file yet
    expect(h.sent).toEqual([]);
    h.write("  \n");
    await h.events.session_compact!({}, h.ctx); // blank file
    expect(h.sent).toEqual([]);
    h.write("hypothesis: cache miss");
    await h.events.session_compact!({}, h.ctx);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].message.customType).toBe(WORKPAD_MESSAGE);
    expect(h.sent[0].message.content).toContain("hypothesis: cache miss");
    expect(h.sent[0].options).toEqual({ deliverAs: "nextTurn" });
  } finally { h.clean(); }
});

test("oversized notes are truncated explicitly on a character boundary", async () => {
  const h = harness();
  try {
    h.enabled.set(true, h.ctx);
    h.write("漢".repeat(10_000));
    await h.events.session_compact!({}, h.ctx);
    const content = h.sent[0].message.content as string;
    expect(content).toContain("[Truncated: showing the first 16384 of 30000 bytes");
    expect(content).not.toContain("�");
  } finally { h.clean(); }
});
