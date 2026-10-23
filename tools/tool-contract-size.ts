/** Offline comparison of registered tool contracts; no hooks, stores or providers run.
 * Includes JSON tool schemas and deduplicated prompt snippets/guidelines, not the
 * unchanged Pi base prompt, repository instructions, persona or recalled data.
 */
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const modules = ["bg-tasks", "subagents", "switchboard", "memory", "evidence", "continuity", "history", "questions", "tasks", "tool-feedback", "apply-patch", "web-search"];
const family = (name: string) => name === "bg_tasks" || name.startsWith("bg_") ? "bg-tasks" : name === "subagents" || name.startsWith("subagent_") ? "subagents" : name.split("_")[0]!;
const repo = resolve(import.meta.dir, "..");
async function collect(root: string) {
  const tools: any[] = [];
  const pi = { registerTool: (tool: any) => tools.push(tool), on() {}, registerCommand() {}, registerFlag() {}, registerShortcut() {},
    events: { on: () => () => {}, emit() {} }, getFlag: () => false, getActiveTools: () => [], setActiveTools() {} };
  for (const name of modules) { const module = await import(pathToFileURL(join(root, "extensions", `${name}.ts`)).href); module.default(pi); }
  return tools;
}
function size(tools: any[]) {
  // Public OpenAI function-tool shape; providers add different framing. Schema bytes
  // are exact for this representation; tokens below are explicitly only /4 estimates.
  const schemas = JSON.stringify(tools.map(({ name, description, parameters }) => ({ type: "function", name, description, parameters })));
  const snippets = [...new Set(tools.flatMap(t => t.promptSnippet ? [`- ${t.name}: ${t.promptSnippet}`] : []))];
  const rules = [...new Set(tools.flatMap(t => t.promptGuidelines ?? []))].map(rule => `- ${rule}`);
  const guidance = [...snippets, ...rules].join("\n");
  const schemaBytes = Buffer.byteLength(schemas), guidanceBytes = Buffer.byteLength(guidance), bytes = schemaBytes + guidanceBytes;
  return { tools: tools.length, schemaBytes, guidanceBytes, bytes, estimatedTokens: Math.ceil(bytes / 4) };
}
function profile(tools: any[], mode: string) {
  return tools.filter(tool => {
    const f = family(tool.name);
    if (mode === "all") return true;
    if (f === "evidence") return false;
    if (f === "memory") return mode === "memory";
    return !["apply_patch", "web_search"].includes(tool.name); // factory defaults off
  });
}
const baseline = process.argv[2] ?? "2230b72", middle = process.argv[3] ?? "0fc2dcf";
const roots: string[] = [];
try {
  const versions: Record<string, any[]> = {};
  for (const ref of [baseline, middle]) {
    const root = await mkdtemp(join(tmpdir(), "pi-contract-size-")); roots.push(root);
    const archived = spawnSync("git", ["archive", ref, "extensions", "lib"], { cwd: repo, maxBuffer: 16 * 1024 * 1024 });
    if (archived.status !== 0) throw new Error(archived.stderr.toString());
    const unpack = spawnSync("tar", ["-x", "-C", root], { input: archived.stdout });
    if (unpack.status !== 0) throw new Error(unpack.stderr.toString());
    await symlink(join(repo, "node_modules"), join(root, "node_modules"), "dir");
    versions[ref] = await collect(root);
  }
  versions.working = await collect(repo);
  const results = Object.fromEntries(Object.entries(versions).map(([ref, tools]) => [ref, {
    profiles: Object.fromEntries(["default", "memory", "all"].map(mode => [mode, size(profile(tools, mode))])),
    families: Object.fromEntries(["bg-tasks", "subagents", "switchboard", "memory", "evidence", "continuity"].map(f => [f, size(tools.filter(t => family(t.name) === f))])),
  }]));
  console.log(JSON.stringify({ baseline, middle, unit: "UTF-8 bytes; token estimates use bytes/4, not a model tokenizer", results }, null, 2));
} finally { for (const root of roots) await rm(root, { recursive: true, force: true }); }
