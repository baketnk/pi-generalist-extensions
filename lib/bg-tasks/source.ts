import { execFile } from "node:child_process";

export interface SourceIdentity {
  observedAt: number;
  kind: "git" | "unavailable";
  root?: string;
  head?: string;
  workingTree: "clean" | "dirty" | "unknown";
  reason?: string;
}

/** Local, bounded, best-effort metadata only. Never fetch, stage, or save paths/diffs. */
export async function captureSource(cwd: string): Promise<SourceIdentity> {
  // Do not let inherited Git redirection identify a different checkout. No
  // environment values are serialized. Disable optional index writes/fsmonitor.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const git = (args: string[]) => new Promise<string | undefined>(resolve => {
    execFile("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args],
      { cwd, env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" }, timeout: 2_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024, encoding: "utf8" },
      (error, stdout) => resolve(error ? undefined : stdout));
  });
  const [root, head, status] = await Promise.all([
    git(["rev-parse", "--show-toplevel"]),
    git(["rev-parse", "--verify", "HEAD"]),
    git(["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=none"]),
  ]);
  if (!root?.trim()) return { observedAt: Date.now(), kind: "unavailable", workingTree: "unknown", reason: "Not a worktree, Git unavailable, or bounded probe failed." };
  return {
    observedAt: Date.now(), kind: "git", root: root.replace(/\n$/, ""),
    head: head && /^[a-f0-9]{40,64}$/.test(head.trim()) ? head.trim() : undefined,
    workingTree: status === undefined ? "unknown" : status.length ? "dirty" : "clean",
    reason: status === undefined ? "Status probe failed or exceeded its time/output bound." : undefined,
  };
}
