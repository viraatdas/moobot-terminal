import type { Bar } from "./backtest.ts";

/**
 * Input-data verification. Two engines agreeing on poisoned prices is not
 * verification — so before any backtest result is trusted, the price series
 * itself must pass these checks. A "fail" voids the result; a "warn" is surfaced
 * but does not block. Runs on the SAME Bar[] the backtest consumes.
 */
export type DataQualityFinding = {
  symbol: string;
  kind: "too-few-bars" | "non-positive-price" | "gap" | "zero-volume-run" | "unsorted" | "duplicate-date";
  severity: "fail" | "warn";
  date: string | null;
  message: string;
  pct?: number;
};

export type DataQualityResult = {
  passed: boolean; // false if any finding has severity "fail"
  findings: DataQualityFinding[];
};

// A single-bar close-to-close move beyond FAIL_GAP almost always means corrupt
// data or a split/dividend the source never adjusted — not a real session. After
// our total-return adjustment in market-data.ts these should be vanishingly rare,
// so a large residual gap is treated as a data fault, not a tradeable event.
const FAIL_GAP = 0.4; // 40%+ single-bar move => fail (e.g. an unadjusted 2:1 split is -50%)
const WARN_GAP = 0.25; // 25-40% => warn (earnings can do this; flag, don't block)
const MIN_BARS = 30;
const ZERO_VOL_RUN = 5; // >=5 consecutive zero-volume bars => illiquid/suspect

export function checkSeriesQuality(symbol: string, bars: Bar[]): DataQualityFinding[] {
  const findings: DataQualityFinding[] = [];
  if (bars.length < MIN_BARS) {
    findings.push({ symbol, kind: "too-few-bars", severity: "fail", date: null, message: `only ${bars.length} bars (need >=${MIN_BARS})` });
    return findings; // nothing else is meaningful on a tiny series
  }

  let zeroRun = 0;
  for (let i = 0; i < bars.length; i += 1) {
    const b = bars[i];
    // Non-positive or non-finite OHLC — a price the backtest cannot reason about.
    for (const [field, v] of [["open", b.open], ["high", b.high], ["low", b.low], ["close", b.close]] as const) {
      if (!Number.isFinite(v) || (v as number) <= 0) {
        findings.push({ symbol, kind: "non-positive-price", severity: "fail", date: b.date, message: `${field}=${v} on ${b.date}` });
      }
    }
    if (i > 0) {
      if (b.date < bars[i - 1].date) {
        findings.push({ symbol, kind: "unsorted", severity: "fail", date: b.date, message: `${b.date} follows ${bars[i - 1].date}` });
      } else if (b.date === bars[i - 1].date) {
        findings.push({ symbol, kind: "duplicate-date", severity: "fail", date: b.date, message: `duplicate bar for ${b.date}` });
      }
      const prev = bars[i - 1].close;
      if (Number.isFinite(prev) && prev > 0 && Number.isFinite(b.close) && b.close > 0) {
        const move = Math.abs(b.close / prev - 1);
        if (move >= FAIL_GAP) {
          findings.push({ symbol, kind: "gap", severity: "fail", date: b.date, pct: move * 100, message: `${(move * 100).toFixed(0)}% single-bar move on ${b.date} — likely unadjusted split or corrupt data` });
        } else if (move >= WARN_GAP) {
          findings.push({ symbol, kind: "gap", severity: "warn", date: b.date, pct: move * 100, message: `${(move * 100).toFixed(0)}% single-bar move on ${b.date}` });
        }
      }
    }
    if (Number.isFinite(b.volume) && b.volume === 0) {
      zeroRun += 1;
      if (zeroRun === ZERO_VOL_RUN) {
        findings.push({ symbol, kind: "zero-volume-run", severity: "warn", date: b.date, message: `>=${ZERO_VOL_RUN} consecutive zero-volume bars ending ${b.date}` });
      }
    } else {
      zeroRun = 0;
    }
  }
  return findings;
}

export function checkDataQuality(history: Map<string, Bar[]>): DataQualityResult {
  const findings: DataQualityFinding[] = [];
  for (const [symbol, bars] of history) findings.push(...checkSeriesQuality(symbol, bars));
  return { passed: !findings.some((f) => f.severity === "fail"), findings };
}
