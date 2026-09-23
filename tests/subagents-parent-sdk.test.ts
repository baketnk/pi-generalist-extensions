import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

test("real parent SDK: forced model policy and provider prefix survive tools, users, and reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagents-parent-"));
  await writeFile(join(root, "README.md"), "Synthetic evidence only.\n");
  try {
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn("node", [fileURLToPath(new URL("./fixtures/subagents-parent-sdk.ts", import.meta.url)), root], { stdio: ["ignore", "pipe", "pipe"] });
      let output = ""; const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
      child.stdout.on("data", b => { output += b; }); child.stderr.on("data", b => { output += b; });
      child.once("error", reject); child.once("close", code => { clearTimeout(timer); resolve({ code, output }); });
    });
    expect(result.code, result.output).toBe(0); expect(result.output).toContain('"cachePrefixes":true');
  } finally { await rm(root, { recursive: true, force: true }); }
}, 25000);
