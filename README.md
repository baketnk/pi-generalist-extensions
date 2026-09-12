# Generalist pi extensions

Independent, opt-in personality and compact memory extensions for pi 0.85.1 (@earendil-works distribution).

## Install / use

```sh
pi install ~/workspace/pi-generalist-extensions
```

Run `/reload` in an existing pi session, or start a new one.

- `/meitan [on|off|status]`: toggle personality; no argument flips it.
- `/optmem [on|off|status]`: independently toggle compact memory.
- `pi --meitan --optmem`: enable both initially, including print mode.

Both default off. Decisions are saved in the current session branch and restored on reload/resume/fork/tree navigation. New sessions default off unless CLI flags seed them. Saved decisions take precedence over CLI flags. Changes wait for idle and apply to the next prompt. Enabled toggles appear in the footer.

## Context ownership

`~/.meitan/` owns the personality independently of Hermes. SOUL.md and COMPANION_CONTEXT.md are re-read on each enabled prompt (combined cap 50 KB). USER_NOTES.md, PROJECT_NOTES.md, and NOTES_CONVENTIONS.md are on-demand references, not auto-injected. Missing required files produce a visible error and an explicit unavailable-context instruction; no fallback to Hermes or stale cached context.

Set `PI_MEITAN_HOME` to another **absolute** directory if needed. This repo contains code, not personal context; it never creates or edits your context files. The initial local migration copied Hermes files without changing the originals; future changes are not synchronized. Journal stays at `~/workspace/meitan_journal`.

## OptMem

Uses `~/.optmem/memo`, or `PI_OPTMEM_MEMO` (executable path, not a shell command). Inherits OptMem's `MEMORY_DIR`; it does not create a new memory store. The `memo` tool accepts an argument array for wake, note, nap, recall, zoom, and read-only config. Execution is shell-free, cancellable, and limited to 30 seconds. Output is capped at 2000 lines / 50 KB.

The model is instructed to wake before work after enable/start/reload/tree/compaction, complete pagination and requested compression, and save only useful nonredundant facts. Wake/nap sequencing is prompt guidance, not a hard tool gate. No startup subprocess, automated writes, background LLM calls, or shutdown notes. Administrative commands remain outside the tool. Disabling removes the tool and its injected instructions; execute also checks the toggle.

**Off is not a privacy sandbox or amnesia:** ordinary bash/read tools can still reach local files, and prior tool outputs, responses, or summaries remain in conversation history. Use a new session to avoid historical influence. Model/provider behavior still affects personality; pi's coding instructions remain intact.

## Development

```sh
bun install
bun test
bun run typecheck
```

Tests use temporary context and a mocked pi API; they do not read/write personal memory or call a model. On the original machine, installation of the exact already-installed pi 0.85.1 required `bun install --minimum-release-age=0` because it was newer than the local release-age policy.

Uninstall: `pi remove ~/workspace/pi-generalist-extensions`, then `/reload`. Personal context and memory are retained.
