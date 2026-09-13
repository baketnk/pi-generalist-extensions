import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { EvidenceStore, MAX_LINES, type Evidence, type EvidenceKind } from "../lib/evidence/store.ts";
import { EvidenceView, safeText } from "../lib/evidence/view.ts";

const kinds = ["source-observation", "test-contract-inspected"] as const;
const format = (e: Evidence) => `${e.id}: ${e.title}\nKind: ${e.kind} (not a test run or verdict)\nSource: ${e.source}:${e.start}–${e.end}\nCaptured: ${e.capturedAt}\nWhole-file SHA-256: ${e.fileHash}\n\nCAPTURED EXCERPT\n${e.excerpt}`;

/** No hooks, startup reads, subprocesses, model calls, or prompt injection. */
export default function evidence(pi: ExtensionAPI, root = () => join(getAgentDir(), "evidence")) {
  const store = (ctx: ExtensionContext) => new EvidenceStore(root(), ctx.cwd);
  pi.registerTool({
    name: "evidence", label: "Evidence shelf",
    description: "Capture and revisit immutable project-scoped source evidence. Actions: capture(id,title,kind,path,start,end); list(offset); read(id); check(id); compare(id). Kinds: source-observation or test-contract-inspected; neither proves a claim or records a test execution. Capture reads current UTF-8 source inside canonical cwd (1 MiB max), inclusive 1-based range (160 lines/12 KiB max); IDs cannot be overwritten. Read returns the historical excerpt; check hashes the current whole file on demand. Compare shows current SAME LINE POSITIONS, not symbol relocation. Unchanged means byte identity, not truth or unchanged dependencies. List returns at most 20 records without freshness checks. Output capped at 48 KiB with explicit error, never silent truncation. No automatic context injection, collection, or execution.",
    promptSnippet: "Capture source excerpts and explicitly check their freshness, separate from claims and test execution.",
    promptGuidelines: ["Use evidence to retain source observations or inspected test contracts with immutable excerpts; never describe an inspected test as a passed test. Evidence titles are caller interpretations, not verification. Check freshness explicitly before relying on an old excerpt."],
    parameters: Type.Object({
      action: StringEnum(["capture", "list", "read", "check", "compare"] as const),
      id: Type.Optional(Type.String({ maxLength: 64 })), title: Type.Optional(Type.String({ maxLength: 240 })),
      kind: Type.Optional(StringEnum(kinds)), path: Type.Optional(Type.String({ maxLength: 4096 })),
      start: Type.Optional(Type.Integer({ minimum: 1 })), end: Type.Optional(Type.Integer({ minimum: 1 })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    async execute(_call, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const s = store(ctx);
      let result: unknown;
      if (params.action === "list") {
        const all = s.list(), offset = params.offset ?? 0;
        result = { project: s.project, records: all.slice(offset, offset + 20), nextOffset: offset + 20 < all.length ? offset + 20 : null };
      } else {
        if (!params.id) throw new Error("id is required.");
        if (params.action === "capture") {
          if (params.title === undefined || params.kind === undefined || params.path === undefined || params.start === undefined || params.end === undefined)
            throw new Error("Capture requires title, kind, path, start and end.");
          result = s.capture({ id: params.id, title: params.title, kind: params.kind, path: params.path, start: params.start, end: params.end });
        } else if (params.action === "read") result = s.read(params.id);
        else if (params.action === "check") result = s.check(params.id);
        else result = { captured: s.read(params.id), current: s.check(params.id, true) };
      }
      const text = JSON.stringify(result);
      if (Buffer.byteLength(text) > 48 * 1024) throw new Error("Result exceeds 48 KiB; use individual read/check operations or capture a smaller excerpt. No output was truncated.");
      return { content: [{ type: "text", text }], details: {} };
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
          ctx.ui.notify(safeText(JSON.stringify(s.check(chosen), null, 2)), "info"); return;
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
