import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InspectFiles, outsideGrantPaths } from "../lib/subagents/files.ts";

const fixtures: string[] = [];
afterEach(async () => {
  for (const root of fixtures.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "subagent-path-warning-"));
  fixtures.push(root);
  const home = join(root, "home"), mount = join(root, "mount"), repo = join(mount, "repo");
  await mkdir(home); await mkdir(repo, { recursive: true });
  await writeFile(join(home, "local.txt"), "local\n");
  await writeFile(join(repo, "remote.txt"), "remote\n");
  await symlink(repo, join(home, "workspace"), "dir");
  return { root, home, repo };
}

test("task-named paths through a symlink ancestor warn about blocked lexical paths and outside canonical targets", async () => {
  const { home, repo } = await fixture();
  const lexical = join(home, "workspace", "remote.txt"), canonical = join(repo, "remote.txt");
  expect(await outsideGrantPaths(`Inspect ${lexical}.`, [home])).toEqual([lexical, canonical]);
  expect(await outsideGrantPaths(`List ${join(home, "workspace")}/.`, [home])).toEqual([join(home, "workspace"), repo]);
  await expect(new InspectFiles(home).text(lexical)).rejects.toThrow("symlinks");
  expect(await outsideGrantPaths(`Inspect ${lexical}.`, [home, repo])).toEqual([lexical]);
  await expect(new InspectFiles(home, [], [repo]).text(lexical)).rejects.toThrow("symlinks");
  expect(await outsideGrantPaths(`Inspect ${canonical}.`, [home, repo])).toEqual([]);
  expect(await new InspectFiles(home, [], [repo]).text(canonical)).toBe("remote\n");
});

test("in-grant symlink targets, symlink leaves, and dangling symlinks are still blocked", async () => {
  const { home } = await fixture();
  const target = join(home, "local.txt"), alias = join(home, "alias.txt");
  const dangling = join(home, "dangling.txt");
  await symlink(target, alias);
  await symlink(join(home, "missing.txt"), dangling);
  expect(await outsideGrantPaths(`Read ${alias} and ${dangling}.`, [home])).toEqual([alias, dangling]);
  await expect(new InspectFiles(home).text(alias)).rejects.toThrow("symlinks");
  await expect(new InspectFiles(home).text(dangling)).rejects.toThrow("symlinks");
  expect(await outsideGrantPaths(`Read ${target}.`, [home])).toEqual([]);
});

test("ordinary existing outside paths warn; in-root paths, missing paths and URLs do not", async () => {
  const { root, home } = await fixture();
  const outside = join(root, "outside.txt"), inside = join(home, "local.txt");
  await writeFile(outside, "outside\n");
  expect(await outsideGrantPaths(`Compare ${outside} and ../outside.txt with ${inside}. Missing ${join(root, "missing.txt")}; https://${outside} and https://example.com/x.`, [home])).toEqual([outside]);
  expect(await outsideGrantPaths(`See https://${outside} and https://example.com/x.`, [home])).toEqual([]);
  expect(await outsideGrantPaths(`Read ${outside}.`, [home, root])).toEqual([]);
});
