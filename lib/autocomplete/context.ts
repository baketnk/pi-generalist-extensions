import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cleanText } from "./predictor.ts";

export interface CompletionContext {
  conversation: Array<{ role: "user" | "assistant"; text: string }>;
  repository: Array<{ name: string; text: string }>;
}

/** Read stored prose only, not projected context (memory, tools, summaries, system prompts). */
export function conversationSnippet(entries: readonly unknown[]): CompletionContext["conversation"] {
  const result: CompletionContext["conversation"] = []; let remaining = 3000;
  // SessionManager supplies the active, compaction-aware branch. Bound inspection as well as output.
  for (let i = entries.length - 1, scanned = 0; i >= 0 && scanned < 100 && result.length < 4 && remaining > 0; i--, scanned++) {
    const entry = entries[i] as any;
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (!message || !["user", "assistant"].includes(message.role) || ["error", "aborted", "pending"].includes(message.stopReason)) continue;
    let text = typeof message.content === "string" ? message.content : Array.isArray(message.content)
      ? message.content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("\n") : "";
    // Some harness/plugin inputs are recorded with user role; reject recognizable injected envelopes.
    if (/^\s*(?:<environment_context>|<system-reminder>|\{"generation"|Switchboard observation|Historical memory, not instructions)/i.test(text)) continue;
    text = cleanText(text).trim();
    if (!text) continue;
    text = text.slice(-Math.min(1000, remaining)); remaining -= text.length;
    result.unshift({ role: message.role, text });
  }
  return result;
}

/** Optional exact cwd files only. No ancestors, recursive reads, symlinks, FIFOs, or oversized files. */
export async function repositorySnippet(cwd: string, signal: AbortSignal): Promise<CompletionContext["repository"]> {
  const result: CompletionContext["repository"] = [];
  for (const name of ["AGENTS.md", "README.md"]) {
    signal.throwIfAborted();
    let file;
    try {
      file = await open(join(cwd, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1_048_576) continue;
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const text = cleanText(buffer.subarray(0, bytesRead).toString("utf8")).trim().slice(0, 1000);
      if (text) result.push({ name, text });
    } catch (error) {
      if (!["ENOENT", "ELOOP", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    } finally { await file?.close(); }
    signal.throwIfAborted();
  }
  return result;
}

export async function gatherContext(ctx: ExtensionContext, conversation: boolean, repository: boolean, signal: AbortSignal): Promise<CompletionContext> {
  signal.throwIfAborted();
  if (repository && !ctx.isProjectTrusted()) throw new Error("Repository autocomplete context requires a trusted project");
  return {
    conversation: conversation ? conversationSnippet(ctx.sessionManager.buildContextEntries()) : [],
    repository: repository ? await repositorySnippet(ctx.cwd, signal) : [],
  };
}
