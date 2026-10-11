import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

for (const mode of ["keyed", "keyless"]) test(`real Generalist loader toggles ${mode} web search, restores on reload, and signals provider errors`, async () => {
  const root = await mkdtemp(join(tmpdir(), "generalist-web-sdk-"));
  try {
    const proc = Bun.spawn(["node", "--disable-warning=ExperimentalWarning", fileURLToPath(new URL("./fixtures/web-search-sdk.ts", import.meta.url)), root, mode], {
      cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: root, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_CODING_AGENT_DIR: root },
      stdout: "pipe", stderr: "pipe", stdin: "ignore",
    });
    const timeout = setTimeout(() => proc.kill(), 20000);
    try {
      const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toContain('"generalistToggle":true');
      expect(stdout).toContain('"reload":true');
      expect(stdout).toContain('"errorFlag":true');
      expect(stdout).toContain('"agentContextPrefix":true');
      expect(stdout).toContain(`"keyless":${mode === "keyless"}`);
    } finally { clearTimeout(timeout); }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 25000);
