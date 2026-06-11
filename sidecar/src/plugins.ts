import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.ts";

export const PLUGINS_DIR = path.join(DATA_DIR, "plugins");

/**
 * Plugins are skill packs for the research desk. Each is a directory:
 *
 *   plugins/<name>/plugin.json     manifest (below)
 *   plugins/<name>/instructions.md prompt fragment injected into research agents
 *
 * Manifest shape:
 *   {
 *     "name": "sec-edgar",
 *     "title": "SEC EDGAR",
 *     "description": "...",
 *     "enabled": true,
 *     "allowedTools": ["Bash(curl:*)"],      // extra claude --allowedTools entries
 *     "panel": { "title": "Filings" }         // optional: agent writes
 *   }                                          // panels/<name>.json in its workspace,
 *                                              // the UI renders it as a data card.
 *
 * Panel data contract (written by agents): a JSON array of
 *   { "label": str, "value": str, "detail"?: str, "url"?: str, "tone"?: "pos"|"neg"|"neutral" }
 */
export interface PluginManifest {
  name: string;
  title: string;
  description: string;
  enabled: boolean;
  allowedTools: string[];
  panel?: { title: string };
}

export interface LoadedPlugin extends PluginManifest {
  instructions: string;
}

const BUILTINS: Array<{ manifest: PluginManifest; instructions: string }> = [
  {
    manifest: {
      name: "news-web",
      title: "News & Web",
      description: "Headlines and general web research",
      enabled: true,
      allowedTools: ["WebSearch", "WebFetch"],
      panel: { title: "Headlines" },
    },
    instructions: `## News & Web
Use WebSearch for breaking news, analyst commentary, IR pages, exchange notices, and primary-source
company updates on the topic; WebFetch promising sources before relying on them. Prioritize primary
sources, named publications, and dated reporting over aggregators. Always note publication time/date
and ignore stale articles unless the stale context still matters. Track: catalysts, guidance changes,
analyst revisions, sector reads, regulatory events, and market-wide tape that directly affects the
user's held symbols.
Panel: maintain ./panels/news-web.json with the 3-5 most market-relevant headlines as
[{"label": "<source · date>", "value": "<headline>", "url": "<link>", "tone": "pos"|"neg"|"neutral"}].
Every headline must include a working URL and a one-line reason it matters in the main findings/lens output.`,
  },
  {
    manifest: {
      name: "sec-edgar",
      title: "SEC EDGAR",
      description: "Filings, insider transactions, institutional holdings",
      enabled: true,
      allowedTools: ["WebFetch", "Bash(curl:*)"],
      panel: { title: "Filings" },
    },
    instructions: `## SEC EDGAR
Use SEC sources whenever a company-specific claim could be checked in filings. SEC requires a
descriptive User-Agent; use curl like:
curl -s -H 'User-Agent: MoobotTerminal/0.1 moobot@viraat.dev' '<url>'

Useful endpoints:
- Company ticker map: https://www.sec.gov/files/company_tickers.json
- Submissions JSON: https://data.sec.gov/submissions/CIK##########.json (10-digit zero-padded CIK)
- Company facts JSON: https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json
- Filing search: https://efts.sec.gov/LATEST/search-index?q=%22<query>%22&dateRange=custom
- Browser fallback: https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=<ticker-or-cik>&owner=include&count=20

Watch: 8-K (material events), 10-Q/10-K (fundamentals/risk factors), Form 4 (insider buys/sells;
clusters matter more than one-offs), 13F/13D/13G (institutional and activist changes), S-1/F-1
(new issuance), 424B (offerings). Prefer filing detail pages or accession URLs as final sources,
not just the search result page.
Panel: maintain ./panels/sec-edgar.json with notable recent filings as
[{"label": "<form> · <date>", "value": "<what it says, one line>", "url": "<filing link>", "tone": "pos"|"neg"|"neutral"}].`,
  },
  {
    manifest: {
      name: "market-data",
      title: "Market Data",
      description: "Quotes and price action via Robinhood",
      enabled: true,
      allowedTools: [
        "mcp__robinhood-trading__get_equity_quotes",
        "mcp__robinhood-trading__search",
        "mcp__robinhood-trading__get_equity_tradability",
      ],
      panel: { title: "Tape" },
    },
    instructions: `## Market Data
Use the Robinhood tools for real-time quotes (get_equity_quotes takes a symbols array) and symbol
lookup (search). Compare price to your prior run's level - note moves >2% and volume context if
available. Panel: maintain ./panels/market-data.json with the key tickers as
[{"label": "<SYMBOL>", "value": "<price>", "detail": "<change vs last run / level that matters>",
"tone": "pos"|"neg"|"neutral"}].`,
  },
  {
    manifest: {
      name: "options",
      title: "Options",
      description: "Live option chains (strikes, greeks, IV) via Robinhood MCP",
      enabled: true,
      allowedTools: ["Bash(curl:*)"],
      panel: { title: "Options" },
    },
    instructions: `## Options chains
Moobot Terminal exposes a local read-only API on http://127.0.0.1:4517 for live option data
(backed by the user's Robinhood MCP connection). No extra auth needed; loopback only.
- Expirations: \`curl -s "http://127.0.0.1:4517/chain?symbol=AAPL"\` → {symbol, expirations[]}
- One expiry's strikes: \`curl -s "http://127.0.0.1:4517/chain?symbol=AAPL&expiration=2026-07-17"\`
  → contracts[] each {strike, optionType, bid, ask, mark, delta, gamma, theta, vega, iv,
  openInterest, volume}.
- Held positions (all accounts): \`curl -s "http://127.0.0.1:4517/positions"\`.
Use these to analyze setups: ATM/OTM strikes, IV level vs history, delta for directional
exposure, OI/volume for liquidity. If the API returns {"error": ...} the user hasn't
connected Robinhood yet - note that and fall back to equity analysis.
Panel: maintain ./panels/options.json with notable contracts as
[{"label": "<SYM strike C/P exp>", "value": "<mark>", "detail": "<delta/IV/OI>"}].`,
  },
  {
    manifest: {
      name: "social-sentiment",
      title: "Social Sentiment",
      description: "Reddit and X chatter",
      enabled: true,
      allowedTools: ["WebSearch", "WebFetch", "Bash(curl:*)"],
      panel: { title: "Sentiment" },
    },
    instructions: `## Social Sentiment
Reddit JSON API needs no auth: https://www.reddit.com/r/wallstreetbets/search.json?q=<ticker>&sort=new&restrict_sr=1&limit=10
(also r/stocks, r/investing; send a User-Agent header). For X, use WebSearch with site:x.com or news
coverage of the chatter. Sentiment is noisy and contrarian at extremes - euphoric retail tops, capitulation
bottoms. Weight volume-of-mentions changes over absolute counts. Panel: maintain
./panels/social-sentiment.json as [{"label": "<venue>", "value": "<read in one line>",
"tone": "pos"|"neg"|"neutral"}].`,
  },
];

export class PluginManager {
  private plugins: LoadedPlugin[] = [];

  constructor() {
    this.ensureBuiltins();
    this.loadAll();
  }

  private ensureBuiltins() {
    for (const b of BUILTINS) {
      const dir = path.join(PLUGINS_DIR, b.manifest.name);
      const manifestPath = path.join(dir, "plugin.json");
      fs.mkdirSync(dir, { recursive: true });
      let enabled = b.manifest.enabled;
      try {
        const existing = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as PluginManifest;
        enabled = existing.enabled;
      } catch {}
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({ ...b.manifest, enabled }, null, 2),
      );
      fs.writeFileSync(path.join(dir, "instructions.md"), b.instructions);
    }
  }

  private loadAll() {
    this.plugins = [];
    if (!fs.existsSync(PLUGINS_DIR)) return;
    for (const entry of fs.readdirSync(PLUGINS_DIR)) {
      try {
        const dir = path.join(PLUGINS_DIR, entry);
        const manifest = JSON.parse(
          fs.readFileSync(path.join(dir, "plugin.json"), "utf8"),
        ) as PluginManifest;
        let instructions = "";
        try {
          instructions = fs.readFileSync(path.join(dir, "instructions.md"), "utf8");
        } catch {}
        this.plugins.push({ ...manifest, instructions });
      } catch {
        // not a plugin dir
      }
    }
  }

  reload() {
    this.loadAll();
  }

  list(): PluginManifest[] {
    return this.plugins.map(({ instructions: _i, ...m }) => m);
  }

  enabled(): LoadedPlugin[] {
    return this.plugins.filter((p) => p.enabled);
  }

  setEnabled(name: string, enabled: boolean) {
    const p = this.plugins.find((x) => x.name === name);
    if (!p) throw new Error(`No plugin ${name}`);
    p.enabled = enabled;
    const { instructions: _i, ...manifest } = p;
    fs.writeFileSync(
      path.join(PLUGINS_DIR, name, "plugin.json"),
      JSON.stringify(manifest, null, 2),
    );
  }

  /** Prompt fragment for research agents: all enabled plugin instructions + panel contract. */
  promptFragment(): string {
    const enabled = this.enabled();
    if (enabled.length === 0) return "";
    const sections = enabled.map((p) => p.instructions.trim()).join("\n\n");
    return `\n\nSOURCE PLUGINS - use these on every run where relevant:\n${sections}\n\nPanels: write each panel file as a JSON array into ./panels/ (create the directory if needed). Keep panels current - they render directly in the terminal UI.`;
  }

  /** Extra --allowedTools entries from enabled plugins. */
  extraAllowedTools(): string[] {
    return [...new Set(this.enabled().flatMap((p) => p.allowedTools))];
  }
}
