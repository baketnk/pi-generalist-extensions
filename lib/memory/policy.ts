import { isAbsolute } from "node:path";
import { id } from "./schema.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const POLICY_ENTRY = "generalist:memory:policy-v1";
export interface MemoryPolicy {
  version: 1; sessionId: string; cwd: string; enabled: boolean;
  profile: "project" | "continuity"; personalId?: string; configDigest?: string;
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
      if (data.configDigest !== undefined && !/^[a-f0-9]{64}$/.test(data.configDigest)) continue;
      state = { version: 1, sessionId, cwd: ctx.cwd, enabled: data.enabled, profile: data.profile,
        ...(data.personalId ? { personalId: data.personalId } : {}),
        ...(data.configDigest ? { configDigest: data.configDigest } : {}) };
    } catch { /* malformed state stays off */ }
  }
  return state;
}
