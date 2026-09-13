import { truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { executePatch } from "../lib/patch/engine.ts";
import { MAX_PATCH_BYTES } from "../lib/patch/parser.ts";
import { registerToggle } from "../lib/toggle.ts";
import type { StatusIconsController } from "../lib/status-icons.ts";
import { rawJsonOutput } from "../lib/output.ts";
import { Text } from "@earendil-works/pi-tui";

const safeDisplay = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);

export default function applyPatch(pi: ExtensionAPI, statusIcons?: StatusIconsController, defaultEnabled?: () => boolean | undefined) {
  const enabled = registerToggle(pi, "patch", "Enable Generalist apply_patch", on => {
    const active = pi.getActiveTools().filter(name => name !== "apply_patch");
    pi.setActiveTools(on ? [...active, "apply_patch"] : active);
  }, statusIcons, { defaultEnabled });
  pi.registerTool({
    name: "apply_patch",
    label: "Apply patch",
    description: `Apply a Codex-style patch to local UTF-8 files inside cwd. Input is {patch: "*** Begin Patch\\n...\\n*** End Patch"}; no shell wrappers or Markdown fences.
Operations: *** Add File: path (each content line starts +); *** Delete File: path; *** Update File: path, optionally followed by *** Move to: unused/path.
Update chunks start @@ or @@ literal context line (not numeric unified-diff headers). Prefix unchanged lines with a space, deletions with -, additions with +. An addition-only chunk appends; include surrounding context to insert elsewhere. *** End of File anchors a chunk to EOF. Multiple chunks use original-file order. A move-only update is allowed.
Matching tries exact, trailing-whitespace, surrounding-whitespace, then Unicode-punctuation tolerance; ambiguous matches reject, fallbacks are reported. Unchanged context bytes, BOM, existing line endings and EOF newline policy are preserved; new files use LF with a final newline.
Empty/context-only chunks and byte-identical updates are harmless no-ops: they are skipped with warnings, and an all-no-op patch succeeds without writing files. Missing expected lines and other semantic mismatches still reject the complete preflight.
All files are preflighted before commits. Add/move destinations must not exist. No duplicate paths/move chains, symlinks, hardlinks, .git internals, binary files, or outside-cwd paths. Maximum 32 operations, 256 KiB patch, 1 MiB/file, 4 MiB combined before/after content. Results contain committed paths and hashes, warnings and bounded actual diffs (24 KiB/600 lines). Large diffs are explicitly omitted; inspect files/git diff.
Not a multi-file transaction: a late conflict, I/O failure or cancellation can leave partial changes, reported as an error with committed/pending paths. Never blindly retry a partial result. No shell execution, automatic merge, rollback, format, or tests.
Example: *** Begin Patch\n*** Update File: src/a.ts\n@@\n-export const enabled = false;\n+export const enabled = true;\n*** End Patch`,
    promptSnippet: "Apply coordinated add/update/delete/move patches with preflight and actual change reports.",
    promptGuidelines: [
      "Use apply_patch for patch-shaped changes, including multiple files; read affected code first and provide enough context to identify each chunk.",
      "After apply_patch reports partial application, inspect committed and pending paths before making another change; patch success does not prove code correctness.",
    ],
    parameters: Type.Object({ patch: Type.String({ maxLength: MAX_PATCH_BYTES, description: "Complete *** Begin Patch … *** End Patch text." }) }),
    async execute(_id, params, signal, _update, ctx) {
      if (!enabled()) throw new Error("apply_patch is disabled. Enable with /generalist patch on or /patch on.");
      const result = await executePatch(ctx.cwd, params.patch, { signal });
      // Error payloads are text because Pi marks failures only when execute throws.
      const raw = rawJsonOutput(ctx) ? JSON.stringify(result, null, 2) : [
        `Patch ${result.status}.`,
        ...(result.status === "noop" ? ["No files changed."] : []),
        ...result.committed.map(c => `${c.action}: ${JSON.stringify(c.path)} (${c.before ?? "absent"} → ${c.after ?? "absent"})`),
        ...(result.pending.length ? [`Not committed: ${result.pending.map(path => JSON.stringify(path)).join(", ")}`] : []),
        ...(result.error ? [`Error: ${result.error}`] : []),
        ...result.warnings.map(warning => `Warning: ${warning}`),
        result.diff,
      ].filter(Boolean).join("\n");
      const bounded = truncateHead(raw, { maxBytes: 48 * 1024, maxLines: 1800 });
      const text = bounded.content + (bounded.truncated ? "\n[Report truncated; inspect files/git diff before further edits.]" : "");
      if (result.status === "rejected" || result.status === "partial") throw new Error(text);
      return { content: [{ type: "text", text }], details: result };
    },
    renderCall(_args, theme) { return new Text(theme.fg("toolTitle", theme.bold("apply_patch")), 0, 0); },
    renderResult(result) {
      return new Text(safeDisplay(result.content.filter(c => c.type === "text").map(c => c.text).join("\n")), 0, 0);
    },
  });
  return enabled;
}
