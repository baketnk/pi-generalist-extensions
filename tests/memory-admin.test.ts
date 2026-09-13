import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../lib/memory/store.ts";

test("native initialization requires explicit confirmation and an empty directory", () => {
  const root = mkdtempSync(join(tmpdir(), "native-init-test-"));
  const run = (...args: string[]) => spawnSync(process.execPath, ["tools/memory-admin.ts", "init", root, ...args], { encoding: "utf8" });
  try {
    expect(run().status).toBe(1); expect(existsSync(join(root, "store.json"))).toBe(false);
    writeFileSync(join(root, "LOG.txt"), "Synthetic legacy layout marker");
    expect(run("--confirm", "init-native-memory").status).toBe(1);
    expect(existsSync(join(root, "store.json"))).toBe(false); rmSync(join(root, "LOG.txt"));
    const initialized = run("--confirm", "init-native-memory"); expect(initialized.status).toBe(0);
    const { storeId } = JSON.parse(initialized.stdout);
    expect(new MemoryStore(root, storeId).initialize()).toBe(storeId);
    expect(JSON.parse(run("--confirm", "init-native-memory").stdout).storeId).toBe(storeId);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
