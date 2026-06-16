# Moobot Terminal

A Mac trading terminal with an AI research desk. Trade through Robinhood, run
continuous research agents per topic, approve every trade yourself.

**https://mooterminal.viraat.dev**

## Install

```sh
brew install --cask viraatdas/tap/moobot-terminal
```

Requires Apple Silicon, [Claude Code](https://claude.com/claude-code) or
[Codex](https://developers.openai.com/codex), and Node 22+. Connect Robinhood
from the app: Moobot uses Robinhood's trading MCP OAuth directly, stores tokens
locally in macOS Application Support, and can also import an existing Claude
Code Robinhood MCP login. There is no `rh_auth`/web-token setup.

## What it does

- **Trade from the terminal** - portfolio, positions, quotes, and an order
  ticket over Robinhood MCP. View the main/default account; approved orders
  route only through Robinhood's agentic trading account.
- **Hyper research tabs** - drop a topic ("NVDA earnings setup", "uranium
  miners") and a headless Claude Code or Codex agent works it continuously:
  news, SEC filings, price action, social sentiment, maintained as a living
  thesis with a live activity feed. The top-right engine switch applies only to
  newly-created tabs; existing tabs keep the engine they started with.
- **Trade proposals, human trigger** - agents file proposals with thesis and
  confidence; nothing executes without your explicit approval. Agent trading
  uses Robinhood's agentic accounts (`agentic_allowed=true`).
- **Source plugins** - skill packs in
  `~/Library/Application Support/MoobotTerminal/plugins/` that extend agent
  instructions/tools and render data panels in the UI. Four built-ins:
  news-web, sec-edgar, market-data, social-sentiment. Drop in your own.

## Development

```sh
pnpm install && cd sidecar && pnpm install && cd ..
pnpm tauri dev     # app + sidecar + vite
pnpm tauri build   # release .app/.dmg
```

Release DMGs are Developer ID signed, notarized, and stapled with
`pnpm release:mac`; update the Homebrew cask checksum from that notarized DMG.

See `CLAUDE.md` for architecture.
