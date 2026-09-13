import { test, expect } from "bun:test";
import optmem from "../extensions/optmem.ts";
import { reminderRequest, REMINDER_KEY } from "../lib/optmem-reminder.ts";

const user = (id = "u1") => ({ type: "message", id, message: { role: "user", content: "request" } });
const answer = (stopReason = "stop", content: any[] = []) => ({ role: "assistant", stopReason, content });
const call = (command = "note") => ({ type: "message", id: "a1", message: answer("toolUse", [
  { type: "toolCall", id: "t1", name: "memo", arguments: { args: [command, "fact"] } },
]) });
const marker = (requestId = "u1") => ({ type: "custom", id: "m1", customType: REMINDER_KEY, data: { requestId } });
const request = (entries: any[]) => reminderRequest(entries);

test("request-local scan distinguishes notes, reads, old saves and review markers", () => {
  expect(request([])).toBeUndefined();
  expect(request([user()])).toBe("u1");
  expect(request([user(), call()])).toBeUndefined();
  for (const cmd of ["wake", "recall", "zoom", "nap", "config"]) {
    expect(request([user(), call(cmd)])).toBe("u1");
  }
  expect(request([user(), call(), user("u2")])).toBe("u2");
  expect(request([user(), marker()])).toBeUndefined();
  expect(request([user(), marker(), user("u2")])).toBe("u2");
  expect(request([user(), marker("other")])).toBe("u1");
  // Failed writes are not automatically encouraged to retry.
  expect(request([user(), call(), { type: "message", message: { role: "toolResult", isError: true } }])).toBeUndefined();
  expect(request([user(), { type: "compaction", id: "c1" }, marker()])).toBeUndefined();
  expect(request([user(), { type: "message", message: answer("stop", [{ type: "text", text: 'memo note "fact"' }]) }])).toBe("u1");
});

function harness(entries: any[] = [user()]) {
  const handlers: Record<string, Function[]> = {};
  const sent: any[] = [];
  const ctx: any = {
    hasUI: false, signal: undefined, hasPendingMessages: () => false,
    sessionManager: { getBranch: () => entries },
  };
  const pi: any = {
    on: (event: string, fn: Function) => (handlers[event] ??= []).push(fn),
    registerFlag() {}, getFlag: () => true, registerCommand() {}, registerTool() {},
    getActiveTools: () => ["read", "memo"], setActiveTools() {},
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    sendMessage: (message: any, options: any) => sent.push({ message, options }),
  };
  optmem(pi);
  const emit = async (name: string, event: any = {}) => {
    for (const fn of handlers[name] ?? []) await fn(event, ctx);
  };
  return { pi, ctx, entries, sent, emit };
}

test("one hidden custom follow-up per request; persistent across reload and new requests", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.emit("agent_end", { messages: [answer()] });
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0].message.display).toBe(false);
  expect(h.sent[0].message.content).toContain("Saving nothing is valid");
  expect(h.sent[0].options).toEqual({ deliverAs: "followUp", triggerTurn: true });
  await h.emit("agent_end", { messages: [answer()] });
  await h.emit("session_start", { reason: "reload" });
  await h.emit("agent_end", { messages: [answer()] });
  expect(h.sent).toHaveLength(1);
  const resumed = harness(h.entries);
  await resumed.emit("session_start");
  await resumed.emit("agent_end", { messages: [answer()] });
  expect(resumed.sent).toHaveLength(0);
  h.entries.push(user("u2"));
  await h.emit("agent_end", { messages: [answer()] });
  expect(h.sent).toHaveLength(2);
});

test("off, failed/aborted/truncated/tool-ending runs and pending input never trigger", async () => {
  for (const stop of ["error", "aborted", "length", "toolUse", "pending"]) {
    const h = harness(); await h.emit("session_start");
    await h.emit("agent_end", { messages: [answer(stop)] });
    expect(h.sent).toHaveLength(0);
  }
  for (const condition of ["off", "aborted", "pending", "note", "tool-result", "tool-call", "empty"]) {
    const h = harness();
    if (condition === "off") h.pi.getFlag = () => false;
    await h.emit("session_start");
    if (condition === "aborted") h.ctx.signal = { aborted: true };
    if (condition === "pending") h.ctx.hasPendingMessages = () => true;
    if (condition === "note") h.entries.push(call());
    const messages = condition === "empty" ? [] : condition === "tool-result" ? [{ role: "toolResult" }] :
      condition === "tool-call" ? [answer("stop", [{ type: "toolCall" }])] : [answer()];
    await h.emit("agent_end", { messages });
    expect(h.sent).toHaveLength(0);
  }
});
