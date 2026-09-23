import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const fork = process.env.PI_FORK_ROOT ?? resolve(import.meta.dir, "../../pi-mono");
const loader = join(fork, "node_modules/tsx/dist/loader.mjs");
// Stock package tests remain portable; this assertion specifically requires our fork.
test.skipIf(!existsSync(loader))("fork SDK: two completions share the natural request and preserve provider prefixes/retry/reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "bg-fork-sdk-"));
  try {
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn("node", ["--import", loader, fileURLToPath(new URL("./fixtures/bg-tasks-fork-sdk.ts", import.meta.url)), root], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH, HOME: root, PI_OFFLINE: "1", PI_FORK_ROOT: fork },
      });
      let output = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 25000);
      child.stdout.on("data", bytes => { output += bytes; }); child.stderr.on("data", bytes => { output += bytes; });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); resolve({ code, output }); });
    });
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('"initialRequests":3');
    expect(result.output).toContain('"providerPrefixes":true');
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);
