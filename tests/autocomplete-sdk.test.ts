import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("real Node/Pi model runtime routes autocomplete through extension-registered provider and auth", async () => {
  const root = await mkdtemp(join(tmpdir(), "autocomplete-sdk-"));
  try {
    const proc = Bun.spawn(["node", fileURLToPath(new URL("./fixtures/autocomplete-sdk.ts", import.meta.url)), root], {
      cwd: process.cwd(), env: { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_CODING_AGENT_DIR: root },
      stdout: "pipe", stderr: "pipe", stdin: "ignore",
    });
    const timeout = setTimeout(() => proc.kill(), 15_000);
    try {
      const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toContain('"bothFacadePaths":true');
    } finally { clearTimeout(timeout); }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 20_000);
