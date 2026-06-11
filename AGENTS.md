# Moobot Terminal

A native Mac (Apple Silicon) trading terminal: trade through Robinhood, run continuous
AI research agents per topic, approve every trade yourself. Landing page:
https://moobot.viraat.dev (also mooterminal.viraat.dev; source in `site/` — a
Vite + React + Tailwind v4 + framer-motion app, deployed on Vercel project
`mooterminal`; DNS via Netlify CNAME).

## Architecture

Three processes:

1. **Tauri shell** (`src-tauri/`) — Rust, window chrome only. In release builds it
   spawns the sidecar from bundled resources (`resources/sidecar.cjs`) via a login
   shell (so `node`/`Codex` are on PATH) and kills it on exit. In dev,
   `scripts/dev.mjs` runs the sidecar instead.
2. **Agent sidecar** (`sidecar/`) — Node (run directly as TypeScript; Node 26 type
   stripping, so no enums/parameter-properties). WebSocket server on
   `127.0.0.1:4517`. Owns:
   - `robinhood.ts` — direct MCP client to `https://agent.robinhood.com/mcp/trading`
     with its own OAuth (dynamic client registration + PKCE, browser flow, local
     callback on port 45171). Tokens persist in
     `~/Library/Application Support/MoobotTerminal/rh-oauth.json`.
   - `research.ts` — research tabs. Each tab = a workspace dir under
     `~/Library/Application Support/MoobotTerminal/research/<id>/` and a looped
     headless Claude Code session (`claude -p --output-format stream-json`,
     `--resume <sessionId>` after the first run). The agent maintains `findings.md`
     (living doc), `state.json` (sentiment/conviction/headline), and may write trade
     proposal JSON files into `proposals/`.
   - `proposals.ts` — validates agent-written proposals into a queue. `approve()` is
     the ONLY code path that places orders (review_equity_order →
     place_equity_order with a fresh `ref_id`), and the UI requires an explicit
     human click + confirm first.
3. **React UI** (`src/`) — Vite + React 19 + Tailwind v4. Talks to the sidecar over
   WS (`src/lib/client.ts`). Three panes: portfolio/positions, research tabs with
   live agent activity feed, proposals + manual order ticket.

## Safety invariants (do not weaken)

- Research agents get an explicit `--allowedTools` whitelist (web, files, read-only
  Robinhood data) and `--disallowedTools` on order placement/cancel/review.
- `rh.call` over WS rejects `place_equity_order`/`cancel_equity_order`; orders go
  only through `proposals.approve` or the manual ticket's `trade.place` with
  `confirmed: true`.
- Robinhood order args: `type` (not `order_type`), string `quantity`/`limit_price`,
  `ref_id` UUID for idempotency, `account_number` required.

## Commands

- `pnpm tauri dev` — full dev app (starts sidecar + vite via `scripts/dev.mjs`)
- `pnpm sidecar` — sidecar alone (ws://127.0.0.1:4517)
- `pnpm build` — typecheck + UI build; `pnpm build:sidecar` — bundle sidecar to
  `src-tauri/resources/sidecar.cjs` (gitignored, required before `tauri build`)
- `pnpm tauri build` — release .app/.dmg (runs `build:bundle`)

## Distribution

Homebrew cask `viraatdas/tap/moobot-terminal` pointing at GitHub release DMGs.
Release DMGs are Developer ID signed, notarized, and stapled. Use
`pnpm release:mac` with the `moobot-terminal` notarytool Keychain profile to
produce a Gatekeeper-clean DMG before updating the cask checksum.
