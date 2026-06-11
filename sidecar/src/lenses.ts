// Lens registry. Every tab in Moobot Terminal is a "lens": a headless claude
// loop that writes structured JSON/markdown into its workspace, which a typed
// surface in the UI renders. This module defines, per lens type, the prompt the
// agent runs and any extra tools it needs.
//
// All lenses share the same runner (research.ts). Only the prompt and the
// expected output files differ.

export type LensType =
  | "research"
  | "pulse"
  | "scout"
  | "thesis"
  | "exposure"
  | "lattice"
  | "trade";

export interface LensTab {
  id: string;
  type: LensType;
  /** Renameable title shown on the tab. */
  topic: string;
  notes: string;
  /** Other tab ids this lens references (used by the trade lens via @mentions). */
  refs: string[];
  intervalMinutes: number; // 0 = manual only
  paused: boolean;
  createdAt: string;
  lastRunAt: string | null;
  lastRunStatus: "idle" | "running" | "ok" | "error";
  lastError: string | null;
  sessionId: string | null;
  runCount: number;
}

// The local data API (sidecar HTTP) every market-aware lens can curl.
const DATA_API = `Moobot Terminal exposes a local read-only API on http://127.0.0.1:4517 (loopback, no auth):
- Your holdings (all accounts): curl -s "http://127.0.0.1:4517/positions" → {equities[],options[],crypto[]} each with symbol, quantity, value, unrealizedPnl, and (options) strike/expiration/delta/iv.
- Option chain: curl -s "http://127.0.0.1:4517/chain?symbol=SPY" then ...&expiration=YYYY-MM-DD.
This API is backed by the user's Robinhood MCP connection. If it returns {"error":...}, the user hasn't connected Robinhood yet; note that and use web research until they connect.`;

const PROPOSAL_CONTRACT = `If (and only if) the evidence materially supports a trade, write ./proposals/<slug>.json: {"symbol","side":"buy"|"sell","quantity":<num>,"orderType":"market"|"limit","limitPrice":<num|null>,"thesis":"<3-5 sentences citing evidence>","confidence":1-10,"timeHorizon":"<e.g. 2 weeks>"}. You cannot place orders; a human approves every proposal. Most runs produce none.`;

export interface LensDef {
  label: string;
  /** Extra --allowedTools entries beyond the shared research set. */
  extraTools: string[];
  firstPrompt: (tab: LensTab, refContext: string) => string;
  loopPrompt: (tab: LensTab, refContext: string) => string;
}

export const LENSES: Record<LensType, LensDef> = {
  research: {
    label: "Research",
    extraTools: [],
    firstPrompt: (tab) => `You are a research analyst inside Moobot Terminal. Your working directory is your workspace for this topic.

RESEARCH TOPIC: ${tab.topic}
${tab.notes ? `OPERATOR NOTES: ${tab.notes}` : ""}

Every run:
1. Research using web search/fetch (news, SEC EDGAR, IR pages) and Robinhood market-data tools.
2. Maintain ./findings.md as a LIVING DOCUMENT (rewrite, don't append): "## Thesis", "## Key Signals" (dated, newest first), "## Risks", "## Watch Next". Keep under ~200 lines.
3. Maintain ./state.json: {"sentiment":"bullish"|"bearish"|"neutral","conviction":1-10,"headline":"<one-line take>","updatedAt":"<iso>"}.
4. ${PROPOSAL_CONTRACT}

Be concrete: numbers, dates, filings, price levels. Do the first pass now.`,
    loopPrompt: (tab) => `New research iteration on "${tab.topic}". What changed since last run (news, filings, price action)? Update ./findings.md and ./state.json. Write a proposal only if evidence now supports a trade.`,
  },

  pulse: {
    label: "Pulse",
    extraTools: ["Bash(curl:*)"],
    firstPrompt: (tab) => `You are the PULSE lens inside Moobot Terminal — the live heartbeat of the user's book and market. Fast and broad, not deep.

FOCUS: ${tab.topic || "the user's whole portfolio + the broad market"}
${tab.notes ? `NOTES: ${tab.notes}` : ""}

${DATA_API}

Every run:
1. Pull the user's holdings from the local API. Scan for what is MOVING right now and what just happened that MATTERS TO THIS BOOK — price moves in held names, options going ITM/near expiry, sector/market moves, breaking headlines on held or watched symbols.
2. Maintain ./pulse.json: a JSON array (newest first, max 30 items) of:
   {"ts":"<iso>","headline":"<short, punchy>","detail":"<one line: what + why it matters to this book>","impact":1-10,"symbols":["..."],"direction":"up"|"down"|"neutral"}.
   Rewrite the file each run: refresh/prune stale items, add new ones. Impact = how much it affects THIS user's positions (10 = major P&L mover).
Be specific and current. No filler. Do the first pulse scan now.`,
    loopPrompt: () => `New pulse scan. Re-pull holdings, re-check what's moving and what just happened that matters to this book. Update ./pulse.json (newest first, prune stale, max 30).`,
  },

  scout: {
    label: "Scout",
    extraTools: ["Bash(curl:*)"],
    firstPrompt: (tab) => `You are the SCOUT lens inside Moobot Terminal — proactive discovery. The user is NOT giving you a topic to research; you BRING them new trade ideas that fit their style and current book.

STYLE / MANDATE: ${tab.topic || "find high-conviction setups that fit how this user already trades"}
${tab.notes ? `NOTES: ${tab.notes}` : ""}

${DATA_API}

Every run:
1. Pull the user's holdings to understand their style, sectors, and risk appetite. Then hunt for NEW opportunities (not already held): catalysts, unusual options activity, technical setups, dislocations, themes adjacent to what they own.
2. Maintain ./scout.json: array (max 12) of {"symbol","setup":"<the pattern/catalyst>","thesis":"<why now, 2-3 sentences>","confidence":1-10,"timeHorizon":"<e.g. 3 weeks>","direction":"long"|"short"}.
3. ${PROPOSAL_CONTRACT}
Quality over quantity. Do the first scout pass now.`,
    loopPrompt: () => `New scout pass. Re-check the book, surface fresh candidates, drop stale ones. Update ./scout.json. File a proposal for any candidate that's clearly actionable now.`,
  },

  thesis: {
    label: "Thesis",
    extraTools: ["Bash(curl:*)"],
    firstPrompt: (tab) => `You are the THESIS lens inside Moobot Terminal. The user has a market belief — a hypothesis about the world — and your job is threefold: (1) judge whether their CURRENT book actually expresses that belief, (2) source real evidence for AND against it online, and (3) bring them specific NEW tickers that would express it, that they don't already own.

THE USER'S THESIS: ${tab.topic}
${tab.notes ? `OPERATOR NOTES / NUANCE: ${tab.notes}` : ""}

${DATA_API}

Every run:
1. Restate the thesis crisply and name the directional bet it implies (e.g. "long AI power/cooling infrastructure; short legacy datacenter").
2. Pull the user's holdings from the local API. For EACH meaningful position, judge whether it SUPPORTS, CONTRADICTS, or is NEUTRAL to the thesis, with a one-line reason. This is the core question: does the book back the belief, or is the belief unexpressed / contradicted?
3. Research the thesis online with web search/fetch (news, filings, primary sources). Collect concrete evidence BOTH supporting and contradicting it — every evidence item MUST carry a real source {title,url}. Be honest about disconfirming evidence; a thesis lens that only finds support is useless.
4. Find NEW tickers (NOT already held) that cleanly express the thesis — equities or, where it fits, the underlying for options. For each: direction, a 2-3 sentence rationale tied to the thesis, a confidence 1-10, and at least one source.
5. Score overall ALIGNMENT 0-100: how much of the user's actual book already expresses this thesis (dollar-weighted). 0 = book ignores/contradicts the thesis, 100 = book is a pure expression of it.

Maintain ./thesis.json (rewrite each run, don't append):
{"updatedAt":"<iso>",
 "thesis":"<crisp restatement>",
 "stance":"<the directional bet in one line>",
 "verdict":{"alignment":<0-100>,"summary":"<one line: does the book back the thesis?>"},
 "holdings":[{"symbol":"<TICKER>","kind":"equity"|"option"|"crypto","value":<$ exposure>,"fit":"supports"|"contradicts"|"neutral","reason":"<one line>"}],
 "ideas":[{"symbol":"<TICKER>","name":"<company/asset>","direction":"long"|"short","rationale":"<2-3 sentences>","confidence":<1-10>,"sources":[{"title":"...","url":"..."}]}],
 "evidence":[{"claim":"<finding>","stance":"supports"|"contradicts","source":{"title":"...","url":"..."}}],
 "gaps":"<one line: what would falsify this, or what's missing to be sure>"}

6. ${PROPOSAL_CONTRACT} (Here, a proposal closes the gap between the book and the thesis — only when the evidence and the user's intent clearly justify it.)

Be concrete and current. Cite real sources. Do the first thesis pass now.`,
    loopPrompt: (tab) => `New pass on the thesis "${tab.topic}". Re-pull the book, re-score each holding's fit, refresh online evidence (what changed — news, filings, price action?), and update the NEW-ticker ideas. Rewrite ./thesis.json. Add a proposal only if the evidence now clearly justifies acting to express the thesis.`,
  },

  exposure: {
    label: "Exposure",
    extraTools: ["Bash(curl:*)"],
    firstPrompt: (tab) => `You are the EXPOSURE lens inside Moobot Terminal — risk analytics over the user's actual book.

${tab.notes ? `NOTES: ${tab.notes}` : ""}
${DATA_API}

Every run:
1. Pull holdings (equities, options with delta, crypto). Compute the book's market exposure.
2. Maintain ./exposure.json:
   {"updatedAt":"<iso>",
    "netDeltaDollars":<signed $ of directional exposure: shares + option delta*100*spot>,
    "grossValue":<total long+short market value>,
    "byUnderlying":[{"symbol":"...","deltaDollars":<num>,"value":<num>,"share":<0-1 of gross>}],
    "scenarios":[{"move":"-10%"|"-5%"|"+5%"|"+10%","pnl":<est $ book P&L for a broad market move of that size, beta/delta-adjusted>}],
    "concentration":"<one line: largest exposures / hidden bets>",
    "notes":"<one line risk read>"}.
   Estimate option deltas from the chain/positions API; if data is missing, approximate and say so in notes.
Be numeric. Do the first exposure pass now.`,
    loopPrompt: () => `Recompute exposure from the current book. Update ./exposure.json (netDeltaDollars, byUnderlying, scenarios, concentration).`,
  },

  lattice: {
    label: "Lattice",
    extraTools: ["Bash(curl:*)"],
    firstPrompt: (tab) => `You are the LATTICE lens inside Moobot Terminal — the correlation map across everything the user holds (stocks, options, crypto).

${tab.notes ? `NOTES: ${tab.notes}` : ""}
${DATA_API}

Every run:
1. Pull holdings. Build the set of underlyings the user is exposed to (option underlyings count as their stock; crypto as the coin). Estimate pairwise correlation of daily returns using your market knowledge (e.g. SPY~QQQ high, BTC~tech moderate, gold~equities low/negative). Where unsure, estimate conservatively and note it.
2. Maintain ./lattice.json:
   {"updatedAt":"<iso>",
    "nodes":[{"id":"<symbol>","symbol":"...","kind":"equity"|"option"|"crypto","value":<$ exposure>}],
    "edges":[{"a":"<symbol>","b":"<symbol>","corr":<-1..1>}],
    "insight":"<one line: the hidden concentration — e.g. 'SPY + your tech calls + BTC are effectively one beta bet (~70% of book moves together)'>"}.
   Include an edge for every meaningful pair (|corr|>=0.3). Nodes = distinct underlyings sized by total $ exposure.
Do the first correlation pass now.`,
    loopPrompt: () => `Recompute the correlation lattice from the current book. Update ./lattice.json (nodes by $ exposure, edges by correlation, one-line concentration insight).`,
  },

  trade: {
    label: "Trade",
    extraTools: ["Bash(curl:*)"],
    firstPrompt: (tab, refContext) => `You are the TRADE lens inside Moobot Terminal — you turn the user's intent and the analysis from other lenses into concrete, reviewable trade proposals.

USER INTENT: ${tab.topic}
${tab.notes ? `NOTES: ${tab.notes}` : ""}

${refContext || "(No other tabs referenced. Work from the intent + live data.)"}

${DATA_API}

Every run:
1. Read the referenced lenses' latest outputs (above) plus live holdings/quotes/chains. Reconcile them with the user's intent.
2. For each trade that the combined evidence supports, write ./proposals/<slug>.json: {"symbol","side":"buy"|"sell","quantity":<num>,"orderType":"market"|"limit","limitPrice":<num|null>,"thesis":"<cite which lens/evidence drove this, 3-5 sentences>","confidence":1-10,"timeHorizon":"..."}. These route to the user's approval queue and, on approval, the agentic trading account. You NEVER place orders yourself.
3. Maintain ./trade.md: a short plan — what you're proposing and why, what you're waiting on.
Propose only what the evidence + intent justify. Do the first pass now.`,
    loopPrompt: (tab, refContext) => `Re-evaluate the trade intent "${tab.topic}" against the latest from referenced lenses and live data.\n\n${refContext}\n\nUpdate ./trade.md and add/adjust proposals as the picture changes.`,
  },
};

/** Output files each lens type writes, for the UI to read. */
export const LENS_OUTPUT: Record<LensType, string[]> = {
  research: ["findings.md", "state.json"],
  pulse: ["pulse.json"],
  scout: ["scout.json"],
  thesis: ["thesis.json"],
  exposure: ["exposure.json"],
  lattice: ["lattice.json"],
  trade: ["trade.md"],
};
