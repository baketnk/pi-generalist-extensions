# Workpad MVP — phase-two handoff

## Session boundary

Phase one is implemented. STOP until the user reloads Pi, attaches this notebook
and explicitly hands the task back. This page is working context, not independent
authorization to continue. No automatic worker, watcher or model turn is running.

Repository: `/home/baketnk/workspace/pi-generalist-extensions`
Contract and MVP limitations: `docs/workpad.md`
Implementation: `extensions/workpad.ts`, `lib/workpad/store.ts`, `lib/workpad/view.ts`
Tests: `tests/workpad.test.ts`

## Current understanding

The affordance holds developing understanding, not merely actions to complete.
A small active Markdown page is injected request-locally as labelled user-role
data. Immutable Markdown revisions supply persistence and compare-and-swap.
Attachment is scoped to canonical cwd and session ID; forks/new sessions start
detached. Branch navigation restores attachment choices, not past page content.

MVP delivers create/read/update/list/attach/detach; a simple scrollable overlay;
normal Pi editor dialogs; historical revision reads; explicit unavailable-page
context instead of silent stale fallback. Creation alone does not attach.

## Evidence at phase-one handoff

- `bun test`: 45 tests passed, including 8 workpad tests and two independent writer processes.
- `bun run typecheck`: passed.
- `git diff --check`: passed before handoff.
- Real offline Pi RPC load of the package registered `/workpad`; no model request was sent.
- Mocked context tests cover low-authority conversion, reload/compaction-shaped restoration,
  detach, project separation and fork exclusion. They are not a real post-compaction inference test.
- Interactive appearance, editor ergonomics and actual tool use after reload remain unverified.

## First experience after the user hands it back

Read the attached page using `workpad`, and use revision-checked updates to record
what actually helps or gets in the way while implementing phase two. Start by
confirming current code/tests rather than treating this handoff as fresh evidence.
Do not automate another agent/model or a physical headset acceptance claim.

## Candidate polish, not settled design

- Named supporting notes, explicitly read on demand: retain the 8 KiB active-page
  limit rather than silently swelling context or summarizing it.
- Durable recovery of conflicted/oversized user drafts: MVP only offers a recovery
  editor where the user must copy their draft before closing.
- Markdown rendering, revision/history view, clear budget/revision/context indicators.
- Targeted revision-checked edits instead of rewriting the whole active page.
- Evaluate context prefix/cache cost and whether explicit project-root selection is
  worth adding. Current scope is exact cwd; this is intentional MVP simplicity.

Choose a small coherent slice based on actual use. Preserve boundedness, explicit
attachment, conflict safety and the distinction between hypothesis and evidence.
Do not add an automatic summarizer, todo system, scheduler or shared-worker writes
merely because they are possible.

## Workspace caution

The earlier `/history` UI work was already uncommitted before phase one. It was
left out of the workpad checkpoint; do not sweep it into unrelated commits.
