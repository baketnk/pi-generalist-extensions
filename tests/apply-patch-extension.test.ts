import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import applyPatch from "../extensions/apply-patch.ts";
import { registerGeneralistSettings } from "../extensions/generalist-settings.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function harness(flag = false) {
  const root = await mkdtemp(join(tmpdir(), "generalist-patch-extension-")); roots.push(root);
  const commands: Record<string, any> = {}, tools: Record<string, any> = {}, handlers: Record<string, Function[]> = {};
  let active = ["read", "edit", "write", "unrelated", "apply_patch"];
  let branch: any[] = [];
  const notices: string[] = [];
  const pi: any = {
    registerTool: (tool: any) => tools[tool.name] = tool,
    registerCommand: (name: string, command: any) => commands[name] = command,
    registerFlag() {}, getFlag: () => flag,
    getActiveTools: () => [...active], setActiveTools: (names: string[]) => active = names,
    on: (event: string, handler: Function) => (handlers[event] ??= []).push(handler),
    appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
  };
  const ctx: any = {
    cwd: root, hasUI: true, mode: "rpc", waitForIdle: async () => {},
    sessionManager: { getBranch: () => branch }, ui: { setStatus() {}, notify: (text: string) => notices.push(text) },
  };
  const patch = applyPatch(pi);
  const dummy = Object.assign(() => false, { set() {} });
  registerGeneralistSettings(pi, { meitan: dummy, memory: dummy, patch });
  const emit = async (event: string) => { for (const handler of handlers[event] ?? []) await handler({}, ctx); };
  return { root, ctx, pi, patch, commands, tools, notices, emit, active: () => active, branch: () => branch, setBranch: (entries: any[]) => branch = entries };
}
const input = { patch: "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch" };

test("disabled by default; /generalist patch and /patch only change this tool", async () => {
  const h = await harness(); await h.emit("session_start");
  expect(h.active()).toEqual(["read", "edit", "write", "unrelated"]);
  await expect(h.tools.apply_patch.execute("id", input, undefined, undefined, h.ctx)).rejects.toThrow("disabled");
  await h.commands.generalist.handler("patch on", h.ctx);
  expect(h.active()).toEqual(["read", "edit", "write", "unrelated", "apply_patch"]);
  const result = await h.tools.apply_patch.execute("id", input, undefined, undefined, h.ctx);
  expect(result.details.status).toBe("applied"); expect(result.content[0].text).toContain("Patch applied");
  expect(await readFile(join(h.root, "hello.txt"), "utf8")).toBe("hello\n");
  await h.commands.patch.handler("off", h.ctx); expect(h.active()).not.toContain("apply_patch");
  expect(h.commands.generalist.getArgumentCompletions("pat")).toEqual([{ value: "patch", label: "patch" }]);
});

test("flag seeds branch; saved off survives reload/tree and saved on restores", async () => {
  const h = await harness(true); await h.emit("session_start");
  expect(h.patch()).toBe(true); expect(h.branch()).toHaveLength(1);
  const onBranch = [...h.branch()];
  await h.commands.generalist.handler("patch off", h.ctx);
  await h.emit("session_start"); expect(h.patch()).toBe(false);
  h.setBranch(onBranch); await h.emit("session_tree"); expect(h.patch()).toBe(true);
  await h.commands.generalist.handler("patch toggle", h.ctx); expect(h.patch()).toBe(false);
});

test("errors throw and reports support raw JSON preference without dropping committed metadata", async () => {
  const h = await harness(true); await h.emit("session_start");
  await h.commands.generalist.handler("output on", h.ctx);
  const result = await h.tools.apply_patch.execute("id", input, undefined, undefined, h.ctx);
  expect(JSON.parse(result.content[0].text).committed[0].path).toBe("hello.txt");
  await expect(h.tools.apply_patch.execute("id", input, undefined, undefined, h.ctx)).rejects.toThrow("rejected");
  await expect(h.tools.apply_patch.execute("id", { patch: "not a patch" }, undefined, undefined, h.ctx)).rejects.toThrow("Begin Patch");
});

test("all-no-op patches return a successful noop result", async () => {
  const h = await harness(true); await h.emit("session_start");
  await h.tools.apply_patch.execute("id", input, undefined, undefined, h.ctx);
  const result = await h.tools.apply_patch.execute("id", {
    patch: "*** Begin Patch\n*** Update File: hello.txt\n@@\n hello\n*** End Patch",
  }, undefined, undefined, h.ctx);
  expect(result.details.status).toBe("noop");
  expect(result.content[0].text).toContain("Patch noop");
  expect(result.content[0].text).toContain("No files changed");
  expect(result.content[0].text).toContain("ignored context-only chunk");
});

test("TUI Generalist settings expose patch toggle and restore other controls", async () => {
  initTheme("dark", false);
  const h = await harness(); await h.emit("session_start"); h.ctx.mode = "tui";
  h.ctx.ui.custom = async (factory: Function) => {
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const component = factory({ requestRender() {} }, theme, {}, () => {});
    expect(component.render(100).join("\n")).toContain("Apply patch tool");
    // Meitan, memory, output, patch.
    for (let i = 0; i < 3; i++) component.handleInput("\x1b[B");
    component.handleInput("\r");
  };
  await h.commands.generalist.handler("", h.ctx);
  expect(h.patch()).toBe(true);
});

test("tool renderer does not emit terminal control codes from source text", async () => {
  const h = await harness();
  const component = h.tools.apply_patch.renderResult({ content: [{ type: "text", text: "hello\x1b]0;bad\x07" }] });
  const output = component.render(100).join("\n");
  expect(output).not.toContain("\x1b]0;"); expect(output).toContain("\\u001b");
});
