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
Use WebSearch for breaking news and analyst commentary on the topic; WebFetch promising articles.
Prioritize primary sources and dated reporting over aggregators. Always note the publication date —
stale news misleads. Track: catalysts, guidance changes, analyst revisions, sector reads.
Panel: maintain ./panels/news-web.json with the 3-5 most market-relevant headlines as
[{"label": "<source · date>", "value": "<headline>", "url": "<link>", "tone": "pos"|"neg"|"neutral"}].`,
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
Full-text search: https://efts.sec.gov/LATEST/search-index?q=%22<query>%22&dateRange=custom (or use
https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=<name>&type=<form>&dateb=&owner=include&count=10).
JSON API: https://data.sec.gov/submissions/CIK##########.json (10-digit zero-padded CIK) lists recent
filings. Watch: 8-K (material events), 10-Q/10-K (fundamentals), Form 4 (insider buys/sells — cluster
buys are a strong signal), 13F/13D (institutional position changes). Send a User-Agent header on
curl requests (SEC requires it). Panel: maintain ./panels/sec-edgar.json with notable recent filings as
[{"label": "<form> · <date>", "value": "<what it says, one line>", "url": "<filing link>"}].`,
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
lookup (search). Compare price to your prior run's level — note moves >2% and volume context if
available. Panel: maintain ./panels/market-data.json with the key tickers as
[{"label": "<SYMBOL>", "value": "<price>", "detail": "<change vs last run / level that matters>",
"tone": "pos"|"neg"|"neutral"}].`,
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
coverage of the chatter. Sentiment is noisy and contrarian at extremes — euphoric retail tops, capitulation
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
      if (fs.existsSync(path.join(dir, "plugin.json"))) continue;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(b.manifest, null, 2));
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
    return `\n\nSOURCE PLUGINS — use these on every run where relevant:\n${sections}\n\nPanels: write each panel file as a JSON array into ./panels/ (create the directory if needed). Keep panels current — they render directly in the terminal UI.`;
  }

  /** Extra --allowedTools entries from enabled plugins. */
  extraAllowedTools(): string[] {
    return [...new Set(this.enabled().flatMap((p) => p.allowedTools))];
  }
}
