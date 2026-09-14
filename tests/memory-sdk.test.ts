import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("real Node/Pi loader and agent loop bind captures, preserve packet prefixes through writes and honor off", () => {
  const root = mkdtempSync(join(tmpdir(), "native-sdk-test-"));
  try {
    const result = spawnSync("node", [fileURLToPath(new URL("./fixtures/native-memory-sdk.ts", import.meta.url)), root], {
      timeout: 20000, maxBuffer: 64 * 1024, encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: root, PI_OFFLINE: "1" },
    });
    expect({ code: result.status, error: result.error?.message, stderr: result.stderr.replace(/\(node:\d+\).*\n|\(Use `node.*\n/g, "") }).toEqual({ code: 0, error: undefined, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({ turns: 3, captureBound: true, packetPrefixPreserved: true, errors: [] });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 25000);
