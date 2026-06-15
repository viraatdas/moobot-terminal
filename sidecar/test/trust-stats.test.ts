import { test } from "node:test";
import assert from "node:assert/strict";
import { minTrackRecordLength, permutationPValue, TRADE_FLOOR } from "../src/trust-stats.ts";
import { parseSpec, type Bar } from "../src/backtest.ts";

test("minTRL returns null below the trade floor", () => {
  assert.equal(minTrackRecordLength([0.01, 0.02, 0.03]), null);
});

test("minTRL returns null when the per-trade Sharpe is non-positive", () => {
  const losing = Array.from({ length: 25 }, () => -0.01);
  assert.equal(minTrackRecordLength(losing), null);
});

test("minTRL returns a positive integer for a positive edge", () => {
  // Mostly small wins with the occasional small loss => positive, low-variance edge.
  const r = Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? -0.005 : 0.02));
  const n = minTrackRecordLength(r);
  assert.ok(n !== null && Number.isInteger(n) && n > 0, `got ${n}`);
});

test("permutationPValue is gated to null below the trade floor", () => {
  const spec = parseSpec({
    version: 1, universe: ["X"], direction: "long",
    entry: { lhs: { price: "close" }, op: ">", rhs: 0 },
    exit: { lhs: { price: "close" }, op: "<", rhs: 0 },
    sizing: { type: "fixedShares", value: 1 }, cooldownBars: 0, maxPositions: 1,
  });
  if ("error" in spec) throw new Error(spec.error);
  // tradeCount below the floor => null without running any shuffles.
  assert.equal(permutationPValue(spec, new Map<string, Bar[]>(), 100_000, TRADE_FLOOR - 1, {}), null);
});
