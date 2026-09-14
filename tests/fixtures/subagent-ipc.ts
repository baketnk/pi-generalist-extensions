import { readFile } from "node:fs/promises";
const launch = JSON.parse(await readFile(process.argv[2]!, "utf8"));
const send = (packet: unknown) => process.send!({ version: 1, ...packet as object });
send({ type: "ready", sessionFile: "/synthetic/session.jsonl" });
send({ type: "event", event: { seq: 1, at: Date.now(), kind: "progress", text: "Synthetic worker is inspecting." } });
const finish = () => { send({ type: "terminal", state: "reported", report: { outcome: "completed", summary: "Synthetic result", verification: "Fixture only; not a live investigation." } }); process.disconnect(); };
process.on("message", (packet: { type: string }) => {
  if (packet.type === "input") finish();
  if (packet.type === "cancel" && launch.task !== "ignore") process.exit(0);
});
process.on("disconnect", () => process.exit(0));
if (launch.task === "ignore") process.on("SIGTERM", () => {});
if (launch.task === "report") setTimeout(finish, 40);
else if (launch.task === "block") send({ type: "needs-input", id: "question-1", text: "Which scope?" });
else if (launch.task === "crash") process.exit(7);
