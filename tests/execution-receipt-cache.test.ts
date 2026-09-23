import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import bgTasks from "../extensions/bg-tasks.ts";

// Intentional v2 contract change: completion tails/coalescing guidance. This
// baseline still guards the complete static contract against per-job mutation.
const COMPLETION_V2_TOOL_SHA256 = "57e03b6972c9ee081f663310ac26a2bb5dd6f6b6f5984d4c47869186d68ca33e";
function harness(manager: SessionManager, cwd: string) {
  const events: Record<string, Function> = {}, messages: unknown[] = [];
  let tool: any, complete!: () => void;
  const done = new Promise<void>(resolve => { complete = resolve; });
  bgTasks({
    on: (name: string, handler: Function) => { events[name] = handler; },
    registerCommand() {}, registerTool: (value: any) => { tool = value; },
    appendEntry: (type: string, data: unknown) => { manager.appendCustomEntry(type, data); complete(); },
    sendMessage: (value: unknown) => { messages.push(value); },
  } as any);
  const contract = () => {
    const { name, description, promptSnippet, promptGuidelines, parameters, executionMode } = tool;
    return createHash("sha256").update(JSON.stringify({ name, description, promptSnippet, promptGuidelines, parameters, executionMode })).digest("hex");
  };
  const ctx: any = { cwd, mode: "tui", hasUI: false, sessionManager: manager };
  return { events, messages, done, contract, ctx, call: (args: unknown) => tool.execute("fixture", args, undefined, undefined, ctx) };
}

test("receipts preserve tool-schema bytes and LLM context across completion and session reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "receipt-cache-")), oldDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const manager = SessionManager.create(root, join(root, "sessions"));
  const h = harness(manager, root);
  try {
    manager.appendMessage({ role: "user", content: "Run a silent fixture", timestamp: 1 });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Fixture baseline" }], api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: 2,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const projection = () => JSON.stringify(convertToLlm(manager.buildSessionContext().messages));
    const before = projection();
    expect(h.contract()).toBe(COMPLETION_V2_TOOL_SHA256);
    expect(Object.keys(h.events).sort()).toEqual(["agent_end", "agent_settled", "agent_start", "before_agent_start", "session_shutdown", "session_start", "session_tree", "turn_end"]);
    await h.events.session_start({}, h.ctx);
    const started = await h.call({ action: "start", command: "printf cache-fixture", notify: "off" });
    await h.done;
    expect(projection()).toBe(before);
    expect(h.messages).toEqual([]); // No new receipt wake/context injection.
    expect(h.contract()).toBe(COMPLETION_V2_TOOL_SHA256);
    const status = await h.call({ action: "status", id: started.details.job.id });
    expect(status.content[0].text).toContain("Receipt: recorded");
    expect(status.content[0].text).toContain("sha256=");
    expect(projection()).toBe(before); // Reading never rewrites old context.
    const entries = manager.getEntries().filter(e => e.type === "custom");
    expect(entries).toHaveLength(1);
    expect((entries[0] as any).data.receipt.state).toBe("recorded");
    await h.events.session_shutdown({}, h.ctx);
    const reopened = SessionManager.open(manager.getSessionFile()!), restored = harness(reopened, root);
    await restored.events.session_start({}, restored.ctx);
    expect(JSON.stringify(convertToLlm(reopened.buildSessionContext().messages))).toBe(before);
    expect(restored.contract()).toBe(COMPLETION_V2_TOOL_SHA256);
    expect(restored.messages).toEqual([]);
    await restored.events.session_shutdown({}, restored.ctx);
  } finally {
    await h.events.session_shutdown({}, h.ctx);
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
    await rm(root, { recursive: true, force: true });
  }
});
