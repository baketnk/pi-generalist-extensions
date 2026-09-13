import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("real Node/Pi loader preserves the provider context prefix across user turns, source change and off", () => {
  const root = mkdtempSync(join(tmpdir(), "continuity-sdk-"));
  try {
    const result = spawnSync("node", [fileURLToPath(new URL("./fixtures/continuity-sdk.ts", import.meta.url)), root], {
      timeout: 20000, maxBuffer: 64 * 1024, encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: root, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    });
    expect({ code: result.status, error: result.error?.message, stderr: result.stderr }).toEqual({ code: 0, error: undefined, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({ turns: 6, stablePacket: true, cachePrefix: true, sourceChange: true, off: true, noNetwork: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 25000);
