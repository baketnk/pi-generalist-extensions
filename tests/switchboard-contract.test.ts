import { expect, test } from "bun:test";
import { Check } from "typebox/value";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import switchboard from "../extensions/switchboard.ts";
import { nextForResult, runtimeParams, switchboardFailure, switchboardTools } from "../lib/switchboard/contract.ts";
import { BoardClient, ClientError } from "../lib/switchboard/client.ts";
import { serve } from "../lib/switchboard/server.ts";
import { secret } from "../lib/switchboard/shared.ts";

const examples: Record<string, object> = {
  peers: {}, inspect: { participantId: "p_peer" }, status: { summary: "" }, send: { recipient: "p_peer", body: "hello" },
  inbox: {}, read: {}, reply: { messageId: "m_mail", body: "reply" }, ack: { messageId: "m_mail" },
  delivery: { messageId: "m_mail" }, retry: { operationId: "op_saved" }, wait: { waitTimeoutSeconds: 1 },
};
function harness(options = {}) {
  const tools = new Map<string, any>(), handlers = new Map<string, any>();
  switchboard({ on(name: string, handler: any) { handlers.set(name, handler); }, registerTool(tool: any) { tools.set(tool.name, tool); },
    events: { on: () => () => {}, emit() {} }, registerCommand() {}, getSessionName() { return "synthetic"; } } as any, options);
  return { tools, handlers };
}
const payload = (value: any) => JSON.parse(value.content[0].text.split("approval):\n")[1]);

test("static per-action schemas require real inputs and reject unrelated/legacy fields", async () => {
  const { tools } = harness();
  expect(tools.has("switchboard")).toBe(false);
  expect(tools.size).toBe(11);
  for (const tool of switchboardTools) {
    expect(Check(tool.parameters, examples[tool.action])).toBe(true);
    expect(Check(tool.parameters, { ...examples[tool.action], action: tool.action })).toBe(false);
    for (const key of tool.parameters.required ?? []) {
      const missing: any = { ...examples[tool.action] }; delete missing[key];
      expect(Check(tool.parameters, missing)).toBe(false);
    }
    for (const [key] of Object.entries(tool.parameters.properties)) {
      expect(Check(tool.parameters, { ...examples[tool.action], [key]: null })).toBe(false);
      if (key !== "summary") expect(Check(tool.parameters, { ...examples[tool.action], [key]: "" })).toBe(false);
    }
    // Execute directly too: validation must precede runtime/service access.
    try { await tools.get(tool.name).execute("invalid", { ...examples[tool.action], bogus: true }, undefined, undefined, {}); throw new Error("accepted"); }
    catch (error: any) { const failure = JSON.parse(error.message); expect(failure.code).toBe("invalid_arguments"); expect(failure.effect).toBe("none"); expect(failure.retryUnchanged).toBe(false); }
  }
  expect(Check(tools.get("switchboard_wait").parameters, { waitTimeoutSeconds: 301 })).toBe(false);
  expect(Check(tools.get("switchboard_read").parameters, { id: "m_old" })).toBe(false);
  expect(runtimeParams("inspect", { participantId: "p_peer" }).id).toBe("p_peer");
  expect(runtimeParams("wait", { waitTimeoutSeconds: 30 }).seconds).toBe(30);
});

test("next calls are bounded, optional and never invent reply text or polling", () => {
  const read = { id: "m_one", recipient: "p_self", body: "question", ackAt: null };
  const next = nextForResult("read", read, "p_self");
  expect(next[0]).toEqual({ tool: "switchboard_reply", arguments: { messageId: "m_one" }, requiredInput: { body: expect.any(String) } });
  expect(next[1]).toEqual({ tool: "switchboard_ack", arguments: { messageId: "m_one" } });
  expect(nextForResult("read", read, "p_other")).toEqual([]);
  expect(nextForResult("read", { ...read, body: null }, "p_self")).toEqual([]);
  expect(nextForResult("read", { empty: true }, "p_self")).toEqual([]);
  for (const reason of ["timeout", "user_input", "unavailable"]) expect(nextForResult("wait", { reason })).toEqual([]);
  expect(nextForResult("wait", { reason: "mail" })[0]!.tool).toBe("switchboard_inbox");
  expect(nextForResult("inbox", { messages: Array.from({ length: 12 }, (_, i) => ({ id: `m_${i}` })) })).toHaveLength(5);
});

test("uncertain send failures retain saved operation and never recommend duplicate sends", () => {
  const result = JSON.parse(switchboardFailure(new ClientError("Send operation op_one: service unavailable. Use retry"), "unknown", "op_one").message);
  expect(result.code).toBe("send_uncertain");
  expect(result.effect).toBe("unknown");
  expect(result.nextCalls).toEqual([{ tool: "switchboard_retry", arguments: { operationId: "op_one" } }]);
  expect(JSON.parse(switchboardFailure(new ClientError("Unknown local send operation."), "unknown", "op_nope").message).nextCalls).toEqual([]);
  expect(JSON.parse(switchboardFailure(new Error("Session changed."), "none").message).nextCalls).toEqual([]);
  expect(JSON.parse(switchboardFailure(new ClientError("Message unavailable to this participant.", 404), "none").message).nextCalls).toEqual([{ tool: "switchboard_inbox", arguments: {} }]);
  expect(JSON.parse(switchboardFailure(new ClientError("Only the recipient can acknowledge.", 403), "unknown").message).nextCalls).toEqual([]);
});

test("split tools preserve addressed mail, repeated reads, explicit ack and saved-send retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "switchboard-contract-")), paths = { root, socket: join(root, "board.sock") };
  const board = await serve(paths), { tools, handlers } = harness({ paths, ensure: async () => {} });
  const ctx: any = { cwd: root, mode: "tui", hasUI: false, isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => "synthetic-contract", getSessionFile: () => undefined, getBranch: () => [] } };
  const call = async (action: string, args = {}, callId = action) => payload(await tools.get(`switchboard_${action}`).execute(callId, args, undefined, undefined, ctx));
  const definitions = JSON.stringify([...tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters })));
  try {
    await handlers.get("session_start")({}, ctx);
    const peer = new BoardClient(paths, secret());
    const peerCard = await peer.connect({ cwd: root, worktree: root, project: root, name: "peer", summary: "", activity: "idle" });
    const own = (await call("status", { summary: "reviewing" })).result;
    expect((await call("inspect", { participantId: peerCard.handle })).result.id).toBe(peerCard.id);
    expect((await call("peers")).result.peers.some((p: any) => p.id === peerCard.id)).toBe(true);
    const sent = await call("send", { recipient: peerCard.handle, body: "hello" });
    expect(sent.operationId).toMatch(/^op_/);
    expect(sent.nextCalls[0].arguments.messageId).toBe(sent.result.id);
    expect((await call("retry", { operationId: sent.operationId })).result.id).toBe(sent.result.id);
    expect((await peer.snapshot()).pending).toBe(1);
    const incoming: any = await peer.send("incoming", { recipient: own.id, body: "question" });
    expect((await call("wait", { waitTimeoutSeconds: 1 })).result.reason).toBe("mail");
    expect((await call("inbox")).nextCalls[0].arguments.messageId).toBe(incoming.id);
    expect((await call("read")).result.id).toBe(incoming.id);
    expect((await call("read")).result.id).toBe(incoming.id);
    await call("reply", { messageId: incoming.id, body: "answer" });
    expect((await call("inbox")).result.pending).toBe(1);
    await call("ack", { messageId: incoming.id });
    expect((await call("read")).result.empty).toBe(true);
    expect((await call("delivery", { messageId: incoming.id })).result.ackAt).toBeTruthy();
    expect((await call("status", { summary: "" })).result.summary).toBe("");
    expect(JSON.stringify([...tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters })))).toBe(definitions);
    const tooLarge = tools.get("switchboard_send").execute("oversize", { recipient: peerCard.id, body: "狸".repeat(6000) }, undefined, undefined, ctx);
    await expect(tooLarge).rejects.toThrow('"effect":"none"');
    expect((await peer.snapshot()).pending).toBe(2);
  } finally { await handlers.get("session_shutdown")(); await board.close(); await rm(root, { recursive: true, force: true }); }
});
