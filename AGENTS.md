# Generalist extension development

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
