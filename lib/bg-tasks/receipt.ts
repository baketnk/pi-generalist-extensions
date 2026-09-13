import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JobRecord } from "./runtime.ts";
import type { SourceIdentity } from "./source.ts";

const MAX_RECEIPT_BYTES = 256 * 1024;
const MAX_LOG_BYTES = 64 * 1024 * 1024;
export type Artifact = { state: "available"; bytes: number; sha256: string } | { state: "missing" | "unavailable"; reason: string };
export interface ExecutionReceipt {
  version: 1;
  kind: "execution-receipt";
  origin: "bg_tasks";
  recordedAt: number;
  owner: string;
  shell: { executable: "/bin/bash"; args: string[] };
  job: Omit<JobRecord, "receipt">;
  source: SourceIdentity;
  output: { file: "output.log"; capture: "closed" | "forced_close" | "write_error"; artifact: Artifact };
}

export function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

/** Atomic no-clobber publication, not tamper-proof storage or a multi-file transaction. */
export async function writeImmutableJson(path: string, value: unknown): Promise<string> {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > MAX_RECEIPT_BYTES) throw new Error("Receipt exceeds 256 KiB.");
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    await link(temp, path); // EEXIST rejects; never replace a previous receipt.
  } finally {
    await handle.close();
    await unlink(temp);
  }
  return sha256(bytes);
}

/** Hash at most the retained-log cap with fixed memory; do not follow a final symlink or block on a FIFO. */
export async function hashArtifact(path: string): Promise<Artifact> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > MAX_LOG_BYTES) return { state: "unavailable", reason: "Not a regular bounded log." };
      const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
      let bytes = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, MAX_LOG_BYTES + 1 - bytes), bytes);
        if (!bytesRead) break;
        bytes += bytesRead;
        if (bytes > MAX_LOG_BYTES) return { state: "unavailable", reason: "Log exceeds 64 MiB." };
        hash.update(buffer.subarray(0, bytesRead));
      }
      const after = await handle.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes !== after.size)
        return { state: "unavailable", reason: "Log changed during hashing." };
      return { state: "available", bytes, sha256: hash.digest("hex") };
    } finally { await handle.close(); }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { state: code === "ENOENT" ? "missing" : "unavailable", reason: code ?? "Log read failed." };
  }
}

export async function readReceipt(path: string): Promise<{ receipt: ExecutionReceipt; sha256: string }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Receipt must be a regular file.");
    const buffer = Buffer.alloc(MAX_RECEIPT_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_RECEIPT_BYTES) throw new Error("Receipt exceeds 256 KiB.");
    bytes = buffer.subarray(0, size);
  } finally { await handle.close(); }
  const receipt = JSON.parse(bytes.toString("utf8")) as ExecutionReceipt;
  if (receipt?.version !== 1 || receipt.kind !== "execution-receipt" || receipt.origin !== "bg_tasks" ||
      !receipt.job || typeof receipt.job.id !== "string" || receipt.output?.file !== "output.log" ||
      !["closed", "forced_close", "write_error"].includes(receipt.output.capture)) throw new Error("Unsupported or malformed execution receipt.");
  const artifact = receipt.output.artifact;
  if (!artifact || !["available", "missing", "unavailable"].includes(artifact.state) ||
      (artifact.state === "available" && (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || artifact.bytes > MAX_LOG_BYTES || !/^[a-f0-9]{64}$/.test(artifact.sha256))))
    throw new Error("Malformed receipt artifact.");
  return { receipt, sha256: sha256(bytes) };
}

/** Explicit point-in-time integrity check. Never re-run a job or rewrite its receipt. */
export async function verifyReceipt(path: string, expectedSha256?: string) {
  if (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("Expected receipt SHA-256 must be 64 lowercase hex characters.");
  const saved = await readReceipt(path);
  const receiptIntegrity = expectedSha256 === undefined ? "not_checked" : saved.sha256 === expectedSha256 ? "match" : "changed";
  // Ignore arbitrary paths embedded in a receipt. Only its sibling output.log is checked.
  const actual = await hashArtifact(join(dirname(path), "output.log"));
  const expected = saved.receipt.output.artifact;
  const artifactIntegrity = actual.state !== "available" ? actual.state : expected.state !== "available" ? "unverifiable" :
    expected.bytes === actual.bytes && expected.sha256 === actual.sha256 ? "match" : "changed";
  return { checkedAt: Date.now(), receiptIntegrity, receiptSha256: saved.sha256, artifactIntegrity, actual };
}
