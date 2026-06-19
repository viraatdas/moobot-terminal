import { runBacktest, type StrategySpec, type Bar, type BacktestOptions } from "./backtest.ts";

/**
 * Anti-self-deception statistics. Every estimator is GATED behind a hard
 * sample-size floor: below it they return null (rendered "not enough trades to
 * test"), never a precise-looking number on a handful of trades. The model-free
 * permutation test is the headline (it reuses the verified engine); the
 * parametric helpers are secondary and clearly approximate.
 */
export const TRADE_FLOOR = 20;

// The finest p-value the permutation test can resolve: p floors at 1/(iters+1).
// A Bonferroni threshold below this is mathematically unpassable, so the caller
// must bump iterations to meet it (and flag honestly when even the cap can't).
export function permutationResolution(iterations: number): number {
  return 1 / (iterations + 1);
}

// Standard-normal quantiles for common confidence levels (one-sided).
const Z_95 = 1.6448536269514722;

/**
 * Monte-Carlo permutation test. For each symbol it breaks the bar-to-bar serial
 * structure by shuffling daily returns, rebuilds a price path (scaling each bar's
 * OHLC by the new close ratio so high/low-based rules still see a coherent bar),
 * re-runs the SAME engine, and measures how often a structure-free world matches
 * or beats the observed result. p = (#{shuffled >= observed} + 1) / (N + 1).
 *
 * Returns null below the trade floor — a p-value on 12 trades is noise.
 */
export function permutationPValue(
  spec: StrategySpec,
  history: Map<string, Bar[]>,
  observedFinalEquity: number,
  tradeCount: number,
  opts: BacktestOptions & { iterations?: number } = {},
): number | null {
  if (tradeCount < TRADE_FLOOR) return null;
  const iterations = Math.max(50, Math.min(500, opts.iterations ?? 200));
  let atLeast = 0;
  for (let n = 0; n < iterations; n += 1) {
    const shuffled = new Map<string, Bar[]>();
    for (const [sym, bars] of history) shuffled.set(sym, shuffleReturns(bars));
    const r = runBacktest(spec, shuffled, opts);
    if (r.ok && r.finalEquity >= observedFinalEquity) atLeast += 1;
  }
  return (atLeast + 1) / (iterations + 1);
}

// Rebuild a bar series from its own daily returns in shuffled order. The price
// level changes but the *set* of one-day moves is identical — only the ordering
// (the exploitable structure) is destroyed.
function shuffleReturns(bars: Bar[]): Bar[] {
  if (bars.length < 2) return bars;
  const rets: number[] = [];
  for (let i = 1; i < bars.length; i += 1) {
    const prev = bars[i - 1].close;
    rets.push(prev > 0 ? bars[i].close / prev : 1);
  }
  // Fisher-Yates (Math.random is fine in the sidecar; only workflow scripts ban it).
  for (let i = rets.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [rets[i], rets[j]] = [rets[j], rets[i]];
  }
  const out: Bar[] = [{ ...bars[0] }];
  for (let i = 1; i < bars.length; i += 1) {
    const prevClose = out[i - 1].close;
    const newClose = prevClose * rets[i - 1];
    const ref = bars[i];
    const ratio = ref.close > 0 ? newClose / ref.close : 1;
    out.push({
      date: ref.date,
      open: ref.open * ratio,
      high: ref.high * ratio,
      low: ref.low * ratio,
      close: newClose,
      volume: ref.volume,
    });
  }
  return out;
}

/**
 * Minimum Track Record Length (Bailey & López de Prado): the number of return
 * observations needed before an observed Sharpe is distinguishable from zero at
 * the given confidence, adjusting for non-normality. Returned as a concrete
 * "trades needed" target, framed elsewhere as necessary-not-sufficient.
 *
 * Returns null below the floor or when the Sharpe is non-positive (nothing to
 * confirm). `perReturns` are per-trade returns (fractions).
 */
export function minTrackRecordLength(perReturns: number[], confidenceZ = Z_95): number | null {
  const n = perReturns.length;
  if (n < TRADE_FLOOR) return null;
  const mean = perReturns.reduce((a, b) => a + b, 0) / n;
  // Sample (n-1) std-dev — the unbiased estimator hypothesis testing requires;
  // dividing by n understates volatility and inflates the Sharpe.
  const sd = Math.sqrt(perReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  if (sd <= 0) return null;
  const sr = mean / sd; // per-trade Sharpe
  if (sr <= 0) return null;
  const m3 = perReturns.reduce((a, b) => a + ((b - mean) / sd) ** 3, 0) / (n - 1); // skew
  const m4 = perReturns.reduce((a, b) => a + ((b - mean) / sd) ** 4, 0) / (n - 1); // kurtosis
  // MinTRL = 1 + (1 - skew*SR + (EXCESS_kurt)/4 * SR^2) * (Z / SR)^2, where excess
  // kurtosis = m4 - 3 (m4 is the raw 4th moment, = 3 for a normal distribution).
  const minTrl = 1 + (1 - m3 * sr + ((m4 - 3) / 4) * sr * sr) * (confidenceZ / sr) ** 2;
  return Math.ceil(minTrl);
}
