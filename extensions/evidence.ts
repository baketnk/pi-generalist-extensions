import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { evidenceTools, evidenceFailure, evidenceNext } from "../lib/evidence/contract.ts";
import { EvidenceStore, MAX_LINES, type Evidence, type EvidenceKind } from "../lib/evidence/store.ts";
import { EvidenceView, safeText } from "../lib/evidence/view.ts";
import { formatOutput } from "../lib/output.ts";
import { registerToggle } from "../lib/toggle.ts";
import type { StatusIconsController } from "../lib/status-icons.ts";

const kinds = ["source-observation", "test-contract-inspected"] as const;
const format = (e: Evidence) => `${e.id}: ${e.title}\nKind: ${e.kind} (not a test run or verdict)\nSource: ${e.source}:${e.start}–${e.end}\nCaptured: ${e.capturedAt}\nWhole-file SHA-256: ${e.fileHash}\n\nCAPTURED EXCERPT\n${e.excerpt}`;

/** No hooks, startup reads, subprocesses, model calls, or prompt injection. */
export default function evidence(pi: ExtensionAPI, root = () => join(getAgentDir(), "evidence"), toggle?: { icons?: StatusIconsController }) {
  // Bundle use: off by default so the tool definition is not carried on every request. Standalone/tests skip the toggle.
  if (toggle) registerToggle(pi, "evidence-tool", "Enable the evidence shelf tools", on => {
    const names = evidenceTools.map(tool => tool.name);
    const active = pi.getActiveTools().filter(name => name !== "evidence" && !names.includes(name as any));
    pi.setActiveTools(on ? [...active, ...names] : active);
  }, toggle.icons);
  const store = (ctx: ExtensionContext) => new EvidenceStore(root(), ctx.cwd);
  for (const definition of evidenceTools) pi.registerTool({
    ...definition, label: definition.name.replaceAll("_", " "), executionMode: "sequential",
    async execute(_call, rawParams, signal, _update, ctx) {
      if (!Check(definition.parameters, rawParams)) throw new Error(JSON.stringify({ code: "invalid_arguments", message: `Invalid ${definition.name} arguments`, effect: "none", retryUnchanged: false,
        repair: "Use only declared fields and supply required inputs; omit placeholders. Do not repeat unchanged.", required: definition.parameters.required ?? [], allowed: Object.keys(definition.parameters.properties), nextCalls: [] }));
      const params = rawParams as Record<string, any>, action = definition.action;
      let effect = "none";
      try {
        signal?.throwIfAborted();
        const s = store(ctx);
        let result: unknown;
        if (action === "list") {
          const all = s.list(), offset = params.offset ?? 0;
          result = { project: s.project, records: all.slice(offset, offset + 20), nextOffset: offset + 20 < all.length ? offset + 20 : null };
        } else if (action === "capture") {
          effect = "unknown";
          result = s.capture(params as any);
        }
        else if (action === "read") result = s.read(params.id);
        else if (action === "check") result = s.check(params.id);
        else result = { captured: s.read(params.id), current: s.check(params.id, true) };
        const nextCalls = evidenceNext(action, result);
        const text = formatOutput(result, ctx) + "\nNext calls (optional): " + JSON.stringify(nextCalls);
        if (Buffer.byteLength(JSON.stringify(result)) > 48 * 1024 || Buffer.byteLength(text) > 48 * 1024) throw new Error("Result exceeds 48 KiB; use separate read/check operations or capture a smaller excerpt.");
        return { content: [{ type: "text", text }], details: { result, nextCalls } };
      } catch (error) { throw evidenceFailure(error, definition.name, effect); }
    },
  });
  pi.registerCommand("evidence", {
    description: "Evidence shelf: /evidence [capture|read ID|check ID|compare ID]",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const [action = "", id, ...extra] = args.trim().split(/\s+/);
      if (extra.length || !["", "capture", "read", "check", "compare"].includes(action) ||
          (["read", "check", "compare"].includes(action) ? !id : !!id)) {
        ctx.ui.notify("Usage: /evidence [capture|read ID|check ID|compare ID]", "warning"); return;
      }
      await ctx.waitForIdle();
      try {
        const s = store(ctx);
        if (action === "capture") {
          const name = await ctx.ui.input("New immutable evidence ID", "e1"); if (!name) return;
          const title = await ctx.ui.input("Observation title (your interpretation, not a verdict)"); if (!title) return;
          const path = await ctx.ui.input("Source file inside this project"); if (!path) return;
          const lines = await ctx.ui.input(`Inclusive line range (maximum ${MAX_LINES} lines)`, "1-20"); if (!lines) return;
          const match = /^(\d+)-(\d+)$/.exec(lines); if (!match) throw new Error("Use a range such as 10-25.");
          const kind = await ctx.ui.select("Evidence kind — neither means a test passed", [...kinds]); if (!kind) return;
          const e = s.capture({ id: name, title, kind: kind as EvidenceKind, path, start: Number(match[1]), end: Number(match[2]) });
          ctx.ui.notify(`Captured ${e.id}; source freshness is checked only on demand.`, "info"); return;
        }
        let chosen = id;
        if (!chosen) {
          const records = s.list();
          if (!records.length) { ctx.ui.notify("No evidence captured. Use /evidence capture or the evidence tool.", "info"); return; }
          const labels = records.map(e => safeText(`${e.id} · ${e.kind} · ${e.title}`));
          const choice = await ctx.ui.select("Evidence shelf — freshness not checked", labels);
          if (choice === undefined) return;
          const index = labels.indexOf(choice); if (index < 0) return;
          chosen = records[index]!.id;
        }
        const mode = action || await ctx.ui.select(`${chosen}: inspect`, ["read", "check", "compare"]);
        if (!mode) return;
        const e = s.read(chosen);
        if (mode === "check") {
          ctx.ui.notify(safeText(formatOutput(s.check(chosen), ctx)), "info"); return;
        }
        let content = format(e);
        if (mode === "compare") {
          const c = s.check(chosen, true);
          content += `\n\nCURRENT SOURCE — ${c.status}\nChecked: ${c.checkedAt}\n${c.meaning}\nSHA-256: ${c.currentHash ?? "unavailable"}\n${c.currentRange ?? ""}\n${c.currentExcerpt ?? ""}\n${c.error ?? ""}`;
        }
        if (ctx.mode !== "tui") { ctx.ui.notify("Excerpt viewer requires TUI; use the evidence read/compare tool in this mode.", "warning"); return; }
        await ctx.ui.custom<void>((tui, theme, keys, done) => new EvidenceView(`Evidence ${chosen} · ${mode}`, content, theme, keys,
          () => tui.terminal.rows, () => tui.requestRender(), () => done()),
          { overlay: true, overlayOptions: { width: "95%", maxHeight: "80%" } });
      } catch (error) { ctx.ui.notify(safeText(String(error)), "error"); }
    },
  });
}
