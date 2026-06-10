# Moobot Terminal

A Mac trading terminal with an AI research desk. Trade through Robinhood, run
continuous research agents per topic, approve every trade yourself.

**https://mooterminal.viraat.dev**

## Install

```sh
brew install --cask viraatdas/tap/moobot-terminal
```

Requires Apple Silicon, [Claude Code](https://claude.com/claude-code) (the
research engine), and Node 22+. Connect the Robinhood MCP to Claude Code once
(`claude mcp add --transport http robinhood-trading https://agent.robinhood.com/mcp/trading`)
and the app picks up the credentials automatically.

## What it does

- **Trade from the terminal** — portfolio, positions, quotes, and an order
  ticket over Robinhood. Review first, then place.
- **Hyper research tabs** — drop a topic ("NVDA earnings setup", "uranium
  miners") and a headless Claude Code agent works it continuously: news, SEC
  filings, price action, social sentiment, maintained as a living thesis with
  a live activity feed.
- **Trade proposals, human trigger** — agents file proposals with thesis and
  confidence; nothing executes without your explicit approval. Agent trading
  uses Robinhood's agentic accounts (`agentic_allowed=true`).
- **Source plugins** — skill packs in
  `~/Library/Application Support/MoobotTerminal/plugins/` that extend agent
  instructions/tools and render data panels in the UI. Four built-ins:
  news-web, sec-edgar, market-data, social-sentiment. Drop in your own.

## Development

```sh
pnpm install && cd sidecar && pnpm install && cd ..
pnpm tauri dev     # app + sidecar + vite
pnpm tauri build   # release .app/.dmg
```

See `CLAUDE.md` for architecture.
