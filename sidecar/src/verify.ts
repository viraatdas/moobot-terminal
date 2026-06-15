import crypto from "node:crypto";
import { runBacktest, candlesToBars, type StrategySpec, type Bar } from "./backtest.ts";
import { checkDataQuality } from "./data-quality.ts";
import { permutationPValue, minTrackRecordLength, permutationResolution, TRADE_FLOOR } from "./trust-stats.ts";

export type Grade = "untested" | "fragile" | "holds-up" | "diverged";

export type VerificationCheck = {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail" | "info";
  headline: string; // plain-English meaning, not the raw metric
  detail: string;
  metric?: number;
};

export type VerificationReport = {
  ok: true;
  grade: Grade;
  specHash: string;
  engineHash: string;
  verifiedAt: string;
  checks: VerificationCheck[];
  baseline: { ownUniverseReturnPct: number | null; spyReturnPct: number | null; beatsSpy: boolean };
  tradeCount: number;
  exposurePct: number;
  backtestWinRatePct: number; // expected win-rate the live reconciliation compares against
  permutationP: number | null;
  minTrl: number | null;
  trials: { counted: number };
  dataQuality: { passed: boolean };
};

export type VerificationError = { ok: false; error: string };

const BASE_SLIP = 5;

// ── Spec hashing — verdicts are bound to the EXACT normalized rules ───────────
// Canonical JSON with sorted keys + sorted universe so semantically-identical
// specs hash identically and any changed numeric operand changes the hash.
export function canonicalSpecHash(spec: StrategySpec): string {
  const norm = {
    version: spec.version,
    universe: [...spec.universe].map((s) => s.toUpperCase()).sort(),
    direction: spec.direction,
    entry: canonicalizeCondition(spec.entry),
    exit: canonicalizeCondition(spec.exit),
    sizing: spec.sizing,
    cooldownBars: spec.cooldownBars,
    maxPositions: spec.maxPositions,
    llmGate: spec.llmGate ?? null,
  };
  return crypto.createHash("sha256").update(stableStringify(norm)).digest("hex").slice(0, 32);
}

// all/any are commutative, so sort their members — reordering conditions in the
// editor must NOT register as a rule change (false staleness → needless re-verify).
function canonicalizeCondition(c: any): any {
  if (!c || typeof c !== "object") return c;
  if (Array.isArray(c.all)) return { all: c.all.map(canonicalizeCondition).sort((a: any, b: any) => stableStringify(a).localeCompare(stableStringify(b))) };
  if (Array.isArray(c.any)) return { any: c.any.map(canonicalizeCondition).sort((a: any, b: any) => stableStringify(a).localeCompare(stableStringify(b))) };
  if (c.not) return { not: canonicalizeCondition(c.not) };
  return c;
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const keys = Object.keys(v as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

// ── Engine fingerprint — a BEHAVIORAL hash, bundle-safe ───────────────────────
// Hashing the source file fails inside the bundled sidecar.cjs, so instead we run
// fixed golden backtests and hash their outputs. If the engine's math changes (a
// bug introduced OR fixed), the golden outputs change, the hash changes, and every
// prior verdict goes stale — exactly the binding we want, in dev and in the bundle.
let cachedEngineHash: string | null = null;
export function engineHash(): string {
  if (cachedEngineHash) return cachedEngineHash;
  const flat = (prices: number[]): Bar[] => {
    const base = Date.UTC(2023, 0, 1);
    return prices.map((p, i) => ({ date: new Date(base + i * 86_400_000).toISOString().slice(0, 10), open: p, high: p, low: p, close: p, volume: 1000 }));
  };
  const pad = (a: number[]) => flat([...Array(25).fill(100), ...a]);
  const opt = { initialEquity: 100_000, commissionPerTrade: 0, slippageBps: 0, inSampleFraction: 0.95 };
  const fingerprints: number[] = [];
  for (const [dir, action] of [["long", [100, 90, 90, 110, 110, 110]], ["short", [100, 110, 110, 90, 90, 90]]] as const) {
    const r = runBacktest(
      {
        version: 1, universe: ["X"], direction: dir,
        entry: dir === "long" ? { lhs: { price: "close" }, op: "crossesBelow", rhs: 95 } : { lhs: { price: "close" }, op: "crossesAbove", rhs: 105 },
        exit: dir === "long" ? { lhs: { price: "close" }, op: "crossesAbove", rhs: 105 } : { lhs: { price: "close" }, op: "crossesBelow", rhs: 95 },
        sizing: { type: "fixedShares", value: 100 }, cooldownBars: 0, maxPositions: 1, llmGate: null,
      },
      new Map([["X", pad([...action])]]),
      opt,
    );
    fingerprints.push(r.ok ? Math.round(r.finalEquity * 100) : -1, r.ok ? r.trades.length : -1);
  }
  // Always-in long held to the end (exercises the open-position mark path).
  const held = runBacktest(
    { version: 1, universe: ["X"], direction: "long", entry: { lhs: { price: "close" }, op: ">", rhs: 0 }, exit: { lhs: { price: "close" }, op: "<", rhs: 0 }, sizing: { type: "fixedShares", value: 100 }, cooldownBars: 0, maxPositions: 1, llmGate: null },
    new Map([["X", flat(Array.from({ length: 40 }, (_, i) => 100 + i))]]),
    opt,
  );
  fingerprints.push(held.ok ? Math.round(held.finalEquity * 100) : -1);
  cachedEngineHash = crypto.createHash("sha256").update(fingerprints.join(",")).digest("hex").slice(0, 16);
  return cachedEngineHash;
}

// ── The real-capital gate — the SINGLE definition of "verified for real money" ─
// Every site that decides whether a strategy may take real capital (the UI badge,
// the go-live gate, the live trader) routes through this one predicate, so they
// can never drift. The async live-divergence check (liveConsistency) is kept OUT
// of here on purpose — it needs the track record and runs once per call site.
export type GateReason = "unverified" | "stale" | "data-quality" | "grade";

export function gateVerification(
  spec: StrategySpec,
  report: VerificationReport | null,
): { ok: boolean; stale: boolean; reason: GateReason | null } {
  if (!report) return { ok: false, stale: true, reason: "unverified" };
  const stale = report.specHash !== canonicalSpecHash(spec) || report.engineHash !== engineHash();
  if (stale) return { ok: false, stale: true, reason: "stale" };
  // grade === "holds-up" already implies dataQuality.passed (deriveGrade caps the
  // grade at "fragile" when data quality fails), so the data-quality branch is a
  // belt-and-suspenders guard that also yields a distinct, clearer message.
  if (!report.dataQuality?.passed) return { ok: false, stale: false, reason: "data-quality" };
  if (report.grade !== "holds-up") return { ok: false, stale: false, reason: "grade" };
  return { ok: true, stale: false, reason: null };
}

// ── Numeric-operand perturbation for parameter-sensitivity ────────────────────
const WINDOW_KEYS = new Set(["sma", "ema", "rsi", "atr", "returns", "pctFromHigh", "pctFromLow", "maxHoldBars"]);
function perturb(node: unknown, factor: number): unknown {
  if (Array.isArray(node)) return node.map((n) => perturb(n, factor));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (typeof v === "number" && WINDOW_KEYS.has(k)) out[k] = Math.max(1, Math.round(v * factor));
      else if (typeof v === "number") out[k] = v * factor;
      else out[k] = perturb(v, factor);
    }
    return out;
  }
  return node;
}
function perturbSpec(spec: StrategySpec, factor: number): StrategySpec {
  return { ...spec, entry: perturb(spec.entry, factor) as StrategySpec["entry"], exit: perturb(spec.exit, factor) as StrategySpec["exit"] };
}

function spyBuyHoldReturnPct(spyBars: Bar[], start: string, end: string): number | null {
  const win = spyBars.filter((b) => b.date >= start && b.date <= end);
  if (win.length < 2 || win[0].close <= 0) return null;
  // The SPY window must actually span the strategy's window, else we'd compare
  // returns over different periods and manufacture false out/under-performance.
  // Allow a few days of slack at each end (holidays/listing dates).
  const dayMs = 86_400_000;
  const gap = (a: string, b: string) => Math.abs(new Date(a).getTime() - new Date(b).getTime()) / dayMs;
  if (gap(win[0].date, start) > 5 || gap(win[win.length - 1].date, end) > 5) return null;
  return (win[win.length - 1].close / win[0].close - 1) * 100;
}

/**
 * Run the full robustness battery on a strategy spec, composing runBacktest (no
 * new math engine). Data-quality gates FIRST; the grade is the worst of the
 * checks; statistics are gated behind the trade floor. spyBars is the SPY series
 * for the index baseline (pass [] to skip that check).
 */
export function verifyStrategy(
  spec: StrategySpec,
  history: Map<string, Bar[]>,
  spyBars: Bar[],
  opts: { iterations?: number; variantsTried?: number } = {},
): VerificationReport | VerificationError {
  const iterations = opts.iterations ?? 200;
  const variantsTried = opts.variantsTried ?? 0;
  const checks: VerificationCheck[] = [];

  // L0 — data quality FIRST. A fail caps the grade at "fragile".
  const dq = checkDataQuality(history);
  const dqFails = dq.findings.filter((f) => f.severity === "fail");
  checks.push({
    id: "data-quality",
    label: "Input data",
    status: dq.passed ? "pass" : "fail",
    headline: dq.passed ? "Price data looks clean (split/dividend adjusted)" : `Input data failed quality checks — ${dqFails[0]?.message ?? "unexplained gap"}`,
    detail: dq.findings.map((f) => `${f.symbol}: ${f.message}`).join("; ") || "no issues",
  });

  const base = runBacktest(spec, history, { slippageBps: BASE_SLIP, inSampleFraction: 0.6, selfCheck: true });
  if (!base.ok) return { ok: false, error: base.error };

  const tradeCount = base.trades.length;
  const exposurePct = base.overall.exposurePct ?? 0;
  const start = base.equityCurve[0]?.date ?? "";
  const end = base.equityCurve[base.equityCurve.length - 1]?.date ?? "";
  const stratReturn = base.overall.totalReturnPct;
  const spyReturn = spyBars.length ? spyBuyHoldReturnPct(spyBars, start, end) : null;
  const beatsSpy = spyReturn === null ? false : stratReturn > spyReturn;

  // Out-of-sample positive.
  checks.push({
    id: "out-of-sample",
    label: "Out-of-sample",
    status: base.outOfSample.totalReturnPct > 0 ? "pass" : "fail",
    headline: base.outOfSample.totalReturnPct > 0 ? `Still profitable on held-out data (+${base.outOfSample.totalReturnPct.toFixed(1)}%)` : `Loses money on held-out data (${base.outOfSample.totalReturnPct.toFixed(1)}%) — likely overfit`,
    detail: `in-sample ${base.inSample.totalReturnPct.toFixed(1)}% vs out-of-sample ${base.outOfSample.totalReturnPct.toFixed(1)}%`,
    metric: base.outOfSample.totalReturnPct,
  });

  // Beats SPY.
  checks.push({
    id: "baseline",
    label: "vs SPY",
    status: spyReturn === null ? "info" : beatsSpy ? "pass" : "fail",
    headline: spyReturn === null ? "No SPY baseline available" : beatsSpy ? `Beats just-buy-SPY by ${(stratReturn - spyReturn).toFixed(0)} pts` : `Trails just-buy-SPY (${stratReturn.toFixed(0)}% vs ${spyReturn.toFixed(0)}%) — doing nothing was better`,
    detail: spyReturn === null ? "pass a SPY series to enable" : `strategy ${stratReturn.toFixed(1)}% vs SPY ${spyReturn.toFixed(1)}%`,
  });

  // Walk-forward across split points.
  const fracs = [0.5, 0.6, 0.7, 0.8];
  const oos = fracs.map((f) => runBacktest(spec, history, { slippageBps: BASE_SLIP, inSampleFraction: f })).map((r) => (r.ok ? r.outOfSample.totalReturnPct : 0));
  const oosPos = oos.filter((x) => x > 0).length;
  checks.push({
    id: "walk-forward",
    label: "Walk-forward",
    status: oosPos >= 3 ? "pass" : oosPos >= 2 ? "warn" : "fail",
    headline: `Edge holds in ${oosPos}/${fracs.length} forward windows`,
    detail: `out-of-sample returns at splits ${fracs.join("/")}: ${oos.map((x) => x.toFixed(0) + "%").join(", ")}`,
    metric: oosPos,
  });

  // Parameter sensitivity (+/-15%).
  const nudges = [0.85, 1.15].map((f) => runBacktest(perturbSpec(spec, f), history, { slippageBps: BASE_SLIP })).map((r) => (r.ok ? r.overall.totalReturnPct : -Infinity));
  const nudgePos = nudges.filter((x) => x > 0).length;
  checks.push({
    id: "param-robust",
    label: "Parameter nudge",
    status: nudgePos === nudges.length ? "pass" : nudgePos >= 1 ? "warn" : "fail",
    headline: nudgePos === nudges.length ? "Survives +/-15% parameter changes" : "A small parameter change breaks it — fragile fit",
    detail: `nudged returns: ${nudges.map((x) => (Number.isFinite(x) ? x.toFixed(0) + "%" : "n/a")).join(", ")}`,
  });

  // Cost stress (3x slippage).
  const stressed = runBacktest(spec, history, { slippageBps: BASE_SLIP * 3 });
  const stressReturn = stressed.ok ? stressed.overall.totalReturnPct : -Infinity;
  checks.push({
    id: "cost-stress",
    label: "3x costs",
    status: stressReturn > 0 ? "pass" : "fail",
    headline: stressReturn > 0 ? "Still profitable at 3x trading costs" : "3x trading costs wipe out the edge",
    detail: `return at 3x slippage: ${Number.isFinite(stressReturn) ? stressReturn.toFixed(1) + "%" : "n/a"}`,
    metric: stressReturn,
  });

  // Exposure / closet-index guard.
  checks.push({
    id: "exposure",
    label: "Exposure",
    status: exposurePct < 95 ? "pass" : "warn",
    headline: exposurePct < 95 ? `In the market ${exposurePct.toFixed(0)}% of days` : `Almost always invested (${exposurePct.toFixed(0)}%) — basically a closet index fund`,
    detail: `${exposurePct.toFixed(1)}% of days hold a position`,
    metric: exposurePct,
  });

  // Sample size floor.
  const enoughTrades = tradeCount >= TRADE_FLOOR;
  const perReturns = base.trades.map((t) => t.returnPct / 100);
  const minTrl = enoughTrades ? minTrackRecordLength(perReturns) : null;
  checks.push({
    id: "sample-size",
    label: "Sample size",
    status: enoughTrades ? "pass" : "warn",
    headline: enoughTrades ? `${tradeCount} trades — enough to test` : `Only ${tradeCount} trades — not enough to trust yet${minTrlNeed(minTrl, tradeCount)}`,
    detail: `trade floor is ${TRADE_FLOOR}`,
    metric: tradeCount,
  });

  // Bonferroni-adjust the threshold by the number of variants this lens has tried:
  // the agent re-authoring until one passes is the multiple-testing problem, so a
  // strategy survivor must clear a stricter bar the more shots were taken.
  const threshold = 0.05 / Math.max(1, variantsTried);
  // The permutation p-value floors at 1/(iters+1); a Bonferroni threshold below that
  // is unpassable. Bump iterations to make the threshold achievable (capped at the
  // engine's max). If even the cap can't resolve it, the test stays a CONSERVATIVE
  // fail but says WHY — never flipped to "info", which would let an impossible-region
  // strategy certify.
  const permIterations = Math.min(500, Math.max(iterations, Math.ceil(1 / threshold)));
  const achievable = threshold >= permutationResolution(permIterations);
  const permutationP = enoughTrades ? permutationPValue(spec, history, base.finalEquity, tradeCount, { slippageBps: BASE_SLIP, iterations: permIterations }) : null;
  checks.push({
    id: "permutation",
    label: "Luck test",
    status: permutationP === null ? "info" : !achievable ? "fail" : permutationP < threshold ? "pass" : "fail",
    headline:
      permutationP === null
        ? "Not enough trades to run the luck test"
        : !achievable
          ? `Too many variants tried (${variantsTried}) to clear the luck test at the permutation's resolution — reduce re-authoring before this can certify`
          : permutationP < threshold
            ? `Survives a return-shuffle — unlikely to be luck (p=${permutationP.toFixed(3)})`
            : `Indistinguishable from luck (p=${permutationP.toFixed(2)})`,
    detail: permutationP === null ? `needs >=${TRADE_FLOOR} trades` : `Monte-Carlo permutation, ${permIterations} shuffles${variantsTried > 1 ? `, Bonferroni threshold p<${threshold.toFixed(4)} for ${variantsTried} variants` : ""}`,
    metric: permutationP ?? undefined,
  });

  // ── Grade: worst-of, with data-quality and the floor as hard caps ──────────
  const grade = deriveGrade(checks, dq.passed, enoughTrades);

  return {
    ok: true,
    grade,
    specHash: canonicalSpecHash(spec),
    engineHash: engineHash(),
    verifiedAt: new Date().toISOString(),
    checks,
    baseline: { ownUniverseReturnPct: stratReturn, spyReturnPct: spyReturn, beatsSpy },
    tradeCount,
    exposurePct,
    backtestWinRatePct: base.overall.winRatePct ?? 0,
    permutationP,
    minTrl,
    trials: { counted: variantsTried },
    dataQuality: { passed: dq.passed },
  };
}

function minTrlNeed(minTrl: number | null, tradeCount: number): string {
  if (minTrl === null || minTrl <= tradeCount) return "";
  return ` (~${minTrl - tradeCount} more needed)`;
}

// The grade contribution of each check, as data rather than a branch-per-check.
// "not-fail" => warn/pass/info are all acceptable; "pass" => must AFFIRMATIVELY pass
// (baseline must actually beat SPY — an "info"/missing baseline cannot certify
// market-beating). Adding/removing a grade-critical check is a one-line edit here.
const GRADE_POLICY: { id: string; requires: "not-fail" | "pass" }[] = [
  { id: "out-of-sample", requires: "not-fail" },
  { id: "cost-stress", requires: "not-fail" },
  { id: "permutation", requires: "not-fail" },
  { id: "baseline", requires: "pass" },
  { id: "walk-forward", requires: "not-fail" },
  { id: "param-robust", requires: "not-fail" },
];

function deriveGrade(checks: VerificationCheck[], dqPassed: boolean, enoughTrades: boolean): Grade {
  if (!dqPassed) return "fragile"; // poisoned input — can never exceed fragile
  if (!enoughTrades) return "fragile"; // can't establish an edge on too few trades
  const byId = new Map(checks.map((c) => [c.id, c.status]));
  for (const { id, requires } of GRADE_POLICY) {
    const status = byId.get(id);
    const ok = requires === "pass" ? status === "pass" : status !== "fail";
    if (!ok) return "fragile";
  }
  return "holds-up";
}
