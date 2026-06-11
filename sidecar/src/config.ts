import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// On the desktop app this is macOS Application Support; on the cloud sidecar
// set MOOBOT_DATA_DIR to a mounted volume so tabs/findings survive restarts.
export const DATA_DIR =
  process.env.MOOBOT_DATA_DIR ||
  path.join(os.homedir(), "Library", "Application Support", "MoobotTerminal");
export const RESEARCH_DIR = path.join(DATA_DIR, "research");
export const PROPOSALS_FILE = path.join(DATA_DIR, "proposals.json");
export const RH_AUTH_FILE = path.join(DATA_DIR, "rh-oauth.json");

export const WS_PORT = Number(process.env.MOOBOT_PORT) || 4517;
export const OAUTH_CALLBACK_PORT = 45171;

// Server mode: bind a public interface and require a shared-secret token on
// every WS/HTTP connection. Set automatically when MOOBOT_TOKEN is present.
export const SERVER_TOKEN = process.env.MOOBOT_TOKEN || null;
export const BIND_HOST = SERVER_TOKEN ? "0.0.0.0" : "127.0.0.1";

export const RH_MCP_URL = "https://agent.robinhood.com/mcp/trading";

// Optional email notifications. Never hardcode secrets; set these in the app
// launch environment or cloud sidecar env.
export const RESEND_API_KEY = process.env.RESEND_API_KEY || null;
export const NOTIFY_EMAIL_TO =
  process.env.MOOBOT_NOTIFY_EMAIL || process.env.MOOBOT_ALERT_EMAIL || null;
export const NOTIFY_EMAIL_FROM =
  process.env.MOOBOT_NOTIFY_FROM || "Moobot Terminal <onboarding@resend.dev>";

// Model the lens agents run on. Pinned so it can't silently drift to the
// Claude Code default (or a fallback like Sonnet under load). Override per
// deployment with MOOBOT_LENS_MODEL.
export const LENS_MODEL = process.env.MOOBOT_LENS_MODEL || "claude-opus-4-8";
export const CODEX_MODEL = process.env.MOOBOT_CODEX_MODEL || null;

/** Robinhood tools research agents may call. Order placement is deliberately absent. */
export const RESEARCH_ALLOWED_TOOLS = [
  "WebSearch",
  "WebFetch",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash(curl:*)",
  "mcp__robinhood-trading__search",
  "mcp__robinhood-trading__get_equity_quotes",
  "mcp__robinhood-trading__get_equity_tradability",
  "mcp__robinhood-trading__get_portfolio",
  "mcp__robinhood-trading__get_equity_positions",
  "mcp__robinhood-trading__get_option_chains",
  "mcp__robinhood-trading__get_option_instruments",
  "mcp__robinhood-trading__get_option_positions",
  "mcp__robinhood-trading__get_option_quotes",
  "mcp__robinhood-trading__get_popular_lists",
];

export const RESEARCH_DISALLOWED_TOOLS = [
  "mcp__robinhood-trading__place_equity_order",
  "mcp__robinhood-trading__cancel_equity_order",
  "mcp__robinhood-trading__review_equity_order",
  "mcp__robinhood-trading__place_option_order",
  "mcp__robinhood-trading__cancel_option_order",
  "mcp__robinhood-trading__review_option_order",
];

export function ensureDirs() {
  fs.mkdirSync(RESEARCH_DIR, { recursive: true });
}
