import type { TradeProposal } from "./proposals.ts";

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
  /** Side-adjusted % move from entry (a "winning" idea is always positive). */
  returnPct: number | null;
  /** returnPct expressed as dollars on the proposed size. */
  pnl: number | null;
}

export interface TrackRecord {
  updatedAt: string;
  totalIdeas: number;
  scored: number;
  winners: number;
  losers: number;
  /** Fraction of scored ideas that moved the proposed direction. */
  hitRate: number | null;
  avgReturnPct: number | null;
  /** P&L if you'd followed EVERY proposal at its entry price. */
  followedPnl: number | null;
  /** P&L on just the proposals you actually approved. */
  actedPnl: number | null;
  entries: TrackRecordEntry[];
}

/** Live-vs-backtest reconciliation for one strategy lens — the only verification
 * layer the LLM cannot retrofit by re-authoring against the report card. */
export interface LiveConsistency {
  tabId: string;
  /** Acted, scored proposals attributed to the live spec hash. */
  n: number;
  realizedHitRate: number | null;
  realizedAvgReturnPct: number | null;
  expectedHitRate: number | null; // backtest win-rate as a fraction
  ciLow: number | null;
  ciHigh: number | null;
  verdict: "insufficient-data" | "consistent" | "diverged";
  detail: string;
}

// 20 keeps the 95% binomial CI tight enough (~±22%) to actually catch a realistic
// win-rate degradation; at 10 the band is so wide nothing trips "diverged".
const MIN_LIVE_SAMPLE = 20;

// The side-adjusted fractional move from entry, marked at `current`. Entry is the
// actual fill price when the proposal was acted on, else the captured idea price.
// This is the SINGLE definition of the correctness-critical sign rule (a wrong flip
// would mislabel winners as losers AND misgate capital), shared by compute() and
// liveConsistency(). NOTE: `current` is a live quote, so this is an UNREALIZED mark
// — the position may still be open.
function markedReturn(p: TradeProposal, current: number | null): { entryPrice: number | null; raw: number | null } {
  const entryPrice = (p.execution?.fillPrice != null ? p.execution.fillPrice : null) ?? p.entryPrice;
  if (entryPrice == null || entryPrice <= 0 || current == null) return { entryPrice, raw: null };
  const raw = (current - entryPrice) / entryPrice;
  return { entryPrice, raw: p.side === "buy" ? raw : -raw };
}

export class TrackRecordService {
  private getProposals: () => TradeProposal[];
  private quotes: (symbols: string[]) => Promise<Map<string, number>>;

  constructor(
    getProposals: () => TradeProposal[],
    quotes: (symbols: string[]) => Promise<Map<string, number>>,
  ) {
    this.getProposals = getProposals;
    this.quotes = quotes;
  }

  async compute(): Promise<TrackRecord> {
    const proposals = this.getProposals();
    let prices = new Map<string, number>();
    try {
      prices = await this.quotes(proposals.map((p) => p.symbol));
    } catch {
      prices = new Map();
    }

    const entries: TrackRecordEntry[] = proposals.map((p) => {
      const acted = p.status === "approved";
      const currentPrice = prices.get(p.symbol) ?? null;
      const quantity = p.execution?.quantity ?? p.quantity;
      const { entryPrice, raw } = markedReturn(p, currentPrice);
      // raw is side-adjusted, so pnl = raw * entry * qty for both long and short.
      const returnPct = raw == null ? null : raw * 100;
      const pnl = raw == null || entryPrice == null ? null : raw * entryPrice * quantity;
      return {
        id: p.id,
        symbol: p.symbol,
        side: p.side,
        tabTopic: p.tabTopic,
        confidence: p.confidence,
        createdAt: p.createdAt,
        status: p.status,
        acted,
        paper: p.execution?.paper ?? null,
        quantity,
        entryPrice,
        currentPrice,
        returnPct,
        pnl,
      };
    });

    const scoredEntries = entries.filter((e) => e.returnPct != null);
    const winners = scoredEntries.filter((e) => (e.returnPct ?? 0) > 0).length;
    const losers = scoredEntries.filter((e) => (e.returnPct ?? 0) < 0).length;
    const avgReturnPct = scoredEntries.length
      ? scoredEntries.reduce((sum, e) => sum + (e.returnPct ?? 0), 0) / scoredEntries.length
      : null;
    const followedPnl = scoredEntries.length
      ? scoredEntries.reduce((sum, e) => sum + (e.pnl ?? 0), 0)
      : null;
    const actedScored = scoredEntries.filter((e) => e.acted);
    const actedPnl = actedScored.length
      ? actedScored.reduce((sum, e) => sum + (e.pnl ?? 0), 0)
      : null;

    return {
      updatedAt: new Date().toISOString(),
      totalIdeas: entries.length,
      scored: scoredEntries.length,
      winners,
      losers,
      hitRate: scoredEntries.length ? winners / scoredEntries.length : null,
      avgReturnPct,
      followedPnl,
      actedPnl,
      entries: entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    };
  }

  /**
   * Compare a live strategy's results so far against what its backtest predicted.
   * Each acted proposal is marked to its CURRENT price (an UNREALIZED mark — the
   * position may still be open), and the share of positive marks is compared to the
   * backtest win-rate. A realized share outside the binomial CI => "diverged"
   * (re-gates real capital; never auto-flattens). Thin samples read
   * "insufficient-data" rather than a flattering "on-track".
   *
   * Because marks are unrealized this is an APPROXIMATE reconciliation, not a
   * closed-trade comparison; it errs toward gating (blocking new entries) when live
   * and backtest disagree, which is the safe direction. A true round-trip
   * reconciliation would need per-proposal exit tracking the queue does not yet keep.
   */
  async liveConsistency(
    tabId: string,
    expectedWinRatePct: number | null,
    specHash: string | null,
  ): Promise<LiveConsistency> {
    // Require EXACT spec attribution: only fills from the currently-verified rules
    // count. Without a spec hash (no verification) nothing matches, so the verdict
    // is "insufficient-data" rather than silently mixing in manual/old-spec trades.
    const acted = this.getProposals().filter(
      (p) => p.tabId === tabId && p.status === "approved" && specHash != null && p.strategySpecHash === specHash,
    );
    let prices = new Map<string, number>();
    try {
      prices = await this.quotes(acted.map((p) => p.symbol));
    } catch {
      prices = new Map();
    }
    const returns: number[] = [];
    for (const p of acted) {
      const cur = prices.get(p.symbol) ?? null;
      const { raw } = markedReturn(p, cur);
      if (raw != null) returns.push(raw);
    }
    const n = returns.length;
    const base = {
      tabId,
      n,
      realizedHitRate: n ? returns.filter((r) => r > 0).length / n : null,
      realizedAvgReturnPct: n ? (returns.reduce((a, b) => a + b, 0) / n) * 100 : null,
      expectedHitRate: expectedWinRatePct == null ? null : expectedWinRatePct / 100,
    };
    if (n < MIN_LIVE_SAMPLE || base.expectedHitRate == null) {
      return {
        ...base,
        ciLow: null,
        ciHigh: null,
        verdict: "insufficient-data",
        detail:
          n < MIN_LIVE_SAMPLE
            ? `only ${n} marked live trades — need ${MIN_LIVE_SAMPLE} before reconciling`
            : "no backtest win-rate to compare against (verify first)",
      };
    }
    // 95% binomial CI on the proportion under H0 = backtest win-rate.
    const p = base.expectedHitRate;
    const se = Math.sqrt((p * (1 - p)) / n);
    const ciLow = Math.max(0, p - 1.96 * se);
    const ciHigh = Math.min(1, p + 1.96 * se);
    const realized = base.realizedHitRate ?? 0;
    const diverged = realized < ciLow || realized > ciHigh;
    return {
      ...base,
      ciLow,
      ciHigh,
      verdict: diverged ? "diverged" : "consistent",
      detail: diverged
        ? `realized hit-rate ${(realized * 100).toFixed(0)}% is outside the backtest's expected ${(ciLow * 100).toFixed(0)}-${(ciHigh * 100).toFixed(0)}% — live no longer matches the backtest`
        : `realized hit-rate ${(realized * 100).toFixed(0)}% is within the backtest's expected ${(ciLow * 100).toFixed(0)}-${(ciHigh * 100).toFixed(0)}%`,
    };
  }
}
