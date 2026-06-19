// Dev runner: starts the agent sidecar alongside Vite.
// Used as Tauri's beforeDevCommand via `pnpm dev`.
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIDECAR_PORT = 4517;

// If a sidecar is already listening (e.g. the persistent launchd service that keeps the
// auto-trader running while the app window opens and closes), USE it instead of spawning
// a duplicate — and never kill it on app exit. Otherwise spawn our own dev sidecar.
function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.on("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
    s.setTimeout(500, () => {
      s.destroy();
      resolve(false);
    });
  });
}

const sidecarRunning = await portInUse(SIDECAR_PORT);
let sidecar = null;
if (sidecarRunning) {
  console.log(`[dev] sidecar already running on :${SIDECAR_PORT} — using it (persistent service)`);
} else {
  sidecar = spawn("node", [path.join(root, "sidecar", "src", "index.ts")], {
    stdio: "inherit",
  });
}

const vite = spawn("pnpm", ["exec", "vite"], { cwd: root, stdio: "inherit" });

function shutdown() {
  if (sidecar) sidecar.kill("SIGTERM"); // only kill the sidecar WE spawned
  vite.kill("SIGTERM");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
vite.on("close", shutdown);
