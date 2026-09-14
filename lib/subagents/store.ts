import { appendFile, open, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicJson, jsonFile, privateDir, privateFile } from "../switchboard/shared.ts";
import { hash } from "./snapshot.ts";
import { LIMITS, type Launch, type RunRecord, type WorkerEvent } from "./types.ts";

export class RunStore {
  readonly root: string;
  readonly owner: string;
  private owned = false;
  constructor(home: string, owner: string) { this.owner = owner; this.root = join(home, hash(owner).slice(0, 32)); }
  path(id: string, file: string) {
    if (!/^[0-9a-f-]{36}$/.test(id) || !["record.json", "launch.json", "events.jsonl", "worker.json", "sessions"].includes(file)) throw new Error("Invalid run artifact.");
    return join(this.root, id, file);
  }
  async acquire() {
    await privateDir(this.root);
    const lock = join(this.root, "owner.lock");
    try {
      const handle = await open(lock, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid })); await handle.sync(); } finally { await handle.close(); }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      throw new Error(`Session subagent ownership is locked: ${lock}. Another runtime may still own it. After a crash, inspect process/artifact state and remove the stale lock explicitly; no automatic adoption, unlink race, or PID-based killing.`);
    }
    this.owned = true;
  }
  async release() { if (this.owned) { this.owned = false; await unlink(join(this.root, "owner.lock")); } }
  async load(): Promise<RunRecord[]> {
    const result: RunRecord[] = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
      if (result.length >= LIMITS.runs) throw new Error("Run store full; archive historical artifacts explicitly.");
      const record = await jsonFile<RunRecord | null>(this.path(entry.name, "record.json"), null);
      if (!record || record.version !== 1 || record.id !== entry.name || record.owner !== this.owner) throw new Error("Invalid subagent record.");
      if (record.process !== "exited") {
        record.process = "unknown"; record.cleanup = "unknown"; record.taskState = "interrupted";
        record.reason = "Runtime ended without an observed process exit. No automatic restart/adoption; PID is historical only.";
        await this.save(record);
      }
      result.push(record);
    }
    return result.sort((a, b) => a.createdAt - b.createdAt);
  }
  async create(launch: Launch, record: RunRecord) {
    await privateDir(join(this.root, launch.id));
    await atomicJson(this.path(launch.id, "launch.json"), launch);
    await this.save(record);
  }
  async save(record: RunRecord) { await atomicJson(this.path(record.id, "record.json"), record); }
  async launch(id: string) { const value = await jsonFile<Launch | null>(this.path(id, "launch.json"), null); if (!value) throw new Error("Missing launch intent."); return value; }
  async append(id: string, event: WorkerEvent) {
    const path = this.path(id, "events.jsonl"); await privateFile(path);
    let encoded = JSON.stringify(event);
    if (Buffer.byteLength(encoded) > LIMITS.pageBytes) {
      encoded = JSON.stringify({ seq: event.seq, at: event.at, kind: event.kind, tool: event.tool, toolId: event.toolId,
        text: Buffer.from(event.text ?? "").subarray(0, 5000).toString("utf8"), note: "Oversized public event clipped; data omitted. Inspect the private session artifact for complete content." });
    }
    if (Buffer.byteLength(encoded) > LIMITS.pageBytes) throw new Error("Worker event metadata exceeds the page bound.");
    await appendFile(path, encoded + "\n", { mode: 0o600 });
  }
  async page(id: string, after = 0, limit = 40, tail = false) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid event cursor or limit.");
    const path = this.path(id, "events.jsonl"); await privateFile(path);
    let text = ""; try { text = await readFile(path, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    const events: WorkerEvent[] = []; let bytes = 0, more = false;
    const lines = text.split("\n").filter(Boolean);
    for (const line of tail ? lines.reverse() : lines) {
      const event = JSON.parse(line) as WorkerEvent; if (event.seq <= after) continue;
      if (events.length >= limit || bytes + Buffer.byteLength(line) > LIMITS.pageBytes) { more = true; break; }
      events.push(event); bytes += Buffer.byteLength(line);
    }
    if (tail) events.reverse();
    return { events, next: events.at(-1)?.seq ?? after, more };
  }
}
