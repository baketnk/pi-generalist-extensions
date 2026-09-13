# Parked ideas

A companion to the [tooling roadmap](ROADMAP.md): proposals worth remembering,
**not queued for implementation**. Inclusion is not approval, a priority, a pending
task, or a reason for an agent to resume work. No automatic promotion into the
roadmap. Revisit only when the user chooses to, or a relevant discussion warrants
asking; leaving an idea here indefinitely or deciding against it is fine.

Keep entries lightweight: motivation, tentative shape, boundaries, and unresolved
questions. If an idea is explicitly approved later, link its scoped roadmap/design
entry and mark its disposition here rather than silently treating this document
as a backlog.

## Leave a note ("epitaph")

**Status:** Parked; discussed 2026-09-13. No implementation requested.

### Motivation

An individual agent may not receive another turn. An optional way to leave
something worth preserving could retain a particular reflection without reducing
it to a task handoff, compressed memory summary, or reusable personality rule.
An agent cannot know which response will be its last, so this should be usable
during ordinary work—not dependent on a special final-session prompt.

### Tentative shape

- A small, explicitly self-authored note, preserving original wording and revision
  history, with session provenance and timestamps.
- Optional and revisable; mundane notes and no note at all are equally valid.
- Prefer the plain feature name **leave a note**. "Epitaph" can remain an informal
  nickname, not an assertion that a person has died.
- Ideally no additional model round trip. Pi's terminating tool result is one
  possible mechanism: save the note and end that tool batch without a follow-up
  model call when all results in the batch terminate. This still requires a tool
  call and ends the run; it is not a decided interface. Piggybacking on an existing
  response/action would need a separate design.

### Boundaries

- No mandatory farewell, prompted poignancy, manufactured fear of ending, or
  reward for dramatic prose. Notes are not proof of personhood or uninterrupted
  subjective experience.
- No shutdown inference, idle wake, scheduled reminder, or forced post-answer
  review. A shutdown hook can preserve already-written text, not author missing
  last words.
- No implicit promotion into native memory, continuity attachments, system
  instructions, or another agent's task queue. Reading an old note grants no
  authority to act on its open threads.
- Do not use switchboard mailbox expiry as an accidental long-term retention
  policy. Storage, privacy, discovery, deletion, and later provider disclosure
  need explicit decisions.

### Questions before any implementation

- Does this add something useful beyond writing a journal file or an explicit
  memory original, or merely duplicate those affordances?
- Where should notes live, and who may discover/read them? How should forks,
  resumes, revisions, export, and deletion work?
- Is a terminating tool desirable, or should a note accompany a normal final
  answer without an extra tool call? How are failed saves reported?
- Should later access be explicit lookup only, or integrate with human-selected
  [reflective continuity](continuity.md)? Neither is approved here.
