import type { BacktestResult } from "./backtest.ts";

/**
 * Cheap, always-valid sanity checks on a single backtest result, surfaced through
 * the warnings channel when options.selfCheck is on. These catch NaN equity, sign
 * errors, and impossible metrics on EVERY run.
 *
 * The heavier metamorphic checks that actually catch the short-accounting sign-bug
 * class — always-in-market == buy-and-hold to the penny, long/short mirror
 * symmetry, and zero-cost sum(trade.pnl) == finalEquity - initialEquity — require
 * running multiple controlled backtests, so they live in test/engine.test.ts (which
 * can import runBacktest without the circular dependency this module must avoid).
 */
export function selfCheckResult(result: BacktestResult): string[] {
  const w: string[] = [];
  const EPS = 1e-6;

  // 1. The equity curve must be finite throughout — a NaN/Infinity means an
  //    accounting path produced garbage (e.g. divide-by-zero in sizing).
  for (const p of result.equityCurve) {
    if (!Number.isFinite(p.equity)) {
      w.push(`non-finite equity at ${p.date}`);
      break;
    }
  }

  // 2. Drawdown is a non-negative fraction; a negative or NaN drawdown is a bug.
  const segs: [string, number][] = [
    ["overall", result.overall.maxDrawdownPct],
    ["in-sample", result.inSample.maxDrawdownPct],
    ["out-of-sample", result.outOfSample.maxDrawdownPct],
  ];
  for (const [name, dd] of segs) {
    if (!Number.isFinite(dd) || dd < -EPS) w.push(`invalid ${name} maxDrawdownPct=${dd}`);
  }

  // 3. Per-trade: costs can only REDUCE pnl below gross, and returnPct must share
  //    the sign of gross. A short whose gross/pnl/returnPct disagree is exactly the
  //    sign-bug signature.
  for (const t of result.trades) {
    if (!(t.shares > 0)) {
      w.push(`non-positive shares in trade ${t.symbol} ${t.entryDate}`);
      continue;
    }
    const gross = (t.side === "long" ? t.exitPrice - t.entryPrice : t.entryPrice - t.exitPrice) * t.shares;
    if (t.pnl > gross + Math.abs(gross) * 1e-9 + EPS) {
      w.push(`trade pnl ${t.pnl.toFixed(2)} exceeds gross ${gross.toFixed(2)} (${t.symbol} ${t.entryDate})`);
    }
    if (Math.abs(gross) > EPS && Math.sign(t.returnPct) !== Math.sign(gross)) {
      w.push(`returnPct sign != gross sign (${t.symbol} ${t.entryDate})`);
    }
  }

  // 4. finalEquity must equal the last point of the equity curve it was derived from.
  const lastEq = result.equityCurve[result.equityCurve.length - 1]?.equity;
  if (lastEq !== undefined && Math.abs(lastEq - result.finalEquity) > 0.01) {
    w.push(`finalEquity ${result.finalEquity} != last curve point ${lastEq}`);
  }

  return w;
}
