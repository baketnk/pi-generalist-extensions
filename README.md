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

Both default off until selected. Decisions are saved in the current session branch and restored on reload/resume/fork/tree navigation. Saved decisions take precedence over CLI flags. Slash-command changes wait for idle and apply to the next prompt. Enabled toggles appear in the footer.

## Startup questions

A fresh interactive `pi` (or `/new` in an unconfigured launch) asks, in order:

1. **Personality / memory:** plain coding, coding + OptMem, Meitan only, or Meitan + OptMem.
2. **Model / thinking preset:** recently used combinations, keep the current combination, or choose another model and thinking level. The model browser supports typing to filter; thinking choices reflect the selected model's supported levels.

The eight most recently used model/thinking combinations appear first, newest first. Choosing one promotes it; combinations actually used after `/model` or thinking changes are also remembered. History lives in `~/.pi/agent/generalist-model-history.json` (under pi's agent directory when overridden), shared across projects. It stores only provider/model IDs and thinking levels—not credentials or conversation content. Writes are atomic and best-effort; simultaneous pi processes may race on recency. Unavailable, out-of-scope, and no-longer-supported combinations are hidden. Pi's configured default model/thinking settings are **not** changed, and previous choices are never applied silently to a new session.

No automatic questions for resumed/forked/saved sessions, `/reload`, print/JSON/RPC mode, or launches with explicit model/provider/thinking/scoped-model/preset/toggle flags (including Kouseki launches). Initial prompts/files and unknown launcher switches also suppress the picker conservatively. Ordinary name, extension/resource, offline, and terminal-display options are allowed. `pi --no-session-setup` explicitly skips startup questions.

Use **`/session-setup`** to open both steps manually in an interactive session, even when launch flags suppressed startup. Existing `/meitan`, `/optmem`, and `/model` commands still work independently. Cancel the first question to keep everything unchanged; cancel model selection to keep the chosen personality/memory but leave model/thinking unchanged. No automatic re-prompt on reload. History errors warn without blocking session choices; delete a corrupt history file to reset recents.

The package now loads `extensions/generalist.ts`, which initializes both independent toggles before the picker. The original `meitan.ts` and `optmem.ts` remain usable as standalone extensions without startup questions; don't load them separately alongside the package.

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

Tests use temporary context/history and a mocked pi API, plus a component-level model-picker test; they do not read/write personal memory or call a model. On the original machine, installation of the exact already-installed pi 0.85.1 required `bun install --minimum-release-age=0` because it was newer than the local release-age policy.

Uninstall: `pi remove ~/workspace/pi-generalist-extensions`, then `/reload`. Personal context and memory are retained.
