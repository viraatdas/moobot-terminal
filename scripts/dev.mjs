// Dev runner: starts the agent sidecar alongside Vite.
// Used as Tauri's beforeDevCommand via `pnpm dev`.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const sidecar = spawn("node", [path.join(root, "sidecar", "src", "index.ts")], {
  stdio: "inherit",
});

const vite = spawn("pnpm", ["exec", "vite"], { cwd: root, stdio: "inherit" });

function shutdown() {
  sidecar.kill("SIGTERM");
  vite.kill("SIGTERM");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
vite.on("close", shutdown);
