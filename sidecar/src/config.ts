import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const DATA_DIR = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "MoobotTerminal",
);
export const RESEARCH_DIR = path.join(DATA_DIR, "research");
export const PROPOSALS_FILE = path.join(DATA_DIR, "proposals.json");
export const RH_AUTH_FILE = path.join(DATA_DIR, "rh-oauth.json");

export const WS_PORT = 4517;
export const OAUTH_CALLBACK_PORT = 45171;

export const RH_MCP_URL = "https://agent.robinhood.com/mcp/trading";

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
  "mcp__robinhood-trading__get_popular_lists",
];

export const RESEARCH_DISALLOWED_TOOLS = [
  "mcp__robinhood-trading__place_equity_order",
  "mcp__robinhood-trading__cancel_equity_order",
  "mcp__robinhood-trading__review_equity_order",
];

export function ensureDirs() {
  fs.mkdirSync(RESEARCH_DIR, { recursive: true });
}
