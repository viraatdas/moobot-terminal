import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSpec, runBacktest, type Bar, type StrategySpec } from "../src/backtest.ts";
import { selfCheckResult } from "../src/invariants.ts";

// ── helpers ────────────────────────────────────────────────────────────────
// Flat OHLC bars (open=high=low=close) so fills are exact and unambiguous.
function bars(prices: number[]): Bar[] {
  const base = Date.UTC(2023, 0, 1);
  return prices.map((p, i) => ({
    date: new Date(base + i * 86_400_000).toISOString().slice(0, 10),
    open: p, high: p, low: p, close: p, volume: 1000,
  }));
}
const PAD = 25;
const padded = (action: number[]) => bars([...Array(PAD).fill(100), ...action]);
const ZERO = { initialEquity: 100_000, commissionPerTrade: 0, slippageBps: 0, inSampleFraction: 0.95 };

function spec(s: object): StrategySpec {
  const p = parseSpec(s);
  if ("error" in p) throw new Error(p.error);
  return p;
}
function run(s: object, hist: Map<string, Bar[]>, opts = ZERO) {
  const r = runBacktest(spec(s), hist, opts);
  if (!r.ok) throw new Error(r.error);
  return r;
}
const crossBelowEntry = (rhs: number) => ({ lhs: { price: "close" }, op: "crossesBelow", rhs });
const crossAboveExit = (rhs: number) => ({ lhs: { price: "close" }, op: "crossesAbove", rhs });

// ── 1. Long accounting: always-in == buy-and-hold, to the penny ──────────────
test("always-in long equals buy-and-hold to the penny (zero cost)", () => {
  const prices = Array.from({ length: 60 }, (_, i) => 100 + i); // 100..159, distinct
  const hist = new Map([["X", bars(prices)]]);
  const r = run(
    { version: 1, universe: ["X"], direction: "long",
      entry: { lhs: { price: "close" }, op: ">", rhs: 0 },   // always true => enter & hold
      exit:  { lhs: { price: "close" }, op: "<", rhs: 0 },   // never
      sizing: { type: "equityPct", value: 100 }, cooldownBars: 0, maxPositions: 1 },
    hist,
  );
  // Engine fills the entry at bar[1].open; buy-and-hold reference uses the same
  // integer share count the engine floors to.
  const entryPrice = prices[1];
  const shares = Math.floor(100_000 / entryPrice);
  const finalClose = prices[prices.length - 1];
  const expected = 100_000 + shares * (finalClose - entryPrice);
  assert.equal(r.finalEquity, expected, "always-in equity must equal buy-and-hold");
  assert.equal(r.trades.length, 0, "a held-to-end position never closes");
});

// ── 2. Zero-cost conservation: sum(closed pnl) == finalEquity - initial ───────
for (const direction of ["long", "short"] as const) {
  test(`zero-cost conservation holds for a ${direction} round-trip`, () => {
    const action = direction === "long" ? [100, 90, 90, 110, 110, 110] : [100, 110, 110, 90, 90, 90];
    const hist = new Map([["X", padded(action)]]);
    const r = run(
      { version: 1, universe: ["X"], direction,
        entry: direction === "long" ? crossBelowEntry(95) : crossAboveExit(105),
        exit:  direction === "long" ? crossAboveExit(105) : crossBelowEntry(95),
        sizing: { type: "fixedShares", value: 100 }, cooldownBars: 0, maxPositions: 1 },
      hist,
    );
    assert.equal(r.trades.length, 1, "exactly one closed round-trip");
    const sumPnl = r.trades.reduce((a, t) => a + t.pnl, 0);
    assert.ok(Math.abs(sumPnl - (r.finalEquity - 100_000)) < 1e-6,
      `conservation: sum(pnl)=${sumPnl} must equal finalEquity-initial=${r.finalEquity - 100_000}`);
  });
}

// ── 3. Long/short MIRROR symmetry — the short-sign-bug catcher ────────────────
// Same series, same entry/exit bars, same share count: a short's equity delta
// must be the exact negative of the long's. The pre-fix bug (2*entry-exit cash)
// made the short delta wildly wrong; this assertion goes RED if reintroduced.
test("short equity delta is the exact negative of the long (mirror symmetry)", () => {
  const action = [100, 90, 90, 110, 110, 110]; // crossBelow 95 then crossAbove 105
  const base = {
    version: 1, universe: ["X"],
    entry: crossBelowEntry(95), exit: crossAboveExit(105),
    sizing: { type: "fixedShares", value: 100 }, cooldownBars: 0, maxPositions: 1,
  };
  const long = run({ ...base, direction: "long" }, new Map([["X", padded(action)]]));
  const short = run({ ...base, direction: "short" }, new Map([["X", padded(action)]]));
  const dLong = long.finalEquity - 100_000;
  const dShort = short.finalEquity - 100_000;
  assert.ok(Math.abs(dShort + dLong) < 1e-6, `mirror: short delta ${dShort} must equal -(long delta ${dLong})`);
  assert.equal(dLong, 2000); // long buys 90 sells 110 => +2000
  assert.equal(dShort, -2000); // short sells 90 covers 110 => -2000
});

// ── 3b. OPEN-position mark-to-market mirror — catches the markOpen sign bug ───
// The closed-trade tests above exercise the exit-cash path but NOT the open-mark
// path (they all close before the last bar). An always-in short held to the end
// is marked by markOpen every bar; its equity delta must mirror the always-in
// long. The pre-fix markOpen bug (2*entry-price) made the open short equity wrong.
test("always-in short held to end mirrors always-in long (open mark-to-market)", () => {
  const prices = Array.from({ length: 60 }, (_, i) => 100 + i); // 101 entry .. 159 final
  const base = {
    version: 1, universe: ["X"],
    entry: { lhs: { price: "close" }, op: ">", rhs: 0 }, // always true => enter & hold to end
    exit:  { lhs: { price: "close" }, op: "<", rhs: 0 }, // never
    sizing: { type: "fixedShares", value: 100 }, cooldownBars: 0, maxPositions: 1,
  };
  const long = run({ ...base, direction: "long" }, new Map([["X", bars(prices)]]));
  const short = run({ ...base, direction: "short" }, new Map([["X", bars(prices)]]));
  const dLong = long.finalEquity - 100_000;
  const dShort = short.finalEquity - 100_000;
  // entry @101, final close 159, 100 shares: long +5800, short -5800.
  assert.equal(dLong, 5800);
  assert.equal(dShort, -5800, "open short equity must be hand-math correct, not inflated by the markOpen bug");
  assert.ok(Math.abs(dShort + dLong) < 1e-6, "open-position mirror symmetry");
  assert.equal(long.trades.length, 0, "held to end, never closes");
  assert.equal(short.trades.length, 0);
});

// ── 4. Golden hand-math fixtures (independent of the engine) ──────────────────
test("golden: single long trade matches hand math", () => {
  const r = run(
    { version: 1, universe: ["X"], direction: "long", entry: crossBelowEntry(95), exit: crossAboveExit(105),
      sizing: { type: "fixedShares", value: 100 }, cooldownBars: 0, maxPositions: 1 },
    new Map([["X", padded([100, 90, 90, 110, 110, 110])]]),
  );
  assert.equal(r.trades[0].entryPrice, 90);
  assert.equal(r.trades[0].exitPrice, 110);
  assert.equal(r.trades[0].pnl, 2000);
  assert.equal(r.finalEquity, 102_000);
});
test("golden: single short trade matches hand math", () => {
  const r = run(
    { version: 1, universe: ["X"], direction: "short", entry: crossAboveExit(105), exit: crossBelowEntry(95),
      sizing: { type: "fixedShares", value: 100 }, cooldownBars: 0, maxPositions: 1 },
    new Map([["X", padded([100, 110, 110, 90, 90, 90])]]),
  );
  assert.equal(r.trades[0].entryPrice, 110);
  assert.equal(r.trades[0].exitPrice, 90);
  assert.equal(r.trades[0].pnl, 2000); // short 110 -> cover 90 = +2000
  assert.equal(r.finalEquity, 102_000);
});

// ── 5. selfCheck surfaces nothing on a correct run ───────────────────────────
test("selfCheckResult is silent on a correct backtest", () => {
  const r = run(
    { version: 1, universe: ["X"], direction: "long", entry: crossBelowEntry(95), exit: crossAboveExit(105),
      sizing: { type: "fixedShares", value: 100 }, cooldownBars: 0, maxPositions: 1 },
    new Map([["X", padded([100, 90, 90, 110, 110, 110])]]),
  );
  assert.deepEqual(selfCheckResult(r), [], "no invariant violations on correct accounting");
});
