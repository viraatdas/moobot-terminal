// WebSocket client for the moobot sidecar.

export type LensType =
  | "chat"
  | "research"
  | "pulse"
  | "scout"
  | "thesis"
  | "exposure"
  | "lattice"
  | "trade"
  | "strategy";
export type AgentEngine = "claude" | "codex";

export interface ResearchTab {
  id: string;
  type: LensType;
  engine: AgentEngine;
  topic: string;
  notes: string;
  refs: string[];
  intervalMinutes: number;
  paused: boolean;
  createdAt: string;
  lastRunAt: string | null;
  lastRunStatus: "idle" | "running" | "ok" | "error";
  lastError: string | null;
  sessionId: string | null;
  runCount: number;
}

export const LENS_META: Record<
  LensType,
  { label: string; glyph: string; blurb: string; hasTopic: boolean }
> = {
  chat: { label: "Chat", glyph: "✦", blurb: "Ask anything across your book, market data, venues, web, and other lenses.", hasTopic: true },
  research: { label: "Research", glyph: "◎", blurb: "Build a sourced brief on one ticker, theme, or catalyst.", hasTopic: true },
  pulse: { label: "Watch", glyph: "◇", blurb: "Watch your book and scan for setups. Pings you on fresh moves, headlines, and expiry risk.", hasTopic: true },
  scout: { label: "Scout", glyph: "◆", blurb: "Find new setups that fit your holdings and trading style.", hasTopic: true },
  thesis: { label: "Thesis", glyph: "✛", blurb: "Hold and track a conviction view; proposes a trade when the evidence is there.", hasTopic: true },
  exposure: { label: "Portfolio", glyph: "▦", blurb: "X-ray your book: directional risk, concentration, and scenario P&L.", hasTopic: false },
  lattice: { label: "Lattice", glyph: "⬡", blurb: "Reveal hidden correlation clusters and one-bet risk.", hasTopic: false },
  trade: { label: "Trade", glyph: "▲", blurb: "Turn intent and tab context into approval-ready proposals.", hasTopic: true },
  strategy: { label: "Strategy", glyph: "⟐", blurb: "Co-author mechanical rules, backtest them, run them live.", hasTopic: true },
};

// The primary front door. Specialist variants stay reachable under "Advanced".
export interface LensVerb {
  primary: LensType;
  label: string;
  glyph: string;
  blurb: string;
  variants: LensType[];
}
export const LENS_VERBS: LensVerb[] = [
  { primary: "chat", label: "Chat", glyph: LENS_META.chat.glyph, blurb: LENS_META.chat.blurb, variants: [] },
  { primary: "research", label: "Research", glyph: LENS_META.research.glyph, blurb: LENS_META.research.blurb, variants: ["thesis", "scout"] },
  { primary: "pulse", label: "Watch", glyph: LENS_META.pulse.glyph, blurb: LENS_META.pulse.blurb, variants: ["exposure", "lattice"] },
  { primary: "trade", label: "Trade", glyph: LENS_META.trade.glyph, blurb: LENS_META.trade.blurb, variants: ["strategy"] },
];
// Flattened create order (primaries first within each verb), shared by all pickers.
export const LENS_VERB_ORDER: LensType[] = LENS_VERBS.flatMap((v) => [v.primary, ...v.variants]);
export const LENS_VARIANTS: LensType[] = LENS_VERBS.flatMap((v) => v.variants);
export function verbForType(t: LensType): LensVerb {
  return LENS_VERBS.find((v) => v.primary === t || v.variants.includes(t)) ?? LENS_VERBS[0];
}

// THE single auto-trader posture word (computed once on the backend in autotrade.status).
// Every surface renders it through autoTradeStatusMeta so they can never disagree.
export type AutoTradeStatus =
  | "off"
  | "paused"
  | "paper"
  | "blocked"
  | "live-real"
  | "armed-real"
  | "exits-only"
  | "armed";

export function autoTradeStatusMeta(s: AutoTradeStatus | undefined | null): {
  label: string;
  tone: "pos" | "neg" | "amber" | "dim";
  real: boolean;
} {
  switch (s) {
    case "live-real":
      return { label: "Live · real $", tone: "neg", real: true };
    case "armed-real":
      return { label: "Real · manual", tone: "neg", real: true };
    case "exits-only":
      return { label: "Real · exits only", tone: "amber", real: true };
    case "blocked":
      return { label: "Halted · action needed", tone: "amber", real: true };
    case "paper":
      return { label: "Paper", tone: "amber", real: false };
    case "armed":
      return { label: "Armed", tone: "amber", real: true };
    case "paused":
      return { label: "Paused", tone: "dim", real: false };
    default:
      return { label: "Off", tone: "dim", real: false };
  }
}

export interface ResearchState {
  sentiment?: "bullish" | "bearish" | "neutral";
  conviction?: number;
  headline?: string;
  updatedAt?: string;
}

export interface ReviewAlert {
  kind: "buying-power" | "pdt" | "halt" | "collar" | "other";
  severity: "hard" | "soft";
  message: string;
}

export interface ProposalExecution {
  quantity: number;
  orderType: "market" | "limit";
  limitPrice: number | null;
  modified: boolean;
  paper: boolean;
  fillPrice: number | null;
  reviewAlerts: ReviewAlert[] | null;
  reviewQuote: number | null;
  refId: string;
  placedAt: string;
}

export interface TradeProposal {
  id: string;
  tabId: string;
  tabTopic: string;
  sourceFile: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  orderType: "market" | "limit";
  limitPrice: number | null;
  stop: number | null;
  target: number | null;
  thesis: string;
  whyNow: string;
  confidence: number;
  timeHorizon: string;
  entryPrice: number | null;
  entryAt: string | null;
  strategySpecHash: string | null;
  createdAt: string;
  status: "pending" | "approving" | "approved" | "rejected" | "failed";
  result: unknown;
  execution: ProposalExecution | null;
  error: string | null;
}

export interface AppSettings {
  paperMode: boolean;
  eventTriggers: boolean;
}

export interface TrackRecordEntry {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  tabTopic: string;
  confidence: number;
  createdAt: string;
  status: TradeProposal["status"];
  acted: boolean;
  paper: boolean | null;
  quantity: number;
  entryPrice: number | null;
  currentPrice: number | null;
  returnPct: number | null;
  pnl: number | null;
}

export interface TrackRecord {
  updatedAt: string;
  totalIdeas: number;
  scored: number;
  winners: number;
  losers: number;
  hitRate: number | null;
  avgReturnPct: number | null;
  followedPnl: number | null;
  actedPnl: number | null;
  entries: TrackRecordEntry[];
}

export interface DecisionEntry {
  id: string;
  at: string;
  proposalId: string;
  tabId: string;
  tabTopic: string;
  symbol: string;
  side: "buy" | "sell";
  action: "approve" | "reject";
  paper: boolean;
  accountNumber: string | null;
  proposed: {
    quantity: number;
    orderType: "market" | "limit";
    limitPrice: number | null;
    confidence: number;
    thesis: string;
    whyNow: string;
    stop: number | null;
    target: number | null;
    entryPrice: number | null;
  };
  executed: {
    quantity: number;
    orderType: "market" | "limit";
    limitPrice: number | null;
    modified: boolean;
    fillPrice: number | null;
  } | null;
  outcome: "approved" | "rejected" | "failed";
  error: string | null;
}

// ---- Strategy / backtest ----
// The condition DSL the sidecar evaluates (mirrors backtest.ts). Typed here so the
// rule renderer reads a real shape instead of probing an `unknown`.
export type Operand =
  | number
  | { const: number }
  | { price: "open" | "high" | "low" | "close" }
  | { sma: number }
  | { ema: number }
  | { rsi: number }
  | { atr: number }
  | { returns: number }
  | { pctFromHigh: number }
  | { pctFromLow: number }
  | { volume: true };

export type Comparison = {
  lhs: Operand;
  op: ">" | "<" | ">=" | "<=" | "crossesAbove" | "crossesBelow";
  rhs: Operand;
};

export type ExitPrimitive =
  | { trailingStop: number }
  | { stopLoss: number }
  | { takeProfit: number }
  | { maxHoldBars: number };

export type Condition =
  | Comparison
  | ExitPrimitive
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

export interface StrategySpec {
  version: 1;
  universe: string[];
  direction: "long" | "short";
  entry: Condition;
  exit: Condition;
  sizing: { type: "equityPct" | "fixedShares" | "fixedNotional"; value: number };
  cooldownBars: number;
  maxPositions: number;
  llmGate: { mode: "off" | "live-only"; prompt: string } | null;
  live?: boolean;
  notes?: string;
}

export interface StrategyGetResponse {
  raw: unknown;
  spec: StrategySpec | null;
  error: string | null;
  markdown: string | null;
  live: boolean;
  verification: VerificationReport | null;
  /** True when the persisted verdict no longer matches the current rules/engine. */
  stale: boolean;
}

export type Grade = "untested" | "fragile" | "holds-up" | "diverged";

export interface VerificationCheck {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail" | "info";
  headline: string;
  detail: string;
  metric?: number;
}

export interface VerificationReport {
  ok: true;
  grade: Grade;
  specHash: string;
  engineHash: string;
  verifiedAt: string;
  checks: VerificationCheck[];
  baseline: { ownUniverseReturnPct: number | null; spyReturnPct: number | null; beatsSpy: boolean };
  tradeCount: number;
  exposurePct: number;
  backtestWinRatePct: number;
  permutationP: number | null;
  minTrl: number | null;
  trials: { counted: number };
  dataQuality: { passed: boolean };
}

export interface VerificationError {
  ok: false;
  error: string;
}

export interface PredictionMarket {
  source: "polymarket" | "kalshi";
  id: string;
  question: string;
  probability: number | null;
  outcomes: { name: string; probability: number }[];
  volume: number | null;
  closeTime: string | null;
  url: string | null;
}

export interface PredictionSearchResult {
  query: string;
  markets: PredictionMarket[];
  sources: { polymarket: "ok" | "error"; kalshi: "ok" | "error" };
  updatedAt: string;
}

export interface LiveConsistency {
  tabId: string;
  n: number;
  realizedHitRate: number | null;
  realizedAvgReturnPct: number | null;
  expectedHitRate: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  verdict: "insufficient-data" | "consistent" | "diverged";
  detail: string;
}

export interface SegmentMetrics {
  label: string;
  startDate: string;
  endDate: string;
  startEquity: number;
  endEquity: number;
  totalReturnPct: number;
  cagrPct: number | null;
  maxDrawdownPct: number;
  sharpe: number | null;
  trades: number;
  winRatePct: number | null;
  exposurePct: number;
}

export interface EquityPoint {
  date: string;
  equity: number;
  inSample: boolean;
}

export interface BacktestTrade {
  symbol: string;
  side: "long" | "short";
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  shares: number;
  pnl: number;
  returnPct: number;
}

export interface BacktestResult {
  ok: true;
  /** The compiled spec that produced this run (the UI reads it back after a run). */
  spec: StrategySpec;
  symbols: string[];
  bars: number;
  splitDate: string | null;
  initialEquity: number;
  finalEquity: number;
  equityCurve: EquityPoint[];
  overall: SegmentMetrics;
  inSample: SegmentMetrics;
  outOfSample: SegmentMetrics;
  trades: BacktestTrade[];
  warnings: string[];
}

export interface BacktestError {
  ok: false;
  error: string;
}

export interface ResearchEvent {
  tabId: string;
  kind: "run-started" | "activity" | "run-finished" | "run-error" | "findings-updated";
  text?: string;
}

export interface FeedLine {
  id: number;
  tabId: string;
  text: string;
  at: number;
}

export interface Position {
  kind: "equity" | "option" | "crypto";
  symbol: string;
  title?: string;
  side?: "call" | "put";
  strike?: number | null;
  expirationDate?: string | null;
  daysToExpiry?: number | null;
  quantity: number;
  averagePrice: number;
  currentPrice?: number;
  markPrice?: number | null;
  value: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  delta?: number | null;
  iv?: number | null;
}

export interface PortfolioSnapshot {
  accountNumber: string;
  equity: number;
  cash: number;
  invested: number;
  pnl: number;
  pnlPercent: number;
  dayPnl?: number;
  dayPnlPercent?: number;
  dayStartEquity?: number;
  dayStartAt?: number;
  pnlLabel?: string;
  previousClose: number;
  asOf: number;
}

export interface PortfolioHistoryPoint {
  time: number;
  equity: number;
  cash: number;
  invested: number;
  asOf: number;
}

export interface PortfolioHistory {
  accountNumber: string;
  range: string;
  source: "local";
  stale: boolean;
  asOf: number;
  warning?: string | null;
  points: PortfolioHistoryPoint[];
}

export interface AccountSnapshot {
  accountNumber: string;
  portfolio: PortfolioSnapshot;
  equities: Position[];
  options: Position[];
  crypto: Position[];
}

export interface MarketCandle {
  time: string;
  date?: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
}

export interface MarketHistory {
  symbol: string;
  yahooSymbol?: string | null;
  range: string;
  interval: string;
  source: "yahoo" | "cache" | "unavailable" | null;
  /** True when the candles are dividend/split (total-return) adjusted. */
  adjusted?: boolean;
  stale?: boolean;
  savedAt?: number | null;
  updatedAt?: string;
  candles?: MarketCandle[];
  points?: MarketCandle[];
  warning?: string | null;
}

export interface MarketEvent {
  id: string;
  type: "filing" | "news" | "expiry" | "agent" | "risk" | "option_expiration" | "option_near_expiry";
  severity: "info" | "low" | "medium" | "high";
  title: string;
  detail: string;
  description?: string;
  symbols: string[];
  symbol?: string;
  at: string;
  date?: string;
  source?: string;
  url?: string;
  details?: Record<string, unknown>;
}

export interface RiskSummary {
  updatedAt: string;
  grossExposure: number;
  netDeltaDollars: number;
  cash: number;
  topExposures: Array<{
    symbol: string;
    value: number;
    deltaDollars: number;
    share: number;
    kind: string;
  }>;
  scenarios: Array<{ label: string; move: number; pnl: number }>;
  warnings: Array<{ title: string; detail: string; severity: "info" | "low" | "medium" | "high" }>;
}

export interface OptionContract {
  symbol: string;
  expirationDate: string;
  strike: number;
  optionType: "call" | "put";
  bid: number | null;
  ask: number | null;
  mark: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  iv: number | null;
  openInterest: number | null;
  volume: number | null;
}

export interface WatchlistItem {
  symbol: string;
  label: string | null;
  note: string;
  addedAt: string;
  updatedAt: string;
}

export interface MarketEventsResponse {
  updatedAt: string;
  accountNumber: string;
  windowDays: number;
  nearExpiryDays: number;
  events: MarketEvent[];
  placeholders: Array<{
    source: "filings" | "news";
    status: "unavailable";
    title: string;
    description: string;
    symbols: string[];
  }>;
}

export interface AccountRiskSummary extends RiskSummary {
  updatedAt: string;
  accountNumber: string;
  portfolio: Pick<PortfolioSnapshot, "equity" | "cash" | "invested" | "pnl" | "pnlPercent" | "asOf">;
  exposure: {
    grossPositionValue: number;
    equityValue: number;
    optionValue: number;
    cryptoValue: number;
    grossDeltaDollars: number;
    netDeltaDollars: number;
    cashPct: number;
    investedPct: number;
    optionsPct: number;
    betaSpy90Weighted: number | null;
  };
  flags: Array<{
    level: "info" | "medium" | "high";
    code: string;
    message: string;
    details: Record<string, unknown>;
  }>;
  concentration?: {
    largestWeight: number;
    herfindahl: number;
    topPositions: Array<{
      symbol: string;
      kind: Position["kind"];
      title: string | null;
      quantity: number;
      value: number;
      weight: number;
      unrealizedPnl: number;
      daysToExpiry: number | null;
    }>;
  };
  options?: {
    count: number;
    value: number;
    nearExpiryCount: number;
    nearExpiryDays: number;
    earliestExpiration: string | null;
    averageIv: number | null;
  };
  correlation?: {
    method: string;
    measuredPct: number;
    avgCorrWeighted: number;
    grossExposure: number;
    clusters: Array<{ label: string; symbols: string[]; value: number; share: number; avgCorr: number }>;
    topEdges: Array<{
      a: string;
      b: string;
      corr: number;
      source: "measured" | "estimated";
      observations: number;
      riskContribution: number;
    }>;
    insight: string;
  };
}

type EventHandler = (event: string, payload: any) => void;
type OpenWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const LOCAL_ENDPOINT = "ws://127.0.0.1:4517";

/** Where the UI connects: the local sidecar, or a cloud sidecar (always-on). */
export function getEndpoint(): { url: string; cloud: boolean } {
  const host = localStorage.getItem("moobot.cloud.host"); // e.g. moobot-sidecar.fly.dev
  const token = localStorage.getItem("moobot.cloud.token");
  if (host && token) {
    return { url: `wss://${host}/?token=${encodeURIComponent(token)}`, cloud: true };
  }
  return { url: LOCAL_ENDPOINT, cloud: false };
}

function getLocalEndpoint(): { url: string; cloud: boolean } {
  return { url: LOCAL_ENDPOINT, cloud: false };
}

export function setCloudEndpoint(host: string, token: string) {
  localStorage.setItem("moobot.cloud.host", host.replace(/^wss?:\/\//, "").replace(/\/.*$/, ""));
  localStorage.setItem("moobot.cloud.token", token);
}

export function clearCloudEndpoint() {
  localStorage.removeItem("moobot.cloud.host");
  localStorage.removeItem("moobot.cloud.token");
}

class SidecarClient {
  private ws: WebSocket | null = null;
  private forceLocal = false;
  private nextId = 1;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private openWaiters = new Set<OpenWaiter>();
  private listeners = new Set<EventHandler>();
  private connListeners = new Set<(up: boolean) => void>();
  connected = false;
  cloud = false;

  start() {
    if (this.ws) return;
    this.connect();
  }

  /** Reconnect to a freshly-changed endpoint. */
  reconnect() {
    this.forceLocal = false;
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
    this.connect();
  }

  private connect() {
    const endpoint = this.forceLocal ? getLocalEndpoint() : getEndpoint();
    const { url, cloud } = endpoint;
    this.cloud = cloud;
    const ws = new WebSocket(url);
    let opened = false;
    this.ws = ws;
    ws.onopen = () => {
      opened = true;
      this.connected = true;
      for (const l of this.connListeners) l(true);
      for (const waiter of [...this.openWaiters]) waiter.resolve();
    };
    ws.onclose = () => {
      this.connected = false;
      for (const l of this.connListeners) l(false);
      for (const { reject } of this.pending.values())
        reject(new Error("sidecar disconnected"));
      this.pending.clear();
      this.ws = null;
      if (cloud && !opened && getEndpoint().cloud) {
        this.forceLocal = true;
        setTimeout(() => this.connect(), 150);
        return;
      }
      setTimeout(() => this.connect(), 1000);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (m) => {
      let msg: any;
      try {
        msg = JSON.parse(m.data);
      } catch {
        return;
      }
      if (msg.type === "event") {
        for (const l of this.listeners) l(msg.event, msg.payload);
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new Error(msg.error));
    };
  }

  request<T = any>(type: string, payload?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        void this.waitForOpen()
          .then(() => this.sendRequest<T>(type, payload, resolve, reject))
          .catch(reject);
        return;
      }
      this.sendRequest<T>(type, payload, resolve, reject);
    });
  }

  private waitForOpen(timeoutMs = 7000): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (!this.ws) this.start();

    return new Promise((resolve, reject) => {
      const waiter: OpenWaiter = {
        resolve: () => {
          clearTimeout(waiter.timeout);
          this.openWaiters.delete(waiter);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(waiter.timeout);
          this.openWaiters.delete(waiter);
          reject(error);
        },
        timeout: setTimeout(() => {
          this.openWaiters.delete(waiter);
          reject(new Error("sidecar not connected"));
        }, timeoutMs),
      };

      this.openWaiters.add(waiter);
    });
  }

  private sendRequest<T>(
    type: string,
    payload: unknown,
    resolve: (value: T) => void,
    reject: (error: Error) => void,
  ) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      reject(new Error("sidecar not connected"));
      return;
    }

      const id = String(this.nextId++);
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, type, payload }));
  }

  onEvent(handler: EventHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  onConnection(handler: (up: boolean) => void): () => void {
    this.connListeners.add(handler);
    return () => this.connListeners.delete(handler);
  }
}

export const client = new SidecarClient();

export function fmtMoney(v: number | string | null | undefined): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "n/a";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}
