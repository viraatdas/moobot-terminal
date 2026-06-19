import crypto from "node:crypto";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { ensureDirs, WS_PORT, BIND_HOST, SERVER_TOKEN } from "./config.ts";
import { RobinhoodGateway } from "./robinhood.ts";
import { ResearchManager } from "./research.ts";
import { ProposalQueue, type TradeProposal } from "./proposals.ts";
import { PluginManager } from "./plugins.ts";
import { RobinhoodMcpData } from "./rh-mcp-data.ts";
import { CorrelationEngine } from "./correlation.ts";
import { AlertManager, notify, sendEmailNotification, setNotifyDelivery } from "./alerts.ts";
import { MarketData } from "./market-data.ts";
import { MarketEventsService } from "./market-events.ts";
import { RiskSummaryService } from "./risk.ts";
import { PortfolioHistoryService } from "./portfolio-history.ts";
import { WatchlistStore } from "./watchlist.ts";
import { SettingsStore } from "./settings.ts";
import { DecisionLog } from "./decisions.ts";
import { TrackRecordService } from "./track-record.ts";
import { TriggerEngine } from "./triggers.ts";
import { StrategyRuntime } from "./strategy-runtime.ts";
import { parseSpec, runBacktest, type StrategySpec } from "./backtest.ts";
import { verifyStrategy, gateVerification, type GateReason, type VerificationReport } from "./verify.ts";
import { loadStrategyBars } from "./strategy-bars.ts";
import { gateReview } from "./review-alerts.ts";
import { PredictionMarkets } from "./prediction-markets.ts";
import { ConnectionsStore } from "./connections.ts";
import { MarketVenues } from "./market-venues.ts";
import { rememberReviewedOrder, consumeReviewedOrder } from "./reviewed-orders.ts";

ensureDirs();

const rh = new RobinhoodGateway();
const portfolioHistory = new PortfolioHistoryService();
const rhData = new RobinhoodMcpData(rh, portfolioHistory);
const correlation = new CorrelationEngine(rhData);
const marketData = new MarketData();
const marketEvents = new MarketEventsService(rhData);
const predictionMarkets = new PredictionMarkets();
const risk = new RiskSummaryService(rhData, correlation);
const watchlist = new WatchlistStore();
const settings = new SettingsStore();
const connections = new ConnectionsStore(settings);
const marketVenues = new MarketVenues(settings, connections);
const decisions = new DecisionLog();
const plugins = new PluginManager();
const research = new ResearchManager(plugins, async (tab) => {
  if (tab.type === "lattice") return { "lattice.json": await correlation.lattice() };
  return null;
});
// Day P&L for the auto-trader kill-switch. The broker snapshot can throw transiently
// under the tick's concurrent MCP load, and a single failure would otherwise fail-closed
// and skip EVERY real trade — so retry a few times, then fall back to a recent cached
// value (the kill-switch tolerates slightly stale P&L) before giving up. Only a true,
// sustained outage with no recent reading fails closed.
let lastDayPnl: { value: number; at: number } | null = null;
async function accountDayPnl(): Promise<number> {
  const acct = settings.autoTradeConfig().account || undefined;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const snap = await rhData.snapshot(acct);
      const dp = Number(snap.portfolio?.dayPnl ?? 0);
      if (Number.isFinite(dp)) {
        lastDayPnl = { value: dp, at: Date.now() };
        return dp;
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
  }
  if (lastDayPnl && Date.now() - lastDayPnl.at < 15 * 60_000) return lastDayPnl.value;
  throw lastErr ?? new Error("day P&L unavailable");
}

const proposals = new ProposalQueue(rh, research, {
  quotes: (symbols) => rhData.quotes(symbols),
  isPaper: () => settings.isPaper(),
  decisions,
  autoTrade: () => {
    const c = settings.autoTradeConfig();
    return c.enabled ? c : null;
  },
  accountDayPnl: accountDayPnl,
  onTradeExecuted: (p) => notifyAutoTrade(p),
  onAutoActivity: (msg) => {
    // Operational visibility: every auto-trade decision (a fill, a cap, a skip, the
    // kill-switch) lands in stdout AND the lens activity feed.
    console.log(`[auto-trade] ${msg}`);
    const id = settings.autoTradeConfig().strategyTabId;
    if (id) research.onEvent?.({ tabId: id, kind: "activity", text: `[auto-trader] ${msg}` });
  },
});

// Desktop + email ping on every (paper or real) auto-trade fill.
function notifyAutoTrade(p: TradeProposal) {
  const ex = p.execution;
  const paper = ex?.paper !== false;
  notify(
    `Moobot ${paper ? "paper " : ""}auto-trade: ${p.side.toUpperCase()} ${ex?.quantity ?? p.quantity} ${p.symbol} @ $${ex?.fillPrice ?? "?"}`,
    `strategy "${p.tabTopic}" — ${p.whyNow}`,
  );
}
// EVERY paper-mode change routes through this so the money-path side-effects can't be
// skipped on any path (the WS settings.set handler, autotrade.arm/disarm, autotrade.setup):
//   paper -> real : stand down EVERY live strategy (real capital must re-clear the gate).
//   real  -> paper: fully disarm the real-money bits so the persisted posture can never
//                   drift out of sync with the actual capability (the panel badge reads them).
function applyPaperTransition(wasPaper: boolean, nowPaper: boolean) {
  if (wasPaper === nowPaper) return;
  if (wasPaper && !nowPaper) {
    research.standDownAllLive(
      "stood down: paper mode turned off — re-verify and go live explicitly to use real capital",
    );
  } else {
    settings.setAutoTradeArming({ allowReal: false, acceptUnverifiedReal: false });
  }
}

const trackRecord = new TrackRecordService(
  () => proposals.list(),
  (symbols) => rhData.quotes(symbols),
);
const alerts = new AlertManager(rh);
const triggers = new TriggerEngine({
  research,
  rhData,
  marketEvents,
  watchlist,
  isConnected: () => rh.authenticated,
  isEnabled: () => settings.eventTriggersOn(),
});
const strategyRuntime = new StrategyRuntime({
  research,
  rhData,
  marketData,
  proposals,
  trackRecord,
  isConnected: () => rh.authenticated,
  // The mechanical strategy loop runs when event-triggers are on OR when the
  // auto-trader is armed — the auto-trader must fire regardless of the unrelated
  // event-triggers preference for the other agents.
  isEnabled: () => settings.eventTriggersOn() || settings.autoTradeConfig().enabled,
  isPaper: () => settings.isPaper(),
  autoTradeConfig: () => settings.autoTradeConfig(),
  onActivity: (tabId, text) => research.onEvent?.({ tabId, kind: "activity", text }),
});

async function runStrategyBacktest(tabId: string, options: unknown) {
  const parsed = parseSpec(research.readStrategy(tabId));
  if ("error" in parsed) return { ok: false as const, error: parsed.error };
  const history = await loadStrategyBars(marketData, parsed.universe);
  return runBacktest(parsed, history, (options as Record<string, unknown>) ?? {});
}

// On-demand strategy verification — the robustness battery + the SPY baseline,
// persisted to verification.json keyed to the spec + engine hash.
async function runStrategyVerify(tabId: string, options: unknown) {
  const parsed = parseSpec(research.readStrategy(tabId));
  if ("error" in parsed) return { ok: false as const, error: parsed.error };
  const history = await loadStrategyBars(marketData, parsed.universe);
  const spy = (await loadStrategyBars(marketData, ["SPY"])).get("SPY") ?? [];
  const iterations = Number((options as Record<string, unknown> | null)?.iterations) || 200;
  const report = verifyStrategy(parsed, history, spy, { iterations, variantsTried: research.verificationTrials(tabId) + 1 });
  if (report.ok) research.writeVerification(tabId, report);
  return report;
}

// Read the persisted verdict and decide whether it still applies to the current
// rules + engine. The staleness rule lives in ONE place (gateVerification); this
// just adds the no-spec case (a parse error voids any prior verdict).
function verificationStatus(tabId: string, spec: StrategySpec | null): { verification: VerificationReport | null; stale: boolean } {
  const v = research.readVerification(tabId);
  if (!spec) return { verification: v, stale: true };
  return { verification: v, stale: gateVerification(spec, v).stale };
}

// The four go-live gate messages, keyed by the gate's reason (precedence order
// matches gateVerification's short-circuit order).
function gateMessage(reason: GateReason | null, v: VerificationReport | null): string {
  switch (reason) {
    case "unverified":
      return "TRUST_GATE: run verification before going live with real money.";
    case "stale":
      return "TRUST_GATE: rules or engine changed since the last verification — re-verify before going live.";
    case "data-quality":
      return "TRUST_GATE: input data failed quality checks — cannot go live.";
    case "grade":
      return `TRUST_GATE: verification grade is "${v?.grade}" — only a strategy that holds up out-of-sample can take real capital. Trial it in paper mode first.`;
    default:
      return "TRUST_GATE: not verified for real capital.";
  }
}

let wss: WebSocketServer | null = null;

/**
 * Local HTTP API for research agents (separate claude processes that can't use
 * the UI WebSocket). Read-only market data backed by the Robinhood MCP.
 * Loopback only. Lets the options-research plugin curl live chains/positions.
 */
function isLoopback(req: http.IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

/** In server mode, non-loopback callers must present the shared secret. */
function httpAuthorized(req: http.IncomingMessage, url: URL): boolean {
  if (!SERVER_TOKEN) return true; // local mode, no auth
  if (isLoopback(req)) return true; // in-container agents curl loopback
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  return bearer === SERVER_TOKEN || url.searchParams.get("token") === SERVER_TOKEN;
}

async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${WS_PORT}`);
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  try {
    if (url.pathname === "/health") return send(200, { ok: true });
    if (!httpAuthorized(req, url)) return send(401, { error: "unauthorized" });
    if (url.pathname === "/chain") {
      const symbol = url.searchParams.get("symbol");
      const exp = url.searchParams.get("expiration");
      if (!symbol) return send(400, { error: "symbol required" });
      if (!exp) {
        const expirations = await rhData.optionExpirations(symbol);
        return send(200, { symbol, expirations });
      }
      const contracts = await rhData.optionChain(symbol, exp);
      return send(200, { symbol, expiration: exp, contracts });
    }
    if (url.pathname === "/positions") {
      const acct = url.searchParams.get("account") || undefined;
      const snapshot = await rhData.snapshot(acct);
      return send(200, {
        account: snapshot.accountNumber,
        equities: snapshot.equities,
        options: snapshot.options,
        crypto: snapshot.crypto,
      });
    }
    if (url.pathname === "/lattice") {
      const acct = url.searchParams.get("account") || undefined;
      return send(200, await correlation.lattice(acct));
    }
    if (url.pathname === "/predictions") {
      // Lens agents curl this for structured Polymarket/Kalshi odds on a topic.
      const q = url.searchParams.get("q") || url.searchParams.get("query") || "";
      const limit = Number(url.searchParams.get("limit")) || 12;
      return send(200, await predictionMarkets.search(q, limit));
    }
    if (url.pathname === "/venues/docs") return send(200, marketVenues.docs());
    if (url.pathname === "/venues/status") return send(200, connections.status());
    if (url.pathname === "/venues/kalshi/markets") {
      return send(200, await marketVenues.kalshiMarkets(url.searchParams.get("q") || "", Number(url.searchParams.get("limit")) || 25));
    }
    if (url.pathname === "/venues/kalshi/portfolio") return send(200, await marketVenues.kalshiPortfolio());
    if (url.pathname === "/venues/polymarket/markets") {
      return send(200, await marketVenues.polymarketMarkets(url.searchParams.get("cursor") || undefined));
    }
    if (url.pathname === "/venues/polymarket/account") return send(200, await marketVenues.polymarketAccount());
    if (url.pathname === "/venues/hyperliquid/markets") {
      return send(200, await marketVenues.hyperliquidPublic(url.searchParams.get("kind") || undefined, url.searchParams.get("coin") || undefined));
    }
    if (url.pathname === "/venues/hyperliquid/account") return send(200, await marketVenues.hyperliquidAccount());
    return send(404, { error: "not found" });
  } catch (err) {
    return send(502, { error: String(err) });
  }
}

function listen(attempt = 0) {
  const httpServer = http.createServer((req, res) => void handleHttp(req, res));
  const server = new WebSocketServer({
    server: httpServer,
    // In server mode, the WS handshake must carry the shared secret.
    verifyClient: (info) => {
      if (!SERVER_TOKEN) return true;
      const url = new URL(info.req.url ?? "/", `http://x:${WS_PORT}`);
      const proto = info.req.headers["sec-websocket-protocol"];
      return url.searchParams.get("token") === SERVER_TOKEN || proto === SERVER_TOKEN;
    },
  });
  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    // A previous sidecar may still hold the port for a moment (app relaunch,
    // dev instance shutting down) - retry before giving up.
    if (err.code === "EADDRINUSE" && attempt < 10) {
      console.error(`[moobot-sidecar] port ${WS_PORT} in use, retry ${attempt + 1}/10`);
      httpServer.close();
      setTimeout(() => listen(attempt + 1), 2000);
      return;
    }
    console.error(`[moobot-sidecar] fatal server error: ${err}`);
    process.exit(1);
  });
  httpServer.on("listening", () => {
    wss = server;
    console.log(
      `[moobot-sidecar] listening on ws+http://${BIND_HOST}:${WS_PORT}` +
        (SERVER_TOKEN ? " (token-protected)" : ""),
    );
  });
  server.on("connection", onConnection);
  httpServer.listen(WS_PORT, BIND_HOST);
}

function broadcast(event: string, payload: unknown) {
  if (!wss) return;
  const msg = JSON.stringify({ type: "event", event, payload });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

// Deliver desktop notifications natively through a connected app window (so macOS
// shows the Moobot icon); alerts.notify falls back to osascript only if nothing's here.
setNotifyDelivery((title, body) => {
  if (!wss) return false;
  const msg = JSON.stringify({ type: "event", event: "notify", payload: { title, body } });
  let sent = 0;
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
      sent += 1;
    }
  }
  return sent > 0;
});

rh.onAuthUrl = (url) => broadcast("rh.auth-url", { url });
research.onEvent = (ev) => broadcast("research", ev);
research.onProposalsMaybeChanged = (tabId) => {
  void proposals.ingest(tabId);
};
alerts.onTriggered = (a) => broadcast("alert.triggered", { alert: a });
settings.onChanged = (s) => broadcast("settings.changed", { settings: s });

// Notify (native + UI) when a research agent files a new pending proposal.
let lastPendingIds = new Set(proposals.list().filter((p) => p.status === "pending").map((p) => p.id));
proposals.onChanged = () => {
  const list = proposals.list();
  broadcast("proposals.changed", { proposals: list });
  const pending = list.filter((p) => p.status === "pending");
  for (const p of pending) {
    if (!lastPendingIds.has(p.id)) {
      notify(
        `New trade proposal: ${p.side.toUpperCase()} ${p.quantity} ${p.symbol}`,
        `from "${p.tabTopic}" · conf ${p.confidence}/10`,
      );
    }
  }
  lastPendingIds = new Set(pending.map((p) => p.id));
};

type Handler = (payload: any) => Promise<unknown> | unknown;

const handlers: Record<string, Handler> = {
  "rh.status": () => ({
    authenticated: rh.authenticated,
    hasStoredTokens: rh.hasStoredTokens(),
  }),
  "rh.connect": async () => {
    await rh.connect();
    return { authenticated: true };
  },
  "rh.finish": async ({ codeOrUrl }) => {
    await rh.finishAuthManually(codeOrUrl);
    return { authenticated: true };
  },
  "rh.call": async ({ tool, args }) => {
    if (/^(place|cancel)_.*_order$/.test(tool)) {
      throw new Error(`${tool} is not callable via rh.call - use the approval flow`);
    }
    return rh.callTool(tool, args ?? {});
  },
  // Full-account MCP read connection.
  "account.snapshot": async ({ accountNumber }) => {
    return rhData.snapshot(accountNumber);
  },
  "account.history": async ({ accountNumber, range }) => {
    return portfolioHistory.history(accountNumber, { range });
  },
  "account.lattice": async ({ accountNumber }) => {
    return correlation.lattice(accountNumber);
  },
  "account.risk": async ({ accountNumber }) => {
    return risk.summary(accountNumber);
  },
  "market.history": async ({ symbol, range, interval }) => {
    return marketData.history(symbol, { range, interval });
  },
  "market.events": async ({ accountNumber, windowDays, nearExpiryDays, symbols }) => {
    return marketEvents.events(accountNumber, { windowDays, nearExpiryDays, symbols });
  },
  "markets.predictions": ({ query, limit }) => predictionMarkets.search(query, Number(limit) || 12),
  "markets.hyperliquid": async ({ kind, coin }: { kind?: string; coin?: string }) => {
    // Read-only public market data. Account reads use venue.hyperliquid.account.
    return marketVenues.hyperliquidPublic(kind, coin);
  },
  "connections.status": () => connections.status(),
  "connections.check": () => marketVenues.statusDeep(),
  "connections.docs": () => marketVenues.docs(),
  "connections.saveKey": ({ venue, payload }: { venue: any; payload: unknown }) => {
    connections.saveKey(venue, payload);
    return connections.status();
  },
  "connections.clearKey": ({ venue }: { venue: any }) => {
    connections.clearKey(venue);
    return connections.status();
  },
  "connections.setArming": ({ venue, trading }: { venue: any; trading?: boolean }) => {
    // Money-arming: live trading can only go on with paper OFF and a stored key.
    if (trading === true) {
      if (settings.isPaper()) throw new Error("turn paper mode OFF before arming live trading");
      if (!connections.hasKey(venue)) throw new Error(`connect ${venue} first`);
    }
    settings.setConnectionArming(venue, { trading: trading === true });
    return connections.status();
  },
  "venue.kalshi.portfolio": () => marketVenues.kalshiPortfolio(),
  "venue.kalshi.markets": ({ query, limit }: { query?: unknown; limit?: unknown }) => marketVenues.kalshiMarkets(query, limit),
  "venue.kalshi.placeOrder": ({ order, confirmed }: { order?: unknown; confirmed?: unknown }) =>
    marketVenues.placeKalshiOrder(order ?? {}, confirmed),
  "venue.polymarket.markets": ({ cursor }: { cursor?: unknown }) => marketVenues.polymarketMarkets(cursor),
  "venue.polymarket.account": () => marketVenues.polymarketAccount(),
  "venue.polymarket.placeOrder": ({ order, confirmed }: { order?: unknown; confirmed?: unknown }) =>
    marketVenues.placePolymarketOrder(order ?? {}, confirmed),
  "venue.hyperliquid.account": () => marketVenues.hyperliquidAccount(),
  "venue.hyperliquid.placeOrder": ({ order, confirmed }: { order?: unknown; confirmed?: unknown }) =>
    marketVenues.placeHyperliquidOrder(order ?? {}, confirmed),
  "watchlist.list": () => watchlist.list().map((item) => item.symbol),
  "watchlist.add": ({ symbol, label, name, note }) =>
    watchlist.add(symbol, { label: label ?? name, note }).items.map((item) => item.symbol),
  "watchlist.remove": ({ symbol }) => watchlist.remove(symbol).items.map((item) => item.symbol),
  "options.chain": async ({ symbol, expiration }) => {
    if (!expiration) {
      const exps = await rhData.optionExpirations(symbol);
      return { expirations: exps, contracts: [] };
    }
    const contracts = await rhData.optionChain(symbol, expiration);
    return { expirations: [expiration], contracts };
  },
  "alerts.list": () => alerts.list(),
  "alerts.create": ({ symbol, op, price, note }) =>
    alerts.create(symbol, op, Number(price), note ?? ""),
  "alerts.update": ({ id, ...patch }) => alerts.update(id, patch),
  "alerts.remove": ({ id }) => {
    alerts.remove(id);
    return { ok: true };
  },
  "notify.emailTest": () =>
    sendEmailNotification(
      "Moobot Terminal email test",
      "Email notifications are configured for Moobot Terminal.",
    ),
  "research.runAll": () => {
    for (const tab of research.list()) if (!tab.paused) void research.run(tab.id);
    return { started: true };
  },
  "autotrade.status": async () => {
    // Self-heal a dangling wire: if the auto-trader points at a strategy tab that no
    // longer exists (e.g. the user closed it), clear the wire + disarm real money so the
    // posture can't read "armed" against a ghost strategy. autotrade.arm re-validates the
    // tab + agentic account independently, so this only ever makes things SAFER. research
    // loads all tabs synchronously at startup, so the tab set is authoritative here — no
    // false-positive heal of a still-loading tab.
    const wired = settings.autoTradeConfig();
    if (wired.strategyTabId && !research.get(wired.strategyTabId)) {
      settings.set({ autoTrade: { ...wired, strategyTabId: null, enabled: false } });
      settings.setAutoTradeArming({ allowReal: false, acceptUnverifiedReal: false, enabled: false });
    }
    const cfg = settings.autoTradeConfig();
    const fills = cfg.strategyTabId
      ? proposals.list().filter((p) => p.tabId === cfg.strategyTabId)
      : [];
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    // Mode-aware: count fills in the CURRENT mode only (matches the daily-cap logic in
    // proposals.autoTrade) so paper trial fills don't show against a real-money cap.
    const isPaperNow = settings.isPaper();
    const todayCount = fills.filter(
      (p) =>
        p.status === "approved" &&
        p.execution &&
        p.execution.paper === isPaperNow &&
        Date.parse(p.execution.placedAt) >= startOfDay.getTime(),
    ).length;
    let dayPnl: number | null = 0;
    try {
      const snap = await rhData.snapshot(cfg.account || undefined);
      const dp = snap.portfolio?.dayPnl;
      dayPnl = typeof dp === "number" && Number.isFinite(dp) ? dp : null;
    } catch {
      dayPnl = null; // unknown — distinguish from a real $0 day so the UI shows "unknown"
    }
    let universe: string[] = [];
    let strategyLive = false;
    if (cfg.strategyTabId) {
      const raw = research.readStrategy(cfg.strategyTabId) as { universe?: unknown; live?: unknown } | null;
      if (raw && Array.isArray(raw.universe)) universe = raw.universe.map((s) => String(s));
      strategyLive = raw?.live === true;
    }
    const blocked = proposals.autoTradeBlocked();
    // Whether the runtime would actually OPEN new real positions right now — the precise
    // composite the override gate keys on.
    const realEntriesArmed =
      !isPaperNow && cfg.enabled && cfg.allowReal === true && cfg.acceptUnverifiedReal === true && strategyLive;
    // THE single authoritative posture word. Computed once here so every surface renders
    // the SAME string and can never disagree (no client-side re-derivation). Precedence:
    // not-wired → paused → paper → blocked → real states.
    const status = !cfg.strategyTabId
      ? "off"
      : !cfg.enabled
        ? "paused"
        : isPaperNow
          ? "paper"
          : blocked
            ? "blocked"
            : realEntriesArmed
              ? cfg.autoApprove === false
                ? "armed-real" // real entries allowed, but each waits for a human approve
                : "live-real" // real, auto-executing within caps
              : cfg.allowReal
                ? "exits-only" // real money on, but new entries gated (unverified) — exits still fire
                : "armed"; // real mode, not yet armed for placement
    // "Recent fills" = proposals that actually executed (paper or real); pending /
    // cap-blocked signals live in the main proposals queue, not here.
    return {
      status,
      config: cfg,
      paper: settings.isPaper(),
      realEntriesArmed,
      strategyLive,
      // An account-setup block (e.g. investor profile incomplete) that halted auto-trade
      // and the actionable link to resolve it — surfaced as a banner in the UI.
      block: blocked,
      todayCount,
      dayPnl,
      universe,
      fills: fills.filter((p) => p.execution).slice(0, 12),
    };
  },
  "autotrade.set": ({ patch }: { patch?: Record<string, unknown> }) => {
    // Validate + whitelist — never blindly spread client input into the money-path config.
    const cur = settings.autoTradeConfig();
    const p = (patch ?? {}) as Record<string, unknown>;
    const next = { ...cur };
    if (typeof p.enabled === "boolean") next.enabled = p.enabled;
    if (typeof p.autoApprove === "boolean") next.autoApprove = p.autoApprove;
    if (typeof p.maxPerTrade === "number" && p.maxPerTrade > 0) next.maxPerTrade = p.maxPerTrade;
    if (typeof p.maxPerDay === "number" && p.maxPerDay > 0) next.maxPerDay = Math.floor(p.maxPerDay);
    if (typeof p.dailyLossKill === "number" && p.dailyLossKill > 0) next.dailyLossKill = p.dailyLossKill;
    if (p.approveScope === "strategy" || p.approveScope === "all") next.approveScope = p.approveScope;
    // Enabling requires a wired strategy (created via autotrade.setup).
    if (next.enabled && !next.strategyTabId) {
      throw new Error("set up the auto-trader (wire a strategy) before enabling it");
    }
    // NOTE: the real-money arming bits (allowReal / acceptUnverifiedReal) are NOT
    // settable here — they flip ONLY through autotrade.arm/disarm (deliberate, confirmed,
    // validated). settings.set's whitelist drops them too, so this is defense-in-depth.
    settings.set({ autoTrade: next });
    return settings.autoTradeConfig();
  },
  "autotrade.setup": async ({
    universe,
    maxPerTrade,
    maxPerDay,
    dailyLossKill,
  }: {
    universe?: unknown[];
    maxPerTrade?: number;
    maxPerDay?: number;
    dailyLossKill?: number;
  }) => {
    const acct = (await rhData.accounts()).find((a) => a?.agentic_allowed)?.account_number ?? "";
    const perTrade = Number(maxPerTrade) || 100;
    const tab = research.create(
      "Auto-trader · mean-reversion",
      "Autonomous RSI(2) dip-buy with a 200-day trend filter (fixed rules — not agent-authored).",
      0,
      "strategy",
      [],
      "claude",
      false,
    );
    const uni =
      Array.isArray(universe) && universe.length
        ? universe.map((s) => String(s).toUpperCase())
        : ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "AMD", "JPM"];
    research.writeStrategy(tab.id, {
      version: 1,
      universe: uni,
      direction: "long",
      // Buy uptrend pullbacks (above the 200d trend, but dipped below the 5-day
      // average), exit on the bounce back above it — an active mean-reversion.
      entry: {
        all: [
          { lhs: { price: "close" }, op: ">", rhs: { sma: 200 } },
          { lhs: { price: "close" }, op: "<", rhs: { sma: 5 } },
        ],
      },
      exit: {
        any: [
          { lhs: { price: "close" }, op: ">", rhs: { sma: 5 } },
          { lhs: { rsi: 2 }, op: ">", rhs: 80 },
          { trailingStop: 8 },
        ],
      },
      sizing: { type: "fixedNotional", value: perTrade },
      cooldownBars: 1,
      maxPositions: 4,
      llmGate: null,
      live: true,
      fractional: true,
    });
    const wasPaper = settings.isPaper();
    settings.set({
      paperMode: true,
      autoTrade: {
        enabled: true,
        account: acct,
        maxPerTrade: perTrade,
        maxPerDay: Number(maxPerDay) || 4,
        dailyLossKill: Number(dailyLossKill) || 80,
        strategyTabId: tab.id,
        approveScope: "strategy",
      },
    });
    applyPaperTransition(wasPaper, true);
    // A fresh wiring ALWAYS clears the real-money arming bits, so a stale
    // acceptUnverifiedReal from a previously-armed tab can never carry onto this new
    // one (the override is tab-scoped, but the config bit must not leak). (Reviewed.)
    settings.setAutoTradeArming({ allowReal: false, acceptUnverifiedReal: false });
    // Evaluate immediately so a setup can fire now instead of waiting for the 5-min tick.
    void strategyRuntime.tickNow();
    return { config: settings.autoTradeConfig(), strategyTabId: tab.id, account: acct };
  },
  "autotrade.runNow": () => {
    void strategyRuntime.tickNow();
    return { ok: true };
  },
  // Clear an account-setup block (after the user resolves it) and re-evaluate now.
  "autotrade.clearBlock": () => {
    proposals.clearAutoTradeBlock();
    void strategyRuntime.tickNow();
    return { ok: true };
  },
  // GO REAL. Atomically flips the auto-trader from paper to real-money on the
  // agentic account, accepting an UNVERIFIED, -EV strategy on purpose. This is the
  // one deliberate override of the trust gate, scoped strictly to the auto-trader
  // tab; the hard caps + daily-loss kill-switch remain the protection. The UI
  // requires an explicit human confirm before calling this.
  "autotrade.arm": async () => {
    const cfg = settings.autoTradeConfig();
    if (!cfg.strategyTabId) throw new Error("set up the auto-trader (wire a strategy) before arming real money");
    if (!cfg.account) throw new Error("no agentic account is set for real-money auto-trade");
    // HARD GUARANTEE: real auto-trade can ONLY ever arm on an AGENTIC account — never a
    // personal/main brokerage account, regardless of how the config was reached. This is
    // the enforced version of "the auto-trader is agentic-only".
    const accts = await rhData.accounts();
    if (!accts.some((a) => a?.account_number === cfg.account && a?.agentic_allowed)) {
      throw new Error(`refusing to arm: ${cfg.account} is not an agentic account — real auto-trade is agentic-only`);
    }
    // VALIDATE the strategy BEFORE mutating anything, so a bad spec can never leave us
    // half-armed (paper already off but the rest unset). (Reviewed: HIGH finding.)
    const parsed = parseSpec(research.readStrategy(cfg.strategyTabId));
    if ("error" in parsed) throw new Error(`auto-trader strategy is invalid: ${parsed.error}`);
    parsed.live = true;
    const wasPaper = settings.isPaper();
    try {
      // 1) Paper OFF + stand down EVERY other live strategy (so the auto-trader tab is
      //    the ONLY thing live on real capital). applyPaperTransition does the stand-down.
      settings.set({ paperMode: false });
      applyPaperTransition(wasPaper, false);
      // 2) Re-arm ONLY the auto-trader tab live (deliberately bypassing setLive's trust
      //    gate via the explicit override — every other strategy must still use setLive).
      research.writeStrategy(cfg.strategyTabId, parsed);
      // 3) Flip the real-money arming bits through the one sanctioned setter.
      settings.setAutoTradeArming({ enabled: true, allowReal: true, acceptUnverifiedReal: true });
      proposals.clearAutoTradeBlock(); // a fresh arm starts from a clean slate
    } catch (err) {
      // Any failure mid-arm rolls all the way back to safe paper state.
      settings.set({ paperMode: true });
      settings.setAutoTradeArming({ allowReal: false, acceptUnverifiedReal: false });
      throw err;
    }
    notify(
      "Moobot auto-trader is LIVE (real money)",
      `Real $ on account ${cfg.account} · caps $${cfg.maxPerTrade}/trade, ${cfg.maxPerDay}/day, −$${cfg.dailyLossKill} kill-switch`,
    );
    // Evaluate immediately so it can act now instead of waiting for the 5-min tick.
    void strategyRuntime.tickNow();
    return settings.autoTradeConfig();
  },
  // STAND DOWN. Back to safe paper mode: flip paper on (applyPaperTransition fully
  // disarms the real-money bits) and belt-and-suspenders disarm them explicitly. The
  // strategy stays wired AND live so the paper trial keeps running; nothing can reach
  // the broker while paper is on, and re-arming requires the deliberate arm path again.
  "autotrade.disarm": () => {
    const wasPaper = settings.isPaper();
    settings.set({ paperMode: true });
    applyPaperTransition(wasPaper, true);
    settings.setAutoTradeArming({ allowReal: false, acceptUnverifiedReal: false });
    notify("Moobot auto-trader stood down", "Back to paper mode — real-money placement disarmed.");
    return settings.autoTradeConfig();
  },
  "notify.test": () => {
    notify("Moobot Terminal", "Test notification — this should show the Moobot icon now.");
    return { ok: true };
  },
  "plugins.list": () => plugins.list(),
  "plugins.setEnabled": ({ name, enabled }) => {
    plugins.setEnabled(name, enabled);
    return plugins.list();
  },
  "plugins.reload": () => {
    plugins.reload();
    return plugins.list();
  },
  "research.list": () => research.list(),
  "research.create": ({ topic, notes, intervalMinutes, type, refs, engine, autoRun }) =>
    research.create(
      topic,
      notes ?? "",
      intervalMinutes ?? 30,
      type ?? "research",
      refs ?? [],
      engine === "codex" ? "codex" : "claude",
      autoRun !== false,
    ),
  "research.update": ({ id, ...patch }) => research.update(id, patch),
  "research.remove": ({ id }) => {
    research.remove(id);
    return { ok: true };
  },
  "research.run": ({ id }) => {
    void research.run(id);
    return { started: true };
  },
  "research.findings": ({ id }) => research.findings(id),
  // Manual order ticket - human-initiated from the UI. Review first, then place.
  "trade.review": async ({ order }) => {
    const review = await rh.callTool("review_equity_order", order);
    return { review, ...rememberReviewedOrder(order) };
  },
  "trade.place": async ({ order, confirmed, reviewToken }) => {
    if (confirmed !== true) throw new Error("Order not confirmed by user");
    consumeReviewedOrder(order, reviewToken);
    if (settings.isPaper()) {
      return { paper: true, simulated: order };
    }
    // Defensively coerce to the Robinhood arg shape (string quantity/limit_price)
    // rather than trusting the UI — the same contract proposals.approve enforces.
    const o = order as Record<string, unknown>;
    const qty = Number(o.quantity);
    if (!Number.isFinite(qty) || qty <= 0) throw new Error(`Invalid order quantity: ${o.quantity}`);
    const normalized: Record<string, unknown> = { ...o, quantity: String(qty) };
    if (o.type === "limit") {
      const lp = Number(o.limit_price);
      if (!Number.isFinite(lp) || lp <= 0) throw new Error(`Invalid limit price: ${o.limit_price}`);
      normalized.limit_price = String(lp);
    }
    // Same pre-trade hard-block the proposal path enforces: re-review at place time
    // (a dry-run) and throw on halt / PDT / insufficient buying power, so the manual
    // ticket can't bypass the guard the approval path applies. Conditions can change
    // between the UI's review and the user's confirmation, so we re-check here.
    const review = await rh.callTool("review_equity_order", normalized);
    gateReview(review);
    return rh.callTool("place_equity_order", {
      ...normalized,
      ref_id: crypto.randomUUID(),
    });
  },
  "proposals.list": () => proposals.list(),
  "proposals.approve": ({ id, accountNumber, overrides }) =>
    proposals.approve(id, accountNumber, overrides),
  "proposals.reject": ({ id }) => proposals.reject(id),
  "settings.get": () => settings.get(),
  "settings.set": ({ patch }) => {
    const wasPaper = settings.isPaper();
    settings.set(patch ?? {});
    // Both money-path side-effects of a paper flip live in ONE helper: paper->real
    // stands down every live strategy; real->paper fully disarms the real-money bits
    // so the persisted posture can't drift from the actual capability.
    applyPaperTransition(wasPaper, settings.isPaper());
    return settings.get();
  },
  "decisions.list": () => decisions.list(),
  "track.record": () => trackRecord.compute(),
  "strategy.get": async ({ tabId }) => {
    const raw = research.readStrategy(tabId);
    const parsed = raw ? parseSpec(raw) : null;
    const spec = parsed && "version" in parsed ? parsed : null;
    const { verification, stale } = verificationStatus(tabId, spec);
    const live = (raw as Record<string, unknown> | null)?.live === true;
    // A live, currently-passing strategy whose realized results have broken from
    // the backtest is shown as "diverged" so the badge reflects re-gated capital.
    let shown = verification;
    if (live && verification && !stale && verification.grade === "holds-up") {
      try {
        const lc = await trackRecord.liveConsistency(tabId, verification.backtestWinRatePct ?? null, verification.specHash ?? null);
        if (lc.verdict === "diverged") shown = { ...verification, grade: "diverged" };
      } catch {
        /* reconciliation unavailable — show the stored grade */
      }
    }
    return {
      raw,
      spec,
      error: parsed && "error" in parsed ? parsed.error : null,
      markdown: research.readStrategyMarkdown(tabId),
      live,
      verification: shown,
      stale,
    };
  },
  "strategy.save": ({ tabId, spec }) => {
    const parsed = parseSpec(spec);
    if ("error" in parsed) throw new Error(parsed.error);
    // Defense-in-depth: save can never flip a strategy live — only strategy.setLive
    // (which enforces the TRUST_GATE) may change the live flag. Preserve the stored
    // value and ignore any incoming `live`.
    parsed.live = research.getLive(tabId);
    research.writeStrategy(tabId, parsed);
    return parsed;
  },
  "strategy.setLive": async ({ tabId, live }) => {
    const parsed = parseSpec(research.readStrategy(tabId));
    if ("error" in parsed) throw new Error(parsed.error);
    // Real-money go-live is HARD-gated on a non-stale, data-clean, "holds-up"
    // verdict that has NOT diverged in live. Paper-mode go-live is always allowed
    // (it never reaches the broker); turning a strategy OFF is always allowed.
    if (live === true && !settings.isPaper()) {
      const v = research.readVerification(tabId);
      const g = gateVerification(parsed, v);
      if (!g.ok) throw new Error(gateMessage(g.reason, v));
      // g.ok ⇒ v is non-null. The live-divergence check is the one piece that
      // can't live in the pure gate (needs the track record).
      const lc = await trackRecord.liveConsistency(tabId, v!.backtestWinRatePct ?? null, v!.specHash ?? null);
      if (lc.verdict === "diverged") {
        throw new Error(`TRUST_GATE: live results have diverged from the backtest — ${lc.detail}. Re-verify or adjust the rules before resuming real capital.`);
      }
    }
    parsed.live = live === true;
    research.writeStrategy(tabId, parsed);
    return { live: parsed.live };
  },
  "strategy.backtest": ({ tabId, options }) => runStrategyBacktest(tabId, options),
  "strategy.verify": ({ tabId, options }) => runStrategyVerify(tabId, options),
  "strategy.liveConsistency": ({ tabId }) => {
    const v = research.readVerification(tabId);
    return trackRecord.liveConsistency(tabId, v?.backtestWinRatePct ?? null, v?.specHash ?? null);
  },
};

function onConnection(ws: WebSocket) {
  ws.on("message", async (data) => {
    let req: { id: string; type: string; payload?: unknown };
    try {
      req = JSON.parse(data.toString());
    } catch {
      return;
    }
    const handler = handlers[req.type];
    try {
      if (!handler) throw new Error(`Unknown request type: ${req.type}`);
      const result = await handler(req.payload ?? {});
      ws.send(JSON.stringify({ id: req.id, ok: true, data: result }));
    } catch (err) {
      ws.send(JSON.stringify({ id: req.id, ok: false, error: String(err) }));
    }
  });
}

listen();

// Connect eagerly if we have tokens (or can import Claude Code's), so the UI
// loads data instantly without a browser round-trip.
if (rh.hasStoredTokens() || rh.importFromEnv() || rh.importFromClaudeCode()) {
  rh.connect().catch((err) => console.error(`[moobot-sidecar] rh connect: ${err}`));
}

// Wake agents on material events (gated internally on connection + the setting).
triggers.start();
// Evaluate live strategy lenses and file proposals on rule triggers.
strategyRuntime.start();

process.on("SIGTERM", () => {
  triggers.stop();
  strategyRuntime.stop();
  research.stopAll();
  process.exit(0);
});
process.on("SIGINT", () => {
  triggers.stop();
  strategyRuntime.stop();
  research.stopAll();
  process.exit(0);
});
