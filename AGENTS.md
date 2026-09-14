# Generalist extension development

- DO. NOT. BREAK. CACHE PREFIXING. A recall refresh is not permission to delete,
  replace, or move memory that has already been sent. That burns cached context
  on every subsequent turn. Keep durable snapshots at their original boundaries;
  append updates. Retries, tool writes, smaller budgets and reloads are NOT reset
  boundaries. If you touch context projection, prove this with provider-payload
  regression tests. Revocation and committed compaction are explicit exceptions,
  not excuses to silently rebuild the prefix.
- Preserve session prompt caching. Do not move, replace, or reinject unchanged
  context ahead of an existing conversation prefix on each request. Prefer stable
  tool/system definitions and append-only, fixed-boundary context snapshots.
- Test provider-bound prefix preservation across ordinary user turns, tool
  follow-ups, retries and reloads. Compaction, explicit activation changes and
  source revocation need honest lifecycle semantics; do not claim cache preservation
  without checking the actual context projection.
- Keep personality, native memory and reflective continuity activation independent.
  Test with synthetic sources, not personal journals or memory stores.
- This checkout may contain concurrent agent work. Inspect exact diffs and coordinate
  overlapping paths; stage only the changes belonging to the current task.
