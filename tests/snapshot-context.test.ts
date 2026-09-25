import { expect, test } from "bun:test";
import { snapshotContext, type Snapshot } from "../lib/snapshot-context.ts";

const user = (content: string, timestamp: number) => ({ role: "user", content, timestamp }) as any;
const kinds = (messages: any[]) => messages.map(m => m.role === "custom" ? `S:${m.content}` : m.content);

test("snapshots stay at their original boundaries; later updates append", () => {
  const journal: Snapshot[] = [];
  const save = (s: Snapshot) => journal.push(s);
  const [a, b, c, d] = [user("A", 1), user("B", 2), user("C", 3), user("D", 4)];
  expect(kinds(snapshotContext([a, b], journal, "e", { key: "r1", content: "one" }, undefined, save))).toEqual(["A", "B", "S:Workpad state update. one"]);
  // Unchanged content is neither moved nor repeated on later requests.
  expect(kinds(snapshotContext([a, b, c, d], journal, "e", { key: "r1", content: "one" }, undefined, save)))
    .toEqual(["A", "B", "S:Workpad state update. one", "C", "D"]);
  // A changed key appends at the new end; the earlier snapshot keeps its place.
  expect(kinds(snapshotContext([a, b, c, d], journal, "e", { key: "r2", content: "two" }, undefined, save)))
    .toEqual(["A", "B", "S:Workpad state update. one", "C", "D", "S:Workpad state update. two"]);
  // Retries and reloads (same journal, fresh call) reproduce the identical projection.
  expect(kinds(snapshotContext([a, b, c, d], journal, "e", { key: "r2", content: "two" }, undefined, save)))
    .toEqual(["A", "B", "S:Workpad state update. one", "C", "D", "S:Workpad state update. two"]);
  expect(journal).toHaveLength(2);
});

test("external trimming abandons the projection and persists a reset", () => {
  const journal: Snapshot[] = [];
  const save = (s: Snapshot) => journal.push(s);
  const [a, b] = [user("A", 1), user("B", 2)];
  snapshotContext([a, b], journal, "e", { key: "r1", content: "one" }, undefined, save);
  const out = snapshotContext([b], journal, "e", { key: "r1", content: "one" }, undefined, save);
  expect(kinds(out)).toEqual(["B", "S:Workpad state update. one"]);
  expect(journal.at(-1)!.reset).toBe(true);
});
