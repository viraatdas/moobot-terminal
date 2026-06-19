// Strategy DSL + deterministic backtest engine.
//
// The "algorithm" a user co-authors with the LLM is a STRATEGY SPEC: concrete,
// computable rules. This file evaluates that spec — both here (historical
// replay) and, via the same condition evaluator, live. The LLM never decides
// trades here; it only compiled the rules, so a hindsight-aware model cannot
// leak future knowledge into the equity curve.

// Value imports of the verification helpers. They import only TYPES back from this
// file, so type-stripping erases the back-edge and there is no runtime cycle.
import { checkDataQuality } from "./data-quality.ts";
import { selfCheckResult } from "./invariants.ts";

export type Bar = {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

// ---- DSL ------------------------------------------------------------------

// An operand resolves to a number at a given bar.
export type Operand =
  | number
  | { const: number }
  | { price: "open" | "high" | "low" | "close" }
  | { sma: number }
  | { ema: number }
  | { rsi: number }
  | { atr: number }
  | { returns: number } // % return over N bars
  | { pctFromHigh: number } // % below the trailing N-bar high (negative = below)
  | { pctFromLow: number } // % above the trailing N-bar low
  | { volume: true };

export type Comparison = {
  lhs: Operand;
  op: ">" | "<" | ">=" | "<=" | "crossesAbove" | "crossesBelow";
  rhs: Operand;
};

// Position-relative exit primitives (only valid inside `exit`).
export type ExitPrimitive =
  | { trailingStop: number } // % off the best price since entry
  | { stopLoss: number } // % off entry
  | { takeProfit: number } // % off entry
  | { maxHoldBars: number };

export type Condition =
  | Comparison
  | ExitPrimitive
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

export type Sizing = {
  type: "equityPct" | "fixedShares" | "fixedNotional";
  value: number;
};

export type StrategySpec = {
  version: 1;
  universe: string[];
  direction: "long" | "short";
  entry: Condition;
  exit: Condition;
  sizing: Sizing;
  cooldownBars: number;
  maxPositions: number;
  llmGate: { mode: "off" | "live-only"; prompt: string } | null;
  live?: boolean;
  /** Live-only: fill fractional shares (small accounts / pricey names). The backtest
   * always sizes whole shares regardless, so verification is unaffected. */
  fractional?: boolean;
  notes?: string;
};

export type BacktestOptions = {
  initialEquity?: number;
  commissionPerTrade?: number;
  slippageBps?: number; // basis points applied against you on each fill
  inSampleFraction?: number; // 0..1 — first fraction is in-sample
  selfCheck?: boolean; // run data-quality + result invariants, surfacing issues in warnings
};

// Coerce market-history candles (close required, OHLV nullable) into clean bars.
export function candlesToBars(
  candles: { date: string; open: number | null; high: number | null; low: number | null; close: number; volume: number | null }[],
): Bar[] {
  return candles
    .filter((c) => Number.isFinite(c.close))
    .map((c) => ({
      date: c.date,
      open: Number.isFinite(c.open as number) ? (c.open as number) : c.close,
      high: Number.isFinite(c.high as number) ? (c.high as number) : c.close,
      low: Number.isFinite(c.low as number) ? (c.low as number) : c.close,
      close: c.close,
      volume: Number.isFinite(c.volume as number) ? (c.volume as number) : 0,
    }));
}

// Lenient parse/normalize of an agent-authored strategy.json into a clean spec.
// The condition trees are passed through as-is; the evaluator treats anything it
// doesn't understand as false/null, so a malformed rule fails safe.
export function parseSpec(raw: unknown): StrategySpec | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "strategy.json is not an object" };
  const r = raw as Record<string, any>;
  const universe = Array.isArray(r.universe)
    ? [...new Set(r.universe.map((s: any) => String(s).toUpperCase().trim()).filter(Boolean))]
    : [];
  if (!universe.length) return { error: "strategy has an empty universe" };
  if (!r.entry || typeof r.entry !== "object") return { error: "strategy is missing an entry condition" };
  if (!r.exit || typeof r.exit !== "object") return { error: "strategy is missing an exit condition" };
  if (r.direction !== undefined && r.direction !== "long" && r.direction !== "short")
    return { error: `strategy has an invalid direction "${r.direction}" (must be "long" or "short")` };
  const direction = r.direction === "short" ? "short" : "long";
  const sizingType = ["equityPct", "fixedShares", "fixedNotional"].includes(r.sizing?.type)
    ? r.sizing.type
    : "equityPct";
  const sizingValue = Number(r.sizing?.value);
  const sizing: Sizing = {
    type: sizingType,
    value: Number.isFinite(sizingValue) && sizingValue > 0 ? sizingValue : 10,
  };
  const cooldownBars = Number.isFinite(Number(r.cooldownBars)) ? Math.max(0, Math.floor(Number(r.cooldownBars))) : 0;
  const maxPositions =
    Number.isFinite(Number(r.maxPositions)) && Number(r.maxPositions) > 0
      ? Math.floor(Number(r.maxPositions))
      : universe.length;
  let llmGate: StrategySpec["llmGate"] = null;
  if (r.llmGate && typeof r.llmGate === "object" && r.llmGate.mode === "live-only") {
    llmGate = { mode: "live-only", prompt: String(r.llmGate.prompt ?? "") };
  }
  return {
    version: 1,
    universe: universe.slice(0, 12),
    direction,
    entry: r.entry,
    exit: r.exit,
    sizing,
    cooldownBars,
    maxPositions,
    llmGate,
    live: r.live === true,
    fractional: r.fractional === true,
    notes: typeof r.notes === "string" ? r.notes : "",
  };
}

// ---- Indicators (pure) ----------------------------------------------------

function sma(close: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(close.length).fill(null);
  let sum = 0;
  for (let i = 0; i < close.length; i += 1) {
    sum += close[i];
    if (i >= n) sum -= close[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function ema(close: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(close.length).fill(null);
  const k = 2 / (n + 1);
  let prev: number | null = null;
  for (let i = 0; i < close.length; i += 1) {
    if (i < n - 1) continue;
    if (prev === null) {
      let s = 0;
      for (let j = i - n + 1; j <= i; j += 1) s += close[j];
      prev = s / n;
    } else {
      prev = close[i] * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
}

function rsi(close: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(close.length).fill(null);
  if (close.length <= n) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i += 1) {
    const d = close[i] - close[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / n;
  let avgLoss = loss / n;
  out[n] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = n + 1; i < close.length; i += 1) {
    const d = close[i] - close[i - 1];
    const g = d >= 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (n - 1) + g) / n;
    avgLoss = (avgLoss * (n - 1) + l) / n;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function atr(bars: Bar[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  if (bars.length <= n) return out;
  const tr: number[] = new Array(bars.length).fill(0);
  for (let i = 0; i < bars.length; i += 1) {
    if (i === 0) {
      tr[i] = bars[i].high - bars[i].low;
      continue;
    }
    const pc = bars[i - 1].close;
    tr[i] = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - pc), Math.abs(bars[i].low - pc));
  }
  let prev = 0;
  for (let i = 1; i <= n; i += 1) prev += tr[i];
  prev /= n;
  out[n] = prev;
  for (let i = n + 1; i < bars.length; i += 1) {
    prev = (prev * (n - 1) + tr[i]) / n;
    out[i] = prev;
  }
  return out;
}

function rollingHigh(high: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(high.length).fill(null);
  for (let i = 0; i < high.length; i += 1) {
    if (i < n - 1) continue;
    let m = -Infinity;
    for (let j = i - n + 1; j <= i; j += 1) m = Math.max(m, high[j]);
    out[i] = m;
  }
  return out;
}

function rollingLow(low: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(low.length).fill(null);
  for (let i = 0; i < low.length; i += 1) {
    if (i < n - 1) continue;
    let m = Infinity;
    for (let j = i - n + 1; j <= i; j += 1) m = Math.min(m, low[j]);
    out[i] = m;
  }
  return out;
}

// Per-symbol precomputed indicator series, lazily built and cached by key.
export class SeriesContext {
  readonly bars: Bar[];
  readonly close: number[];
  readonly high: number[];
  readonly low: number[];
  private cache = new Map<string, (number | null)[]>();

  constructor(bars: Bar[]) {
    this.bars = bars;
    this.close = bars.map((b) => b.close);
    this.high = bars.map((b) => b.high);
    this.low = bars.map((b) => b.low);
  }

  private series(key: string, build: () => (number | null)[]): (number | null)[] {
    let v = this.cache.get(key);
    if (!v) {
      v = build();
      this.cache.set(key, v);
    }
    return v;
  }

  operand(op: Operand, i: number): number | null {
    if (typeof op === "number") return op;
    if ("const" in op) return op.const;
    if ("price" in op) return this.bars[i][op.price];
    if ("volume" in op) return this.bars[i].volume;
    if ("sma" in op) return this.series(`sma${op.sma}`, () => sma(this.close, op.sma))[i];
    if ("ema" in op) return this.series(`ema${op.ema}`, () => ema(this.close, op.ema))[i];
    if ("rsi" in op) return this.series(`rsi${op.rsi}`, () => rsi(this.close, op.rsi))[i];
    if ("atr" in op) return this.series(`atr${op.atr}`, () => atr(this.bars, op.atr))[i];
    if ("returns" in op) {
      const n = op.returns;
      if (i < n) return null;
      const past = this.close[i - n];
      return past > 0 ? ((this.close[i] - past) / past) * 100 : null;
    }
    if ("pctFromHigh" in op) {
      const hi = this.series(`rh${op.pctFromHigh}`, () => rollingHigh(this.high, op.pctFromHigh))[i];
      return hi && hi > 0 ? ((this.close[i] - hi) / hi) * 100 : null;
    }
    if ("pctFromLow" in op) {
      const lo = this.series(`rl${op.pctFromLow}`, () => rollingLow(this.low, op.pctFromLow))[i];
      return lo && lo > 0 ? ((this.close[i] - lo) / lo) * 100 : null;
    }
    return null;
  }
}

export type PositionView = {
  side: "long" | "short";
  entryPrice: number;
  barsHeld: number;
  best: number; // most favorable close since entry (high-water for long, low for short)
};

function compare(a: number | null, op: Comparison["op"], b: number | null, prevA: number | null, prevB: number | null): boolean {
  if (a === null || b === null) return false;
  switch (op) {
    case ">":
      return a > b;
    case "<":
      return a < b;
    case ">=":
      return a >= b;
    case "<=":
      return a <= b;
    case "crossesAbove":
      return prevA !== null && prevB !== null && prevA <= prevB && a > b;
    case "crossesBelow":
      return prevA !== null && prevB !== null && prevA >= prevB && a < b;
    default:
      return false;
  }
}

export function evalCondition(
  cond: Condition,
  ctx: SeriesContext,
  i: number,
  pos: PositionView | null,
): boolean {
  if ("all" in cond) return cond.all.every((c) => evalCondition(c, ctx, i, pos));
  if ("any" in cond) return cond.any.some((c) => evalCondition(c, ctx, i, pos));
  if ("not" in cond) return !evalCondition(cond.not, ctx, i, pos);

  // Position-relative exit primitives.
  if ("trailingStop" in cond) {
    if (!pos) return false;
    const price = ctx.bars[i].close;
    return pos.side === "long"
      ? price <= pos.best * (1 - cond.trailingStop / 100)
      : price >= pos.best * (1 + cond.trailingStop / 100);
  }
  if ("stopLoss" in cond) {
    if (!pos) return false;
    const price = ctx.bars[i].close;
    return pos.side === "long"
      ? price <= pos.entryPrice * (1 - cond.stopLoss / 100)
      : price >= pos.entryPrice * (1 + cond.stopLoss / 100);
  }
  if ("takeProfit" in cond) {
    if (!pos) return false;
    const price = ctx.bars[i].close;
    return pos.side === "long"
      ? price >= pos.entryPrice * (1 + cond.takeProfit / 100)
      : price <= pos.entryPrice * (1 - cond.takeProfit / 100);
  }
  if ("maxHoldBars" in cond) {
    return pos ? pos.barsHeld >= cond.maxHoldBars : false;
  }

  // Comparison.
  const cmp = cond as Comparison;
  const a = ctx.operand(cmp.lhs, i);
  const b = ctx.operand(cmp.rhs, i);
  const prevA = i > 0 ? ctx.operand(cmp.lhs, i - 1) : null;
  const prevB = i > 0 ? ctx.operand(cmp.rhs, i - 1) : null;
  return compare(a, cmp.op, b, prevA, prevB);
}

// ---- Backtest result ------------------------------------------------------

export type Trade = {
  symbol: string;
  side: "long" | "short";
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  shares: number;
  pnl: number;
  returnPct: number;
};

export type SegmentMetrics = {
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
};

export type EquityPoint = { date: string; equity: number; inSample: boolean };

export type BacktestResult = {
  ok: true;
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
  trades: Trade[];
  warnings: string[];
};

export type BacktestError = { ok: false; error: string };

// ---- Simulation -----------------------------------------------------------

type OpenPos = {
  symbol: string;
  side: "long" | "short";
  shares: number;
  entryPrice: number;
  entryDate: string;
  barsHeld: number;
  best: number;
};

function drawdown(curve: number[]): number {
  let peak = -Infinity;
  let maxDd = 0;
  for (const v of curve) {
    if (v > peak) peak = v;
    if (peak > 0) maxDd = Math.max(maxDd, (peak - v) / peak);
  }
  return maxDd * 100;
}

function annualizedSharpe(equity: number[]): number | null {
  if (equity.length < 3) return null;
  const rets: number[] = [];
  for (let i = 1; i < equity.length; i += 1) {
    if (equity[i - 1] > 0) rets.push(equity[i] / equity[i - 1] - 1);
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  const sd = Math.sqrt(variance);
  if (sd === 0) return null;
  return (mean / sd) * Math.sqrt(252);
}

function yearsBetween(a: string, b: string): number {
  const ms = Date.parse(b) - Date.parse(a);
  return ms > 0 ? ms / (365.25 * 24 * 3600 * 1000) : 0;
}

function segmentMetrics(
  label: string,
  points: EquityPoint[],
  trades: Trade[],
  exposureBars: number,
): SegmentMetrics {
  const startEquity = points[0]?.equity ?? 0;
  const endEquity = points[points.length - 1]?.equity ?? startEquity;
  const totalReturnPct = startEquity > 0 ? (endEquity / startEquity - 1) * 100 : 0;
  const years = points.length > 1 ? yearsBetween(points[0].date, points[points.length - 1].date) : 0;
  const cagrPct =
    years > 0 && startEquity > 0 ? ((endEquity / startEquity) ** (1 / years) - 1) * 100 : null;
  const closed = trades.length;
  const wins = trades.filter((t) => t.pnl > 0).length;
  return {
    label,
    startDate: points[0]?.date ?? "",
    endDate: points[points.length - 1]?.date ?? "",
    startEquity,
    endEquity,
    totalReturnPct,
    cagrPct,
    maxDrawdownPct: drawdown(points.map((p) => p.equity)),
    sharpe: annualizedSharpe(points.map((p) => p.equity)),
    trades: closed,
    winRatePct: closed ? (wins / closed) * 100 : null,
    exposurePct: points.length ? (exposureBars / points.length) * 100 : 0,
  };
}

export function runBacktest(
  spec: StrategySpec,
  history: Map<string, Bar[]>,
  options: BacktestOptions = {},
): BacktestResult | BacktestError {
  const initialEquity = options.initialEquity ?? 100_000;
  const commission = options.commissionPerTrade ?? 0;
  const slip = (options.slippageBps ?? 5) / 10_000;
  const inSampleFraction = Math.min(0.95, Math.max(0.05, options.inSampleFraction ?? 0.6));
  const selfCheck = options.selfCheck === true;
  const warnings: string[] = [];

  // Verify the INPUT before trusting any output — poisoned prices make a correct
  // engine produce confident garbage. Fails are surfaced (the P2 verify path will
  // hard-gate on them); for now they are loud warnings.
  if (selfCheck) {
    const dq = checkDataQuality(history);
    for (const f of dq.findings) warnings.push(`data-quality ${f.severity}: ${f.symbol} ${f.message}`);
  }

  const symbols = spec.universe.map((s) => s.toUpperCase()).filter((s) => (history.get(s)?.length ?? 0) > 0);
  if (symbols.length === 0) return { ok: false, error: "No price history for any symbol in the universe." };

  // Per-symbol series + date index.
  const ctx = new Map<string, SeriesContext>();
  const byDate = new Map<string, Map<string, number>>(); // symbol -> (date -> bar index)
  const allDates = new Set<string>();
  for (const sym of symbols) {
    const bars = history.get(sym)!;
    ctx.set(sym, new SeriesContext(bars));
    const idx = new Map<string, number>();
    for (let i = 0; i < bars.length; i += 1) {
      idx.set(bars[i].date, i);
      allDates.add(bars[i].date);
    }
    byDate.set(sym, idx);
  }
  const dates = [...allDates].sort();
  if (dates.length < 30) return { ok: false, error: "Not enough overlapping history to backtest (need ≥30 bars)." };

  const splitIndex = Math.floor(dates.length * inSampleFraction);
  const splitDate = dates[splitIndex] ?? null;

  let cash = initialEquity;
  const open = new Map<string, OpenPos>();
  const cooldown = new Map<string, number>(); // symbol -> bars remaining
  const trades: Trade[] = [];
  const equityCurve: EquityPoint[] = [];
  let exposureBars = 0;
  let inExposureBars = 0;
  let outExposureBars = 0;

  // Orders decided on bar d execute at the OPEN of the next available bar — no
  // lookahead. We carry intents between dates.
  type Intent = { symbol: string; action: "enter" | "exit" };
  let pending: Intent[] = [];

  const fillBuy = (price: number) => price * (1 + slip);
  const fillSell = (price: number) => price * (1 - slip);

  for (let d = 0; d < dates.length; d += 1) {
    const date = dates[d];
    const inSample = d < splitIndex;

    // 1. Execute intents queued from the previous bar, at today's open.
    for (const intent of pending) {
      const idx = byDate.get(intent.symbol)?.get(date);
      if (idx === undefined) continue;
      const bar = ctx.get(intent.symbol)!.bars[idx];
      if (intent.action === "exit") {
        const pos = open.get(intent.symbol);
        if (!pos) continue;
        const exitPrice = pos.side === "long" ? fillSell(bar.open) : fillBuy(bar.open);
        const gross = pos.side === "long" ? (exitPrice - pos.entryPrice) * pos.shares : (pos.entryPrice - exitPrice) * pos.shares;
        // Long: sell shares for exitPrice*shares. Short: buy-to-cover COSTS
        // exitPrice*shares (cash already booked the sale proceeds on entry).
        cash += (pos.side === "long" ? exitPrice : -exitPrice) * pos.shares;
        const pnl = gross - commission;
        trades.push({
          symbol: pos.symbol,
          side: pos.side,
          entryDate: pos.entryDate,
          exitDate: date,
          entryPrice: pos.entryPrice,
          exitPrice,
          shares: pos.shares,
          pnl,
          returnPct: pos.entryPrice > 0 ? (gross / (pos.entryPrice * pos.shares)) * 100 : 0,
        });
        open.delete(intent.symbol);
        cooldown.set(intent.symbol, spec.cooldownBars);
      } else if (intent.action === "enter") {
        if (open.has(intent.symbol) || open.size >= spec.maxPositions) continue;
        const entryPrice = spec.direction === "long" ? fillBuy(bar.open) : fillSell(bar.open);
        const equityNow = cash + markOpen(open, ctx, byDate, date);
        const shares = sizeOrder(spec.sizing, equityNow, entryPrice);
        if (shares <= 0) continue;
        cash -= (spec.direction === "long" ? entryPrice : -entryPrice) * shares + commission;
        open.set(intent.symbol, {
          symbol: intent.symbol,
          side: spec.direction,
          shares,
          entryPrice,
          entryDate: date,
          barsHeld: 0,
          best: bar.close,
        });
      }
    }
    pending = [];

    // 2. Update open-position bookkeeping (bars held, best price) for today.
    for (const pos of open.values()) {
      const idx = byDate.get(pos.symbol)?.get(date);
      if (idx === undefined) continue;
      const bar = ctx.get(pos.symbol)!.bars[idx];
      pos.barsHeld += 1;
      // Trailing stops watch the intrabar extreme — the high for longs, the low
      // for shorts — not just the close, or the stop fires later than intended.
      pos.best = pos.side === "long" ? Math.max(pos.best, bar.high) : Math.min(pos.best, bar.low);
    }

    // 3. Decide intents for the NEXT bar using only data up to today.
    for (const sym of symbols) {
      const idx = byDate.get(sym)?.get(date);
      if (idx === undefined) continue;
      const series = ctx.get(sym)!;
      const pos = open.get(sym);
      if (pos) {
        const view: PositionView = { side: pos.side, entryPrice: pos.entryPrice, barsHeld: pos.barsHeld, best: pos.best };
        if (evalCondition(spec.exit, series, idx, view)) pending.push({ symbol: sym, action: "exit" });
      } else {
        const cd = cooldown.get(sym) ?? 0;
        if (cd > 0) {
          cooldown.set(sym, cd - 1);
          continue;
        }
        if (open.size + pending.filter((p) => p.action === "enter").length >= spec.maxPositions) continue;
        if (evalCondition(spec.entry, series, idx, null)) pending.push({ symbol: sym, action: "enter" });
      }
    }

    // 4. Mark equity at today's close.
    const equity = cash + markOpen(open, ctx, byDate, date);
    if (open.size > 0) {
      exposureBars += 1;
      if (inSample) inExposureBars += 1;
      else outExposureBars += 1;
    }
    equityCurve.push({ date, equity, inSample });
  }

  const inPoints = equityCurve.filter((p) => p.inSample);
  const outPoints = equityCurve.filter((p) => !p.inSample);
  const inTrades = trades.filter((t) => splitDate === null || t.exitDate < splitDate);
  const outTrades = trades.filter((t) => splitDate !== null && t.exitDate >= splitDate);

  const result: BacktestResult = {
    ok: true,
    spec,
    symbols,
    bars: dates.length,
    splitDate,
    initialEquity,
    finalEquity: equityCurve[equityCurve.length - 1]?.equity ?? initialEquity,
    equityCurve,
    overall: segmentMetrics("overall", equityCurve, trades, exposureBars),
    inSample: segmentMetrics("in-sample", inPoints.length ? inPoints : equityCurve, inTrades, inExposureBars),
    outOfSample: segmentMetrics(
      "out-of-sample",
      outPoints.length ? outPoints : equityCurve.slice(-1),
      outTrades,
      outExposureBars,
    ),
    trades,
    warnings,
  };
  // warnings is the same array referenced by result.warnings, so pushing here
  // updates the returned result in place.
  if (selfCheck) warnings.push(...selfCheckResult(result));
  return result;
}

// The ONE sizing function. The live runtime imports this too, so a live entry can
// never size differently from the backtest. Note: equityPct with equity <= 0
// deterministically returns 0 (no fabricated fallback) — the caller skips the
// entry rather than sizing off a guessed account value.
export function sizeOrder(sizing: Sizing, equity: number, price: number, fractional = false): number {
  if (price <= 0) return 0;
  if (sizing.type === "fixedShares") return Math.max(0, Math.floor(sizing.value));
  const shares =
    sizing.type === "fixedNotional"
      ? sizing.value / price
      : ((equity * sizing.value) / 100) / price; // equityPct
  // Whole shares for the backtest (integer-exact fills the verification depends on);
  // fractional (to 4dp) for a live auto-trader on a small account, since the agentic
  // broker fills fractional and $100 of a $300 stock would otherwise floor to zero.
  return Math.max(0, fractional ? Math.floor(shares * 1e4) / 1e4 : Math.floor(shares));
}

function markOpen(
  open: Map<string, OpenPos>,
  ctx: Map<string, SeriesContext>,
  byDate: Map<string, Map<string, number>>,
  date: string,
): number {
  let value = 0;
  for (const pos of open.values()) {
    const idx = byDate.get(pos.symbol)?.get(date);
    const price = idx !== undefined ? ctx.get(pos.symbol)!.bars[idx].close : pos.entryPrice;
    // A long position is an asset (+price*shares); a short is a liability
    // (-price*shares). The short's sale proceeds already sit in cash, so total
    // equity = cash - price*shares correctly falls as the price rises.
    value += (pos.side === "long" ? price : -price) * pos.shares;
  }
  return value;
}
