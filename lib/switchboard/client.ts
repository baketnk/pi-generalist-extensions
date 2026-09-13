import { request } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { open, mkdir, readdir, unlink, stat } from "node:fs/promises";
import { atomicJson, hash, jsonFile, privateDir, privateFile, privateSocket, secret, VERSION, type Card, type Paths, type Snapshot } from "./shared.ts";

export class ClientError extends Error { status: number; constructor(message: string, status = 0) { super(message); this.status = status; } }
export async function rpc<T>(paths: Paths, token: string, data?: unknown, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted(); await privateSocket(paths.socket);
  return new Promise((resolve, reject) => {
    const encoded = data === undefined ? undefined : JSON.stringify(data);
    const req = request({ socketPath: paths.socket, path: encoded ? "/v1/rpc" : "/v1/health", method: encoded ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, ...(encoded ? { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) } : {}) }, signal }, res => {
      let bytes = 0; const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1024 * 1024) { res.destroy(new ClientError("Oversized service response.")); return; } chunks.push(chunk); });
      res.on("error", reject);
      res.on("end", () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if ((res.statusCode ?? 500) >= 400) reject(new ClientError(value.error ?? "Service error.", res.statusCode)); else resolve(value);
        } catch { reject(new ClientError("Invalid service response.")); }
      });
    });
    req.setTimeout((data as { action?: string } | undefined)?.action === "watch" ? 30_000 : 4000, () => req.destroy(new ClientError("Switchboard request timed out; send outcome may be uncertain.")));
    req.once("error", reject); req.end(encoded);
  });
}
export async function ensureService(paths: Paths, signal?: AbortSignal): Promise<void> {
  if (process.platform !== "linux") throw new ClientError("Switchboard currently requires Linux.");
  await privateDir(paths.root); await privateDir(dirname(paths.socket));
  const health = async () => { const h = await rpc<{ version: number }>(paths, "", undefined, signal); if (h.version !== VERSION) throw new ClientError("Switchboard protocol mismatch.", 409); };
  try { await health(); return; } catch (e) { if (e instanceof ClientError && e.status) throw e; signal?.throwIfAborted(); }
  const lock = join(paths.root, "daemon.lock"); await privateFile(lock);
  const handle = await open(lock, "a", 0o600); await handle.close();
  // flock serializes daemon lifetime, including stale-socket removal. No PID-file races.
  const child = spawn("flock", ["-n", lock, process.env.PI_SWITCHBOARD_NODE ?? "node", fileURLToPath(new URL("./daemon.ts", import.meta.url)), paths.root, paths.socket], {
    detached: true, stdio: "ignore", env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG },
  });
  let launchError: Error | undefined; child.once("error", e => { launchError = e; }); child.unref();
  for (let i = 0; i < 30; i++) {
    signal?.throwIfAborted(); if (launchError) throw launchError;
    await new Promise(resolve => setTimeout(resolve, 100));
    try { await health(); return; } catch (e) { if (e instanceof ClientError && e.status) throw e; }
  }
  throw new ClientError("Switchboard unavailable. Requires Node 24+ and flock; check configured paths/runtime.");
}
export interface Binding { token: string; off?: boolean; manual?: boolean; hinted?: string[] }
export async function bindingAt(paths: Paths, key: string): Promise<{ file: string; binding: Binding }> {
  const dir = join(paths.root, "clients"); await privateDir(paths.root); await privateDir(dir);
  const file = join(dir, `${hash(key)}.json`);
  // Exclusive creation prevents two resumes from accidentally creating two mailboxes.
  const generated = { token: secret() };
  try { const f = await open(file, "wx", 0o600); try { await f.writeFile(JSON.stringify(generated)); await f.sync(); } finally { await f.close(); } }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  const binding = await jsonFile<Binding>(file, generated);
  if (!/^[a-f0-9]{64}$/.test(binding.token)) throw new ClientError("Invalid switchboard binding; explicit recovery required.");
  return { file, binding };
}
export class BoardClient {
  paths: Paths; token: string; runtime: string;
  constructor(paths: Paths, token: string, runtime = randomUUID()) { this.paths = paths; this.token = token; this.runtime = runtime; }
  call<T>(action: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> { return rpc<T>(this.paths, this.token, { action, runtime: this.runtime, ...args }, signal); }
  connect(card: Omit<Card, "id" | "online" | "type" | "updatedAt">, type: Card["type"] = "agent", signal?: AbortSignal, existingOnly = false) { return this.call<Card>("connect", { card, type, existingOnly }, signal); }
  snapshot(signal?: AbortSignal) { return this.call<Snapshot>("snapshot", {}, signal); }
  /** Durable outbox keys are local sidecars, never model-generated credentials. */
  async send(operation: string, envelope: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const dir = join(this.paths.root, "outbox", hash(this.token)); await mkdir(join(this.paths.root, "outbox"), { recursive: true, mode: 0o700 }); await privateDir(dir);
    const file = join(dir, `${hash(operation)}.json`);
    const intent = { key: operation, ...envelope };
    const old = await jsonFile<Record<string, unknown> | undefined>(file, undefined);
    if (old && (await stat(file)).mtimeMs < Date.now() - 14 * 86_400_000) throw new ClientError("Send retry horizon expired; do not silently resend this operation.");
    if (old && JSON.stringify(old) !== JSON.stringify(intent)) throw new ClientError("Operation already exists with different content.", 409);
    if (!old) {
      const files = await readdir(dir);
      // Only age-based cleanup beyond the documented 14-day retry horizon.
      for (const name of files) if (/^[a-f0-9]{64}\.json$/.test(name) && (await stat(join(dir, name))).mtimeMs < Date.now() - 14 * 86_400_000) await unlink(join(dir, name));
      if ((await readdir(dir)).length >= 4000) throw new ClientError("Local outbox quota reached.");
      await atomicJson(file, intent);
    }
    try { return await this.call("send", intent, signal); }
    catch (e) { throw new ClientError(`Send operation ${operation}: ${e instanceof Error ? e.message : "failed"}. Use retry with this operation ID; do not compose a duplicate.`, e instanceof ClientError ? e.status : 0); }
  }
  async retry(operation: string, signal?: AbortSignal): Promise<unknown> {
    const file = join(this.paths.root, "outbox", hash(this.token), `${hash(operation)}.json`);
    const intent = await jsonFile<Record<string, unknown> | undefined>(file, undefined);
    if (!intent || intent.key !== operation) throw new ClientError("Unknown local send operation.");
    if ((await stat(file)).mtimeMs < Date.now() - 14 * 86_400_000) throw new ClientError("Send retry horizon expired; do not silently resend this operation.");
    return this.call("send", intent, signal);
  }
}
