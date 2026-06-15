# Moobot Terminal

A native Mac (Apple Silicon) trading terminal: trade through Robinhood, run continuous
AI research agents per topic, approve every trade yourself. Landing page:
https://moobot.viraat.dev (also mooterminal.viraat.dev; source in `site/` - a
Vite + React + Tailwind v4 + framer-motion app, deployed on Vercel project
`mooterminal`; DNS via Netlify CNAME).

## Architecture

Three processes:

1. **Tauri shell** (`src-tauri/`) - Rust, window chrome only. In release builds it
   spawns the sidecar from bundled resources (`resources/sidecar.cjs`) via a login
   shell (so `node`/`claude` are on PATH) and kills it on exit. In dev,
   `scripts/dev.mjs` runs the sidecar instead.
2. **Agent sidecar** (`sidecar/`) - Node (run directly as TypeScript; Node 26 type
   stripping, so no enums/parameter-properties). WebSocket server on
   `127.0.0.1:4517`. Owns:
   - `robinhood.ts` - direct MCP client to `https://agent.robinhood.com/mcp/trading`
     with its own OAuth (dynamic client registration + PKCE, browser flow, local
     callback on port 45171). Tokens persist in
     `~/Library/Application Support/MoobotTerminal/rh-oauth.json`.
   - `research.ts` - research tabs. Each tab = a workspace dir under
     `~/Library/Application Support/MoobotTerminal/research/<id>/` and a looped
     headless Claude Code session (`claude -p --output-format stream-json`,
     `--resume <sessionId>` after the first run). The agent maintains `findings.md`
     (living doc), `state.json` (sentiment/conviction/headline), and may write trade
     proposal JSON files into `proposals/`.
   - `proposals.ts` - validates agent-written proposals into a queue. Proposals carry
     `stop`/`target`/`whyNow` and an `entryPrice` stamped from a live quote at ingest.
     `approve(id, account, overrides?)` is the ONLY code path that places orders
     (review_equity_order → place_equity_order with a fresh `ref_id`); the UI requires
     an explicit human click + confirm first and may pass `overrides`
     (edited quantity/type/limit). The agent's original proposal stays immutable; what
     was actually placed is recorded in `execution`. In paper mode it simulates instead.
   - `settings.ts` - persisted `settings.json` (`paperMode`, `eventTriggers`).
   - `decisions.ts` - append-only `decisions.jsonl` audit trail of every approve/reject.
   - `track-record.ts` - marks every proposal (acted or not) to live quotes for
     hit-rate / "if you'd followed all" P&L.
   - `triggers.ts` - `TriggerEngine` wakes lenses on material events (≥5% move from a
     rolling baseline, or a new 8-K/news filing) instead of only the timer. Matches
     symbols named in a lens's topic/notes (+ watchlist); `pulse` lenses wake on any
     event. Throttled per-lens; `research.run(id, reason)` injects the wake reason.
   - `backtest.ts` - the strategy DSL (operands/conditions/exit primitives) + a pure,
     no-lookahead portfolio backtester (orders decided on bar i fill at i+1 open;
     slippage/commission; in-sample/out-of-sample split; equity curve + drawdown/
     Sharpe/win-rate). `parseSpec` normalizes an agent-authored `strategy.json`.
     `options.selfCheck` runs `data-quality.ts` + `invariants.ts`, surfacing issues
     in the result's `warnings`.
   - `invariants.ts` / `data-quality.ts` - strategy VERIFICATION (layer 0/1). Invariants
     are cheap per-run sanity checks (finite equity, sign, pnl≤gross); the metamorphic
     ones that catch the short-sign-bug class (always-in == buy-and-hold to the penny,
     long/short mirror symmetry, zero-cost conservation) live in `sidecar/test/` and run
     via `pnpm test:engine`. `data-quality.ts` gates inputs FIRST (dividend/split-gap,
     NaN, zero-volume) — a fail voids trust. `market-data.ts` now returns dividend+split
     adjusted (total-return) OHLC, so backtests aren't poisoned by ex-div gaps.
   - `review-alerts.ts` - parses Robinhood's `review_equity_order` dry-run. `proposals.approve`
     HARD-blocks placement on halt/PDT/insufficient-buying-power alerts (the human already
     confirmed, but review runs server-side) and records alerts/quote into `execution`.
   - `verify.ts` / `trust-stats.ts` - strategy VERIFICATION battery (layer 2/3). `verifyStrategy`
     composes `runBacktest` (walk-forward, ±15% param sweep, 3x cost-stress, SPY baseline,
     exposure guard, Monte-Carlo permutation p — gated behind a 20-trade floor, Bonferroni-
     adjusted by variant count). Produces a 4-tier grade (`untested`/`fragile`/`holds-up`/
     `diverged`) keyed to `canonicalSpecHash(spec)` + a behavioral `engineHash()` (golden-
     backtest fingerprint, bundle-safe). `track-record.ts liveConsistency` reconciles realized
     fills vs the backtest win-rate (binomial CI) → `diverged`. Persisted to `verification.json`.
   - `prediction-markets.ts` - structured Polymarket (gamma) + Kalshi odds for lenses;
     WS `markets.predictions` + loopback `/predictions?q=` (agents curl it for event probabilities).
   - `strategy-runtime.ts` - evaluates LIVE `strategy` lenses each interval with the
     SAME rule evaluator, files proposals on rule triggers, and runs an optional
     live-only LLM gate (short `claude -p` call, WebSearch-allowed) that can veto a
     signal before it becomes a proposal. The gate is the only place model judgment
     enters and is excluded from the backtest (hindsight cannot leak into the curve).
     A `strategy` lens authors `strategy.json`/`strategy.md`; the runtime executes it.
3. **React UI** (`src/`) - Vite + React 19 + Tailwind v4. Talks to the sidecar over
   WS (`src/lib/client.ts`). Three panes: portfolio/positions, research tabs with
   live agent activity feed, proposals + manual order ticket. `SymbolChart` and
   `PortfolioPerformanceModal` support hover crosshair + drag-to-select range diff.
   `TitleBar` has paper/live and event-trigger toggles + a track-record modal.

## Safety invariants (do not weaken)

- Research agents get an explicit `--allowedTools` whitelist (web, files, read-only
  Robinhood data) and `--disallowedTools` on order placement/cancel/review.
- `rh.call` over WS rejects all MCP `place_*_order`/`cancel_*_order` tools; orders
  go only through `proposals.approve` or the manual ticket's `trade.place` with
  `confirmed: true`.
- Paper mode (`settings.paperMode`) must short-circuit BOTH order paths
  (`proposals.approve` and `trade.place`) so nothing reaches the broker when on.
- Live strategies NEVER auto-trade: `strategy-runtime.ts` only writes proposal JSON
  + `proposals.ingest`, landing in the same pending queue that requires a human
  approve. The LLM gate can only VETO a signal, never place an order.
- Real-money go-live is HARD-gated: `strategy.setLive` (with paper OFF) rejects unless a
  non-stale, data-clean, `holds-up`, non-`diverged` `verification.json` exists. `strategy.save`
  can NEVER flip `live` (only `setLive` can); switching paper→real stands down every live
  strategy. The runtime blocks only ENTRIES on unverified/diverged real-money rules — EXITS
  always fire so a held position is never stranded. Paper mode is exempt (it never hits the broker).
- Robinhood order args: `type` (not `order_type`), string `quantity`/`limit_price`,
  `ref_id` UUID for idempotency, `account_number` required.

## Commands

- `pnpm test:engine` - zero-dep `node:test` suite for the backtest engine + data
  quality (`sidecar/test/*.test.ts`); the metamorphic tests go RED if the short
  sign-bug class is reintroduced. Run before trusting any backtest change.
- `pnpm tauri dev` - full dev app (starts sidecar + vite via `scripts/dev.mjs`)
- `pnpm sidecar` - sidecar alone (ws://127.0.0.1:4517)
- `pnpm build` - typecheck + UI build; `pnpm build:sidecar` - bundle sidecar to
  `src-tauri/resources/sidecar.cjs` (gitignored, required before `tauri build`)
- `pnpm tauri build` - release .app/.dmg (runs `build:bundle`)

## Distribution

Homebrew cask `viraatdas/tap/moobot-terminal` pointing at GitHub release DMGs.
Release DMGs are Developer ID signed, notarized, and stapled. Use
`pnpm release:mac` with the `moobot-terminal` notarytool Keychain profile to
produce a Gatekeeper-clean DMG before updating the cask checksum.
