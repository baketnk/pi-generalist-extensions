# Tool-contract footprint

Measured offline with `bun tools/tool-contract-size.ts` after splitting bg tasks,
subagents, Switchboard, native memory, evidence and reflective continuity.

## Scope and method

- Baseline: `2230b72`, immediately before the bg/subagent split.
- Previous milestone: `0fc2dcf`, after the Switchboard split.
- Current: the working tree containing the remaining splits, closed single-purpose
  history/patch/web schemas, and deduplicated shared guidance.
- Collects registrations from the extension factories in isolated archived source
  trees and the current checkout. No lifecycle hooks, personal stores, source
  activation, provider requests or worker processes run.
- Counts compact UTF-8 JSON in OpenAI function-tool shape (`type`, `name`,
  `description`, `parameters`), plus snippets and deduplicated prompt guidelines.
  These are reproducible contract bytes, not a measurement of provider cache hits.
- Excludes unchanged Pi base instructions, built-in tools, repo/global instructions,
  personality, recalled data and user transcript. Also excludes unrelated concurrent
  sudo work. Actual provider framing/tokenization differs. **Token estimates are
  bytes/4, not a model tokenizer**, and percentages below apply only to this extension
  tool-contract portion, not the entire prompt.
- Factory defaults exclude memory, evidence, patch and web-search tools. Continuity's
  definitions remain visible even with source access off, as before. The memory
  profile adds native memory tools; the all profile enables every measured optional
  tool. Explicit allowlists and saved preferences can produce different loadouts.

## Combined size: schemas and prompt guidance

| Profile | Before any split | Previous milestone | Current | Total growth vs baseline |
|---|---:|---:|---:|---:|
| Factory defaults | 28,748 B | 40,189 B | 34,133 B | +5,385 B / ~1,346 tokens / 18.7% |
| Memory enabled | 30,601 B | 42,042 B | 38,704 B | +8,103 B / ~2,026 tokens / 26.5% |
| All measured options | 36,166 B | 47,607 B | 45,347 B | +9,181 B / ~2,295 tokens / 25.4% |

The current factory-default tool-contract load is **6,056 B (~1,514 estimated
tokens) smaller than the previously pushed milestone**, despite splitting the
remaining families. With memory enabled it is 3,338 B (~835 tokens) smaller.

Deduplication removes repeated background lifecycle rules from six extra system
prompt entries, repeated Switchboard safety text from ten tool descriptions, and
repeated fork lifecycle prose. The rules remain present once in the static family
contract; per-action requirements and descriptions remain local. No dynamic
state-dependent definitions, memory snapshot rewrites or context-prefix moves were
introduced. Activation changes remain explicit lifecycle boundaries.

For context, +1,346 tokens is roughly 1.1% of a 128k context window; with memory,
+2,026 is about 1.6%. This is a modest absolute increase, not zero overhead. Smaller
context windows and provider-specific token counts may make it more significant.

## Reproduce

```sh
bun tools/tool-contract-size.ts
# Optional explicit baseline/milestone revisions:
bun tools/tool-contract-size.ts 2230b72 0fc2dcf
```

The JSON includes schema/guidance byte subtotals, counts, individual family sizes,
and all three profiles. Provider-payload regression tests separately cover prefix
stability over ordinary user turns, tool follow-ups, retries and reloads using
synthetic sources. No paid calls or personal-source reads are needed.
