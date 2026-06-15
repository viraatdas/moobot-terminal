import { candlesToBars, type Bar } from "./backtest.ts";
import type { MarketData } from "./market-data.ts";

/**
 * Canonical loader for strategy bars: the SAME 5y / 1d, total-return-adjusted
 * window that BOTH the backtest and the live runtime must evaluate on, with the
 * adjusted-only invariant enforced in exactly one place. This idiom was hand-copied
 * at three sites (the backtest/verify loader, the SPY baseline fetch, and the live
 * runtime loop); a tweak to one copy silently re-diverged live from the backtest —
 * the precise parity seam the strategy engine works hardest to keep identical.
 */
export async function loadStrategyBars(
  marketData: MarketData,
  symbols: string[],
  opts: { minBars?: number; sequential?: boolean } = {},
): Promise<Map<string, Bar[]>> {
  const minBars = opts.minBars ?? 1;
  const history = new Map<string, Bar[]>();
  const load = async (sym: string) => {
    try {
      const h = await marketData.history(sym, { range: "5y", interval: "1d" });
      if (!h.adjusted) return; // only total-return-adjusted data may drive a strategy
      const bars = candlesToBars(h.candles);
      if (bars.length >= minBars) history.set(sym.toUpperCase(), bars);
    } catch {
      /* symbol unavailable — skip */
    }
  };
  if (opts.sequential) {
    // The live runtime loads on a 3-min timer; the sequential for-await throttles
    // Yahoo's rate-limited chart API. Do NOT parallelize this path (it could change
    // which symbols resolve live vs fall back to stale cache).
    for (const sym of symbols) await load(sym);
  } else {
    await Promise.all(symbols.map(load));
  }
  return history;
}
