# Proposal: evolve Pi’s editing tools without losing the simple `edit` primitive

Status: **broader proposal; separate apply_patch experiment implemented**. See [apply_patch runtime contract](apply-patch.md) for what actually ships. The snapshot-reference, AST, and LSP tools below remain proposals. Reviewed against installed Pi 0.85.1 and local Codex/OMP sources; preferences below are design judgments, not comparative benchmark results.

Implementation decision following user review: exact-only matching is not the patch tool's default. `apply_patch` uses Codex-style progressive whitespace/punctuation tolerance, reports fallback use, preserves original context bytes, and rejects ambiguity at the chosen tier. This supersedes the strict-matcher recommendation below for that experiment; validation/commit guarantees remain separate from matching tolerance.

## Origin: the initial question

> Can you give me your opinion on the edit tool available to you? Does it feel effective compared to Codex's `apply_patch` or OMP's AST/LSP/hashline tooling? Feel free to go look at their local repos and read the tool description and implementation yourself.

The short answer was: Pi’s current exact-text `edit` is an excellent default for small, deliberate one-file changes. It is compact, predictable, and generally produces understandable failures. It is not, however, a complete editing system: it cannot express a coherent multi-file operation, semantic refactor, or structural codemod.

This proposal preserves the current tool as the stable baseline, then adds narrowly scoped capabilities where text replacement is the wrong abstraction.

## Current Pi contract worth preserving

The advertised built-in `edit` contract accepts one `path` and one or more `{ oldText, newText }` replacements, unique and non-overlapping in the original file. The installed implementation is **not strictly exact**: `edit-diff.js` tries exact matching, then NFKC/trailing-whitespace/Unicode-punctuation normalization. Duplicate counting also uses normalized text. Fuzzy replacement can normalize touched lines; unchanged line blocks are preserved in the LF-normalized view. An in-memory probe confirmed that ASCII-quoted `oldText` can replace smart-quoted source.

Pi preserves the BOM and restores a detected line-ending style, but does not preserve each original terminator in a mixed-ending file. Its queue coordinates participating writes within one process (realpath-keyed for existing paths), not other processes or all filesystem aliases. It generates diff/patch metadata; the current model-facing text is only a replacement-count success message. Do not assume metadata is visible to the model.

Those properties make it a strong primitive:

- ordinary calls have a small schema and little special syntax;
- unique textual targeting and overlap rejection are useful guardrails, though the current normalization policy needs to be made explicit;
- disjoint changes in the same file are evaluated against the same source snapshot;
- the tool need not infer language, parse partially broken code, or run a language server.

Keep the existing call shape and availability by default. Do not silently change legacy matching semantics or replace the default with an AST, LSP, hash-anchor, or patch grammar. New checked tools should use an explicitly strict matcher; any tightening of built-in behavior needs a separate compatibility decision.

## Independent assessment of the affordances

Separate four concerns: **target selection**, **replacement expression**, **validation**, and **commit/reporting**. A patch syntax is not a transaction; a hash is not semantic understanding; successful application is not correct code.

- **Exact replacement:** an excellent low-ceremony baseline for prose, configuration, and small code changes. Its main cost is copying old content and enough surrounding text to distinguish repetition. A unique match protects location, not stale assumptions about the rest of the program.
- **Patch syntax:** often more natural for coherent multi-hunk changes, with unchanged context expressed once rather than copied into both old/new strings. Freeform patches avoid JSON escaping, but require grammar fidelity. Do not assume patches are inherently noisier or more fragile: measure by model and task. Codex's matcher also tolerates whitespace/Unicode differences and selects a matching sequence rather than enforcing Pi-style global uniqueness. Keep patch input a benchmark candidate, potentially feeding the same checked mutation backend—not a rejected alternative.
- **Anchored ranges:** useful when they replace the need to reproduce old content. An anchor plus a mandatory full `oldText` mostly adds ceremony. Whole-file revision + explicit range, opaque snapshot-bound references, and per-line hash syntax are competing encodings worth measuring. Two endpoint hashes alone do not validate the interior of a replaced range. Short hashes are accidental-staleness hints, not locks or identity proofs.
- **AST rewrites:** a substantial upgrade for repeated syntax-shaped changes, but not symbol-aware renaming or proof of semantic equivalence. Patterns can match unrelated bindings, and valid rewrites can change evaluation order or side effects.
- **LSP:** the strongest addition for symbol identity, references, and server-supported refactoring. It depends on the server's project configuration and synchronized buffers; a workspace edit is a proposal, not automatically safe or complete.
- **Feedback:** bounded actual diffs, explicit fallback/recovery notices, and precise partial-write outcomes matter at least as much as input syntax. Preview should be required for broad or semantic operations, not an extra round trip for every tiny edit.

Preferred direction: retain the simple baseline, experiment with a small checked textual surface, and evaluate LSP/AST independently. Do not commit to a large tool family merely to cover every possible affordance.

## Goals

1. Reject invalid multi-file requests before any destination changes; report commit-stage partial application honestly.
2. Reduce fragile retyping of long context without making every read noisy.
3. Give structural and semantic work a first-class, explicit route.
4. Make concurrency, stale input, diagnostics, and partial-failure behaviour honest in tool results.
5. Preserve compatibility with existing `read`, `edit`, `write`, extension APIs, transcripts, and model prompts.

## Non-goals

- Reimplement a full IDE, all language servers, or OMP wholesale.
- Promise an all-or-nothing filesystem transaction where the underlying platform cannot provide one.
- Add silent fuzzy matching to checked tools. Their target/precondition checks must be explicit; existing legacy behavior is a separate compatibility matter.
- Make every edit wait for LSP startup or require a parseable source file.
- Treat a line hash as a cryptographic integrity guarantee.

## Proposed tool family

| Need | Tool | Default? | Safety model |
| --- | --- | --- | --- |
| One-off local text change | existing `edit` | Yes | Unique textual replacement against one original snapshot, with legacy normalization |
| Coordinated textual changes | experimental `edit_batch` | Opt-in | Validate every file and edit before commit; partial outcomes remain possible |
| Avoid retyping long targets | experimental `read_refs` / `edit_refs` | Opt-in | Snapshot-bound ranges; no old-text retransmission |
| Repeated syntactic transformation | `ast_edit` | Discoverable | AST pattern/rewrite, dry-run preview, explicit apply |
| Rename/code action/formatting | `lsp` operations | Discoverable and capability-gated | Language-server workspace edit, preview before apply |

These are capability sketches, not a commitment to expose five new schemas simultaneously. Names and discovery are provisional. This repository is an extension package: initially add opt-in tools without changing built-ins. A later upstream integration can share internals or extend `read`/`edit`; an extension must not claim its private locks coordinate built-in mutations. Verify supported registration, result serialization, tool activation, hooks, and custom filesystem adapters before implementation. Do not assume OMP-style discoverability is available unchanged in Pi.

Choose the simplest tool that expresses the intent, with one shared checked mutation backend where integration permits.

## Phase 1 — strengthen the existing textual path

### 1. Add a content revision precondition

Prototype a checked reader that returns a revision computed from the **entire raw file byte snapshot**, before decoding, newline normalization, pagination, or display truncation. Hash and display must derive from the same captured buffer. A partial read still identifies that whole-file snapshot, but must separately report the exact displayed line coverage; a digest does not mean the model inspected unseen content. Bound file sizes and reject unsupported/binary input explicitly.

Put the revision in bounded model-visible text as well as structured details. The model must copy a returned token, never invent or calculate one. A future compatible `edit` extension could accept optional `expectedRevision`:

```ts
{
  path: "src/config.ts",
  expectedRevision: "sha256:…",
  edits: [{ oldText: "enabled: false", newText: "enabled: true" }]
}
```

If the file has changed, fail before matching or writing and return a bounded, current context around the first relevant old-text match when one exists. Do not attempt automatic merging in `edit`. A stale precondition should remain a crisp failure.

For a checked tool, require the revision; leave legacy `edit` unchanged. Whole-file checks deliberately reject unrelated outside changes too, so they may increase retries. Benchmark this cost rather than requiring them for all ordinary edits. Content digests detect byte differences, not change history (an A→B→A sequence is indistinguishable) or semantic freshness.

### 2. Make write semantics explicit and durable

Design a shared checked writer; migrating built-in `edit`/`write` to it is a separate compatibility decision. For supported regular files:

1. read and validate all required source state;
2. write a same-directory temporary file with the intended mode where applicable;
3. flush it as platform support permits;
4. atomically replace the destination;
5. only then report success and invalidate caches.

Atomic replacement protects readers from a torn file; it is **not compare-and-swap**, and fsync/directory-fsync durability is a separate platform-dependent guarantee. Revalidate destination bytes/identity immediately before replacement, but disclose the remaining check-to-rename race with non-participating writers. Cross-process safety requires a cooperative ownership/locking protocol or isolated worktrees, not just a digest.

Define symlink and hardlink policy before coding: replacing a symlink path can destroy the link, while replacing one hardlink breaks shared-inode semantics. For the first checked writer, reject symlinks, multiply-linked files, and non-regular files rather than silently changing their meaning. Resolve parent aliases and reject duplicate targets. Mode, ownership, ACLs, xattrs, and Windows sharing behavior need explicit supported/unsupported policy; a temp-and-rename migration is not automatically compatible with direct writes.

Failures must distinguish no committed destination, committed replacement with reporting/durability failure, and uncertain outcome. Retain locks until in-flight operations settle even on cancellation. Do not promise crash recovery from an ordinary tool result: recovery after process loss needs a persisted journal.

### 3. Improve failure payloads, not matching laxity

For a non-unique `oldText`, report the number of matches and bounded numbered excerpts. For a missing match, return a bounded candidate context, clearly labeled as a hint and never automatically applied. Checked matching is strict with an explicit newline policy; preserve untouched raw bytes. Report the operation index, match policy, before/after revision, and actual bounded diff in model-visible results. Continue to reject overlaps and match every edit against the original snapshot. Do not present new binary/encoding rejection as already guaranteed by built-in Pi.

## Phase 2 — `edit_batch`: preflighted multi-file text operations

Introduce an explicit tool rather than overloading `edit`:

```ts
{
  files: [
    {
      path: "src/a.ts",
      expectedRevision: "sha256:…",
      edits: [{ oldText: "oldName", newText: "newName" }]
    },
    {
      path: "tests/a.test.ts",
      expectedRevision: "sha256:…",
      edits: [{ oldText: "oldName", newText: "newName" }]
    }
  ]
}
```

Initial scope is updates to existing regular text files only. Create/delete/move operations, destination-absence preconditions, path cycles, and resource-operation approvals are separate extensions—not implicitly supported by this schema. Keep the per-file `edits` shape consistent with built-in Pi; the outer `files` array supplies batching.

Resolve and de-duplicate file identities, acquire a stable ordered set of participating locks, read all inputs, validate revisions and strict-match rules, and derive all proposed outputs before changing any destination. Stage all output temp files before committing the first replacement. Any preflight/staging error leaves destinations unchanged (temporary files may need cleanup).

Recheck all inputs before commit, and each destination immediately before its replacement; stop at the first conflict or failure. These checks do not close external-writer races. A late conflict, cancellation, or filesystem failure can produce partial application even without a crash. Results must carry one of:

- `applied`: all replacements committed;
- `rejected`: no destination replacement committed;
- `partial`: some replacements committed; list committed and untouched paths plus the failed operation; or
- `indeterminate`: the writer cannot establish whether an operation committed; identify what must be re-read.

Include before/after revisions for known commits and distinguish mutation outcome from diagnostics/reporting/durability errors. An operation ID may correlate results but is not durable idempotency unless backed by persisted state. Do not blindly retry or roll back a partial batch: either could overwrite intervening user changes. Recovery must check that each destination still equals this operation's recorded post-image before proposing inverse edits.

Do not call this “atomic” across files. Preflight eliminates errors detectable on the captured inputs, not changes occurring later. Process death can prevent any result being returned; crash-recoverable status requires a separate journal. No rollback/journal implementation is required for the initial experiment.

The result includes bounded per-file actual diffs and a combined unified patch, with explicit truncation and a retrieval route for larger artifacts. A batch should have bounded file and byte limits, with a clear error directing the agent toward a scripted mechanical transformation or `ast_edit` where appropriate.

## Phase 3 — opt-in anchors, not mandatory hashline mode

Prototype a companion `read_refs` that emits ordinary numbered lines plus one snapshot reference and exact displayed coverage. Bind references to the canonical file, raw-byte revision, and coverage. A bounded cache can keep long digests out of model-authored calls; expired, reloaded, or foreign-session references must reject rather than resolve against a newer snapshot.

An illustrative `edit_refs` operation replaces a range without retyping its old contents:

```ts
{
  path: "src/config.ts",
  snapshot: "read_17",
  edits: [{ kind: "replace_lines", start: 42, end: 57, newText: "…" }]
}
```

Specify 1-based inclusive ranges against the original snapshot. Every replaced line must have been shown in full, not elided or byte-truncated. Validate the entire current file revision before applying, not just range endpoints. Insertions use explicit `insert_before`/`insert_after` boundaries; define BOF/EOF, empty-file, final-newline, and line-ending behavior. Reject overlaps and ambiguous same-boundary ordering. New bytes come from the model; untouched bytes must survive exactly.

This is a candidate encoding, not the predetermined winner. Compare it with per-line hash anchors and patch input. Per-line anchors can localize stale checks and allow unrelated changes, but must validate full replaced ranges and disambiguate repeated content. A stronger line digest alone does not establish those properties. Snapshot+range is simpler but conservatively rejects any whole-file drift and requires copying line numbers accurately.

Do not auto-rebase rejected references in the first experiment. Return `stale_snapshot`, `stale_anchor`, or `expired_reference` with bounded current context. Cached three-way merge is not inherently bad—it can preserve independent changes—but introduces conflict and provenance policy. Evaluate it separately with explicit recovery notices and adversarial wrong-target tests. Never equate a clean textual merge with semantic correctness.

## Phase 4 — structural and semantic tools

### `ast_edit`

Provide a native or extension-hosted structural rewrite tool for supported Tree-sitter/ast-grep languages. It takes pattern/replacement operations and paths; defaults to dry-run; returns replacement count, per-file diff, parse errors, and scope limits. Record a bounded immutable proposal containing the concrete target list, input revisions, resolved edits, and output digests. Apply only those recorded edits after revision checks; do not silently rescan a glob and include newly created files. If recomputation is necessary, it must reproduce the recorded proposal exactly or require a new preview.

Define parser/grammar versions, language selection, overlapping rewrite ordering, symlink/generated-file policy, and whether any parse error rejects the whole proposal. Default to fail-closed for parse errors. Parse resulting code where supported, but still require relevant tests: syntactic validity does not prove semantic preservation.

This is for codemods such as changing a call shape across a directory—not for a one-line local edit. It must make its syntax and language limitations visible rather than pretending every text format is source code.

### LSP operations

Expose capability-gated operations for rename, code actions, formatting, definitions/references, and diagnostics. Read-only navigation can ship independently of mutation. A rename or code action first returns a previewable workspace edit, captured as an immutable proposal. Applying it uses the same preflight/revision checks as `edit_batch` and reports partial application honestly.

Validate server document versions, negotiated position encoding (including UTF-16 offsets), disk/buffer synchronization, and allowed URI/path scope. Reject unsupported resource operations until create/delete/rename semantics exist in the checked backend. Server-issued commands and opaque code-action side effects are not ordinary text edits; require a separate explicit policy rather than executing them as part of preview/apply. Applying a recorded preview is agent confirmation, not user approval or expanded authorization.

LSP servers are optional dependencies: unavailable, slow, or failing servers must not degrade ordinary `edit`. Do not auto-run formatting after every textual write by default; make it an explicit action or a user-configured post-write policy.

## Selection guidance for the model

- Prefer `edit` for a few known, unique local replacements.
- Prefer `edit_batch` when the textual change must agree across files.
- Prefer checked references when replacing long or repetitive ranges already inspected; re-read after a handoff if references are session-bound. Revisions help detect concurrency but do not make shared-file editing race-free.
- Prefer `ast_edit` for repeated syntax-shaped rewrites.
- Prefer LSP rename/code action for symbol-aware changes.
- Use `write` only for a new file or intentional whole-file replacement.
- Use shell scripts only for genuinely mechanical bulk changes that exceed tool limits, then inspect the exact diff.

## Acceptance criteria and tests

### Compatibility

- Existing `edit` calls and resumed transcripts continue to work unchanged.
- LF, CRLF, mixed line endings, BOMs, no-final-newline files, Unicode, and binary-file rejection have coverage.
- Multiple replacements remain based on the original file content and reject overlaps.

### Concurrency and durability

- A revision mismatch detected before commit produces zero destination writes; drift during commit stops subsequent replacements and reports any partial result.
- A batch with one missing/non-unique replacement produces zero writes.
- Lock ordering prevents same-process deadlock.
- Fault injection distinguishes preflight rejection, committed output, and partial commit; no success result is emitted for a partial commit.
- Temp-file cleanup, metadata policy, symlink/hardlink rejection, parent aliases, and Windows replacement behavior are tested per supported platform.
- Cancellation before staging, between replacements, and after replacement but before reporting preserves accurate outcomes.
- Revision/display snapshot consistency, truncated reads, mixed terminators, and strict-versus-legacy normalization are tested explicitly.
- External writes during preflight and commit exercise late conflicts; tests/documentation acknowledge the remaining non-cooperative race rather than claiming CAS.

### Anchors

- Anchors reject changes to their referenced content and report bounded current context.
- Repeated lines, whitespace-only lines, line insertions, and line moves do not silently target the wrong region.
- References add no tokens to ordinary `read` output unless requested.
- A changed interior line with unchanged endpoints rejects range replacement; partial/elided reads cannot authorize unseen ranges.
- Expired/foreign references, empty files, BOF/EOF insertions, same-boundary edits, and no-final-newline behavior have explicit tests.

### Structural/semantic tools

- `ast_edit` previews match counts and diffs, rejects drift on apply, and surfaces parser failures.
- LSP edits test multi-file text changes, Unicode position conversion, version drift, unsaved-buffer mismatch, and rejected out-of-scope URIs/unsupported resource operations; unavailable LSP remains a clean capability error.
- Preview application excludes new glob matches, rejects input drift, and never invokes unreviewed server commands.

## Rollout and decision gates

1. First characterize current behavior and measure baseline tasks. Separate installed legacy replacement from a strict replacement candidate; do not label them both exact.
2. Prototype only a checked reader and one checked mutation surface in an opt-in extension, with bounded model-visible outcomes. Verify Pi API integration before changing built-ins or promising shared locks. Add batch support only after the writer's failure model is tested.
3. Compare replacement, patch, snapshot-range, and hashline encodings across representative small and strong models. Measure end-to-end task correctness, wrong-target edits, preservation of unrelated bytes, retries, input **and** output tokens (including tool instructions, reads, previews, and recovery), latency, and partial outcomes. Include repetitive code, long deletions, insertion-only changes, Unicode/whitespace, and external drift. Keep backend safety comparable so syntax is not confounded with a different commit engine.
4. Choose encodings from observed gains, not blanket claims about what models find natural. Wrong-target and lost-update failures are release blockers, not acceptable tradeoffs for fewer tokens. Keep measurements local and opt-in, without source text in aggregate reports.
5. Evaluate read-only LSP and bounded AST codemods independently; they need not wait for hashline experiments. Mutation integration follows the checked backend and immutable-preview contract.

The key product decision is conservative: retain Pi’s simple text-replacement interface as the everyday baseline, while accurately documenting its matching behavior. Add power as explicit modes with bounded guarantees, rather than turning ordinary edits into a complicated protocol.

## Reference observations

Local observations, not upstream version-independent promises or benchmark evidence:

- Pi 0.85.1: `/home/baketnk/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/{edit.js,edit-diff.js,file-mutation-queue.js}`. The matcher/helper was inspected and an in-memory smart-quote fallback probe passed; no source file was modified by the probe.
- Codex local HEAD `ca6fb194b6`: `/mnt/secondary/workspace/codex/codex-rs/apply-patch/src/{parser.rs,file_update.rs,seek_sequence.rs,lib.rs}`. Sequential/fallback matching and partial-application tracking are implementation observations.
- OMP local HEAD `83a060396c`: `/mnt/secondary/workspace/oh-my-pi/packages/coding-agent/src/hashline/`, `src/prompts/tools/ast-edit.md`, and `src/lsp/edits.ts` (the latter two relative to the same coding-agent package). Earlier inspection found short line hashes, cached three-way recovery, and sequential workspace-edit application. The prior README's performance and atomicity claims are not accepted here as verified guarantees.
- Pi's installed `README.md` documents custom/replacement tools and links `docs/extensions.md` and `examples/extensions/`; those API contracts/examples must be reviewed before implementation. No Pi runtime changes are part of this proposal review.
