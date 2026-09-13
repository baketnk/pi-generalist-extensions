import { serve } from "./server.ts";
import { recordDaemonEvent } from "./diagnostics.ts";

// Started under flock by the client, never imported by the Pi extension.
process.umask(0o077);
const [root, socket] = process.argv.slice(2);
if (!root || !socket) throw new Error("Expected state directory and socket path.");
const paths = { root, socket };
const board = await serve(paths, { staleSocket: true }).catch(async error => { await recordDaemonEvent(paths, "startup-failed"); throw error; });
await recordDaemonEvent(paths, "start");
let stopping = false;
async function stop(event: "SIGTERM" | "SIGINT" | "idle-stop") {
  if (stopping) return; stopping = true; clearInterval(idle);
  await recordDaemonEvent(paths, event);
  try { await board.close(); } catch { await recordDaemonEvent(paths, "stop-failed"); process.exitCode = 1; }
}
process.once("SIGTERM", () => void stop("SIGTERM")); process.once("SIGINT", () => void stop("SIGINT"));
// Independent of any Pi lifetime, but don't keep an unused helper around forever.
let lastActive = Date.now();
const idle = setInterval(() => {
  const live = board.store.one("SELECT count(*) AS n FROM participants WHERE lease>?", Date.now())!.n;
  if (live) lastActive = Date.now();
  if (Date.now() - lastActive > 5 * 60_000) void stop("idle-stop");
}, 30_000);
idle.unref();
