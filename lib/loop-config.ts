import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const LOOP_LIMIT_ENTRY = "generalist:loop-limit-v1";
export const DEFAULT_LOOP_LIMIT = 10;
export const MAX_LOOP_LIMIT = 1000;

export function validLoopLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_LOOP_LIMIT;
}

/** The latest valid branch choice wins; old/malformed entries cannot override it. */
export function loopLimit(ctx: ExtensionContext): number {
  let limit = DEFAULT_LOOP_LIMIT;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === LOOP_LIMIT_ENTRY && validLoopLimit(entry.data)) limit = entry.data;
  }
  return limit;
}
