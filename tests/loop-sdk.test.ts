import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("real Pi session replacement repeats /loop in fresh sessions without network", async () => {
  const root = await mkdtemp(join(tmpdir(), "generalist-loop-sdk-"));
  try {
    const proc = Bun.spawn(["node", fileURLToPath(new URL("./fixtures/loop-sdk.ts", import.meta.url)), root], {
      cwd: process.cwd(), env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: root },
      stdout: "pipe", stderr: "pipe", stdin: "ignore",
    });
    const timeout = setTimeout(() => proc.kill(), 15000);
    try {
      const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toContain('"sessions":3,"requests":3,"noNetwork":true');
    } finally { clearTimeout(timeout); }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 20000);
