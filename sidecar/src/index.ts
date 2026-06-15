import crypto from "node:crypto";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { ensureDirs, WS_PORT, BIND_HOST, SERVER_TOKEN } from "./config.ts";
import { RobinhoodGateway } from "./robinhood.ts";
import { ResearchManager } from "./research.ts";
import { ProposalQueue } from "./proposals.ts";
import { PluginManager } from "./plugins.ts";
import { RobinhoodMcpData } from "./rh-mcp-data.ts";
import { CorrelationEngine } from "./correlation.ts";
import { AlertManager, notify, sendEmailNotification } from "./alerts.ts";
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
const decisions = new DecisionLog();
const plugins = new PluginManager();
const research = new ResearchManager(plugins, async (tab) => {
  if (tab.type === "lattice") return { "lattice.json": await correlation.lattice() };
  return null;
});
const proposals = new ProposalQueue(rh, research, {
  quotes: (symbols) => rhData.quotes(symbols),
  isPaper: () => settings.isPaper(),
  decisions,
});
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
  isEnabled: () => settings.eventTriggersOn(),
  isPaper: () => settings.isPaper(),
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
  "research.create": ({ topic, notes, intervalMinutes, type, refs, engine }) =>
    research.create(
      topic,
      notes ?? "",
      intervalMinutes ?? 30,
      type ?? "research",
      refs ?? [],
      engine === "codex" ? "codex" : "claude",
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
    const s = settings.set(patch ?? {});
    // Switching paper -> real money stands down EVERY live strategy: real capital
    // must clear the TRUST_GATE explicitly via setLive, never inherit a "live" flag
    // that was only ever validated for simulated fills.
    if (wasPaper && !settings.isPaper()) {
      research.standDownAllLive("stood down: paper mode turned off — re-verify and go live explicitly to use real capital");
    }
    return s;
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
