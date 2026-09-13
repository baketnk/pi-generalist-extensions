#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { BoardClient, bindingAt, ensureService } from "../lib/switchboard/client.ts";
import { paths, plain, projectAt, type Card, type Mail, type Snapshot } from "../lib/switchboard/shared.ts";

const argv = process.argv.slice(2);
if (!argv.length || argv.includes("--help")) {
  console.log("Usage: node tools/switchboard.ts list|watch|inspect ID_OR_HANDLE|inbox|read [ID]|ack ID|send ID_OR_HANDLE TEXT|reply ID TEXT|retry OP\nOptions: --project PATH --all --json --as human|observer (default observer for list/watch/inspect, human otherwise).\nStarts the per-user local helper if absent. No model calls; no implicit agent identity from the shell.");
} else {
  const take = (key: string) => { const index = argv.indexOf(key); if (index < 0) return; const value = argv[index + 1]; if (!value || value.startsWith("--")) throw new Error(`${key} needs a value.`); argv.splice(index, 2); return value; };
  const flag = (key: string) => { const index = argv.indexOf(key); if (index < 0) return false; argv.splice(index, 1); return true; };
  const projectPath = take("--project") ?? process.cwd(), as = take("--as"), all = flag("--all"), json = flag("--json");
  const [action, target, ...words] = argv;
  const type = as ?? (["list", "watch", "inspect"].includes(action!) ? "observer" : "human");
  if (!["human", "observer"].includes(type)) throw new Error("--as must be human or observer; cannot impersonate an agent.");
  if (!["list", "watch", "inspect", "inbox", "read", "ack", "send", "reply", "retry"].includes(action!)) throw new Error("Unknown action; use --help.");
  if (["list", "watch", "inbox"].includes(action!) ? !!target : (action !== "read" && !target) || (!["send", "reply"].includes(action!) && words.length > 0)) throw new Error("Invalid arguments; use --help.");
  const p = paths(), stop = new AbortController();
  process.once("SIGINT", () => stop.abort()); process.once("SIGTERM", () => stop.abort());
  await ensureService(p, stop.signal);
  // Observers need no stable mailbox; concurrent watchers do not contend for the human identity.
  const binding = await bindingAt(p, type === "human" ? "human-cli" : `observer:${randomUUID()}`);
  const client = new BoardClient(p, binding.binding.token);
  const project = await projectAt(projectPath);
  await client.connect({ ...project, name: type === "human" ? "human" : "observer", summary: "", activity: "idle" }, type as Card["type"], stop.signal);
  const beat = setInterval(() => void client.call("heartbeat", {}, stop.signal).catch(() => {}), 15_000); beat.unref();
  const print = (data: unknown) => {
    if (json) console.log(JSON.stringify(data));
    else if (data && typeof data === "object" && "peers" in data) {
      const s = data as Snapshot;
      console.log(`Registered agents: ${s.total} (showing ${s.peers.length})`);
      for (const c of s.peers) console.log(`${c.handle}  ${c.id}${c.name !== c.handle ? `  ${plain(c.name)}` : ""}  ${c.activity}  ${c.worktree === project.worktree ? "same checkout" : plain(c.worktree)}${c.parentId ? `  child of ${c.parentId}` : ""}${c.summary ? `  ${plain(c.summary)}` : ""}`);
    } else console.log(JSON.stringify(data, (_key, value) => typeof value === "string" ? plain(value) : value, 2));
  };
  try {
    if (action === "list" || action === "watch") {
      let since: string | undefined;
      do {
        const s = await client.call<Snapshot>(action === "watch" ? "watch" : "snapshot", { since, all }, stop.signal);
        if (s.version !== since) print(s); since = s.version;
      } while (action === "watch" && !stop.signal.aborted);
    } else if (action === "inbox") { const s = await client.snapshot(stop.signal); print({ pending: s.pending, messages: s.inbox }); }
    else if (["inspect", "read", "ack"].includes(action!)) print(await client.call(action!, { id: target }, stop.signal));
    else if (action === "retry") print(await client.retry(target!, stop.signal));
    else {
      if (!words.length) throw new Error("Message text is required.");
      const recipient = action === "send" ? target : (await client.call<Mail>("status", { id: target }, stop.signal)).sender;
      print(await client.send(`cli:${randomUUID()}`, { recipient, body: words.join(" "), kind: action === "reply" ? "reply" : "note", ...(action === "reply" ? { replyTo: target } : {}) }, stop.signal));
    }
  } catch (e) { if (!stop.signal.aborted) { console.error(plain(e instanceof Error ? e.message : "Switchboard error")); process.exitCode = 1; } }
  finally { clearInterval(beat); await client.call("detach", {}, AbortSignal.timeout(1500)).catch(() => {}); }
}
