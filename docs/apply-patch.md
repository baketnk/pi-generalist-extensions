# Generalist apply_patch

An optional local patch tool, bundled through `extensions/generalist.ts`. No Codex executable, shell invocation, or additional runtime dependency is needed.

## Enable / disable

- `/generalist` → **Apply patch tool (local project files)**.
- `/generalist patch on|off|toggle` or `/patch on|off|status` (bare `/patch` toggles).
- `pi --patch` seeds enabled state for branches with no saved choice.

Default: **off**. The choice is branch-local, persisted using the existing toggle controller; reload/resume/tree navigation restore it. Forks inherit the branch's recorded choice. Disabling removes the tool from the active set and its executor also rejects disabled calls. Other tools, including built-in `edit` and `write`, are left untouched. This is not a security boundary against `bash` or other extensions. As with other active-tool controls, explicit CLI tool exclusions may prevent a tool from being available even when its feature preference is on.

The standalone extension is `extensions/apply-patch.ts`; do not load it separately alongside the bundle. It operates on **local cwd**, not a custom remote/sandbox filesystem adapter. Keep it disabled when other file tools have been redirected elsewhere. Existing guards that only recognize `edit`/`write` must explicitly handle `apply_patch` too.

## Tool input

Pi exposes a JSON tool with one `patch` string (not Codex's provider-specific freeform tool transport):

```json
{"patch":"*** Begin Patch\n*** Update File: src/config.ts\n@@\n-export const enabled = false;\n+export const enabled = true;\n*** End Patch"}
```

The string contains Codex-style patch text:

```diff
*** Begin Patch
*** Update File: src/config.ts
@@
-export const enabled = false;
+export const enabled = true;
*** Add File: notes/change.md
+Enabled the feature.
*** Update File: old-name.txt
*** Move to: new-name.txt
*** Delete File: obsolete.txt
*** End Patch
```

- Add/update/delete/move and multiple ordered chunks are supported. A move-only update needs no chunk. An Add File with no content creates an empty file.
- Updates accept `@@` or `@@ literal source line` to skip past that line. These are not numeric unified-diff headers. Prefix context with a space, removed lines with `-`, and added lines with `+`.
- An addition-only chunk **appends**. Include neighboring context to insert before/inside existing code. `*** End of File` restricts the preceding chunk to EOF.
- Empty and context-only chunks are ignored with warnings. Byte-identical updates are also reported and skipped without rewriting the file. If every operation is a no-op, the tool returns a successful `noop` result with no committed paths.
- All chunks use original-file coordinates. Combine multiple edits to a file into one Update File section. Duplicate targets, path aliases, parent/child targets, move chains/cycles, and overwriting Add/Move destinations reject before commit.
- No Markdown fences, heredocs, shell commands, environment IDs, binary patches, or ordinary `git diff` headers.

## Matching and preservation

Matching follows Codex's progression: exact first, then ignore trailing whitespace, then leading/trailing whitespace, then normalize common Unicode quotes/dashes/spaces. A lower tier is tried only when the previous tier has no match. Multiple matches at the selected tier reject with candidate line numbers; more source context or a literal `@@` anchor resolves ambiguity. This differs from Codex's first-match behavior.

Fallback matching is reported, not silently hidden. Matching normalization never rewrites preserved context lines. The model's added lines are written as authored (no automatic indentation repair). Existing BOM, untouched line terminators (including mixed endings), and final-newline presence are preserved. Added lines use the source's first detected terminator, or LF for an empty file. New files use LF and a final newline when nonempty. This differs from Codex's historical normalize-to-LF behavior.

No-op tolerance is deliberately narrow: malformed content, missing expected lines, ambiguity, and other semantic mismatches still reject the complete preflight. The tool never skips a failed meaningful edit and commits the rest merely because the failed hunk itself made no write.

## Commit guarantees and limits

1. Parse the patch, resolve paths, and reject duplicate/unsupported path shapes.
2. Acquire sorted shared Pi file-mutation queues for sources and destinations, then read inputs, validate every operation and compute every output under those queues. These coordinate with participating built-in `edit`/`write` calls in the **same process**.
3. Stage output in same-directory temporary files and flush file contents before replacing any destination.
4. Revalidate all inputs, then each destination immediately before its commit. Updates use rename; additions use no-clobber hard-link publication from the staged file; deletes use unlink. A move publishes its destination before deleting its source.
5. Report actual committed paths, before/after SHA-256 hashes, pending paths, matching warnings, and bounded actual diffs. Normal text is readable; `/generalist output on` requests raw JSON. Failures throw so Pi marks them as errors.

**This is not a multi-file transaction or filesystem CAS.** Late conflicts, I/O errors, or cancellation may leave partial changes. A move can leave both source and destination if source deletion fails. A crash can prevent any result being returned. No automatic rollback, retry, or crash-recovery journal exists. Non-participating writers can still race between validation and mutation; use isolated worktrees for independent agents. Path validation is not a sandbox against malicious directory replacement races.

Supported: regular, single-link, NUL-free UTF-8 files inside canonical cwd. Symlink components, hardlinked source files, special files, special permission bits, `.git` internals, and outside-cwd targets are rejected. POSIX mode and owner/group are retained (failure to set them rejects staging). Atomic replacement changes inode identity and does **not** preserve ACLs, xattrs, timestamps or Windows alternate streams. Do not use it on files needing those metadata guarantees. File flush does not imply directory-fsync/power-loss durability. Case-only target aliases are conservatively rejected on macOS/Windows; Windows device/alternate-stream/normalized-alias names are also rejected. macOS/Windows behavior is not yet natively tested.

Bounds: 32 file operations, 256 KiB patch input, 1 MiB per input/output file, 4 MiB combined content, 8 KiB combined target paths, and a bounded matching-work budget. Diff computation is skipped when a file's combined before/after content exceeds 128 KiB or 2000 lines; model-visible diffs are bounded to 24 KiB/600 lines and total text reports to 48 KiB/1800 lines. Omitted/truncated diffs are labeled; inspect files or `git diff` for full changes. Failed staging cleans temporary files and attempts to remove newly created empty directories. Cleanup errors are warnings, not a false claim that committed edits failed.

## Provenance / tests

The parser/matcher adapts the Apache-2.0 OpenAI Codex format and approach. Attribution, modification notices, and license text are in `licenses/codex-NOTICE`, `licenses/codex-Apache-2.0.txt`, and the source header.

`tests/apply-patch.test.ts` covers parsing, matching tiers, preservation, operations, preflight rejection, late conflicts, cancellation, and shared-queue behavior. `tests/apply-patch-extension.test.ts` covers registration, disabled execution, settings/TUI controls, branch restore, and output rendering. `tests/apply-patch-sdk.test.ts` runs the real Node/Pi loader and synthetic agent loop with network forbidden, checking parallel built-in edit interoperability, activation, and Pi's error flag. No AST/LSP or snapshot-reference tools from the larger editing proposal are implemented here.
