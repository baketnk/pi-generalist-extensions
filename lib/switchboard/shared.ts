import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, realpath, readFile, writeFile, rename } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

export const VERSION = 1;
export const LEASE_MS = 60_000;
export const BODY_BYTES = 16 * 1024;
export type Activity = "idle" | "working" | "waiting-for-user" | "unknown";
export type Kind = "note" | "question" | "reply" | "handoff";
export interface Project { project: string; worktree: string; cwd: string }
export interface Card extends Project {
  id: string; name: string; summary: string; activity: Activity; updatedAt: number;
  online: boolean; type: "agent" | "human" | "observer"; parentId?: string; runId?: string;
}
export interface Mail {
  id: string; sender: string; recipient: string; kind: Kind; createdAt: number;
  expiresAt: number; replyTo?: string; fetchedAt?: number; ackAt?: number; body?: string | null;
}
export interface Snapshot { peers: Card[]; total: number; inbox: Mail[]; pending: number; version: string }
export interface Paths { root: string; socket: string }
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const secret = () => randomBytes(32).toString("hex");
export function plain(s: string): string {
  return s.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");
}
export function clipped(s: string, bytes: number): string {
  let out = "";
  for (const c of s) { if (Buffer.byteLength(out + c) > bytes) break; out += c; }
  return out;
}
export function paths(env = process.env): Paths {
  const root = env.PI_SWITCHBOARD_HOME ?? join(env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "pi-switchboard");
  const socket = env.PI_SWITCHBOARD_SOCKET ?? join(env.XDG_RUNTIME_DIR ?? join(tmpdir(), `pi-switchboard-${process.getuid?.()}`), "pi-switchboard.sock");
  if (!isAbsolute(root) || !isAbsolute(socket) || Buffer.byteLength(socket) > 100) throw new Error("Switchboard paths must be absolute; socket path must fit 100 bytes.");
  return { root, socket };
}
/** Private leaf directories/files; parent path aliases remain valid. Not a same-UID sandbox. */
export async function privateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077)) throw new Error(`Not a private owned directory: ${path}`);
}
export async function privateFile(path: string): Promise<void> {
  try {
    const st = await lstat(path);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077)) throw new Error(`Not a private owned file: ${path}`);
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
}
export async function jsonFile<T>(path: string, fallback: T): Promise<T> {
  await privateFile(path);
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw e; }
}
export async function atomicJson(path: string, data: unknown): Promise<void> {
  await privateFile(path);
  const temp = `${path}.${secret().slice(0, 12)}.tmp`;
  await writeFile(temp, JSON.stringify(data), { mode: 0o600, flag: "wx" });
  await rename(temp, path);
}
export async function projectAt(cwd: string): Promise<Project> {
  cwd = await realpath(cwd);
  const info = await new Promise<string | undefined>(resolve => {
    execFile("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
      { timeout: 1500, maxBuffer: 8192 }, (error, stdout) => resolve(error ? undefined : stdout));
  });
  if (info) {
    const [tree, common] = info.trim().split("\n");
    if (tree && common) return { cwd, worktree: await realpath(tree), project: await realpath(common) };
  }
  return { cwd, worktree: cwd, project: cwd };
}
export function text(value: unknown, field: string, max: number, optional = false): string {
  if (optional && value === undefined) return "";
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max) throw new Error(`${field} must be nonempty text up to ${max} UTF-8 bytes.`);
  return value;
}
