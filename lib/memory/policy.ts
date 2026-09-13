import { isAbsolute } from "node:path";
import { id } from "./schema.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const POLICY_ENTRY = "generalist:memory:policy-v1";
export interface MemoryPolicy {
  version: 1; sessionId: string; cwd: string; enabled: boolean;
  profile: "project" | "continuity"; personalId?: string;
}
export function readMemoryPolicy(ctx: ExtensionContext): MemoryPolicy {
  const sessionId = ctx.sessionManager.getSessionId();
  let state: MemoryPolicy = { version: 1, sessionId, cwd: ctx.cwd, enabled: false, profile: "project" };
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== POLICY_ENTRY) continue;
    const data = entry.data as MemoryPolicy | undefined;
    state = { version: 1, sessionId, cwd: ctx.cwd, enabled: false, profile: "project" };
    if (!data || data.sessionId !== sessionId || data.cwd !== ctx.cwd) continue; // forks/new cwd never inherit activation
    try {
      if (data.version !== 1 || typeof data.enabled !== "boolean" || !isAbsolute(data.cwd) || !["project", "continuity"].includes(data.profile)) continue;
      if (data.profile === "continuity") id(data.personalId);
      else if (data.personalId !== undefined) continue;
      state = { version: 1, sessionId, cwd: ctx.cwd, enabled: data.enabled, profile: data.profile,
        ...(data.personalId ? { personalId: data.personalId } : {}) };
    } catch { /* malformed state stays off */ }
  }
  return state;
}
export function nativeRequested(ctx: ExtensionContext): boolean {
  // Old test/tool contexts without a session ID have no native activation grant.
  return !!ctx.sessionManager.getSessionId && readMemoryPolicy(ctx).enabled;
}
export function optmemRequested(ctx: ExtensionContext, initialFlag: unknown): boolean {
  let enabled = initialFlag === true;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === "generalist:optmem:enabled" && typeof (entry.data as { enabled?: unknown })?.enabled === "boolean") enabled = (entry.data as { enabled: boolean }).enabled;
  }
  return enabled;
}
