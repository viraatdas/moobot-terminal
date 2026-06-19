import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalSpecHash, engineHash, verifyStrategy } from "../src/verify.ts";
import { parseSpec, type Bar, type StrategySpec } from "../src/backtest.ts";

function spec(s: object): StrategySpec {
  const p = parseSpec(s);
  if ("error" in p) throw new Error(p.error);
  return p;
}
// Choppy oscillating series so a crossover strategy fires many round-trips.
function choppy(n: number, gapAt?: number): Bar[] {
  const base = Date.UTC(2020, 0, 1);
  return Array.from({ length: n }, (_, i) => {
    let p = 100 + Math.sin(i / 3) * 12 + Math.sin(i / 11) * 6;
    if (gapAt !== undefined && i === gapAt) p = p * 0.4; // -60% planted gap
    return { date: new Date(base + i * 86_400_000).toISOString().slice(0, 10), open: p, high: p * 1.01, low: p * 0.99, close: p, volume: 1000 };
  });
}
const crossStrat = (universe = ["X"]) => ({
  version: 1, universe, direction: "long",
  entry: { lhs: { price: "close" }, op: "crossesAbove", rhs: { sma: 5 } },
  exit: { lhs: { price: "close" }, op: "crossesBelow", rhs: { sma: 5 } },
  sizing: { type: "fixedShares", value: 10 }, cooldownBars: 0, maxPositions: 1,
});

test("canonicalSpecHash is stable and order-independent", () => {
  const a = spec(crossStrat(["X", "Y"]));
  const b = spec(crossStrat(["Y", "X"])); // universe reordered
  assert.equal(canonicalSpecHash(a), canonicalSpecHash(b), "sorted universe => same hash");
});

test("canonicalSpecHash changes when a numeric operand changes (staleness)", () => {
  const a = spec(crossStrat());
  const b = spec({ ...crossStrat(), entry: { lhs: { price: "close" }, op: "crossesAbove", rhs: { sma: 6 } } });
  assert.notEqual(canonicalSpecHash(a), canonicalSpecHash(b), "sma 5 vs 6 must differ");
});

test("engineHash is deterministic and 16 hex chars", () => {
  const h1 = engineHash();
  const h2 = engineHash();
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{16}$/);
});

test("data-quality fail caps the grade at fragile", () => {
  const hist = new Map([["X", choppy(220, 120)]]); // planted -60% gap
  const r = verifyStrategy(spec(crossStrat()), hist, [], { iterations: 20 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.dataQuality.passed, false);
  assert.equal(r.grade, "fragile", "poisoned input can never exceed fragile");
  assert.ok(r.checks.find((c) => c.id === "data-quality")?.status === "fail");
});

test("too few trades => fragile, stats gated to null", () => {
  // A short flat-ish series that barely trades.
  const bars = choppy(40);
  const r = verifyStrategy(spec(crossStrat()), new Map([["X", bars]]), [], { iterations: 20 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  if (r.tradeCount < 20) {
    assert.equal(r.grade, "fragile");
    assert.equal(r.permutationP, null, "no p-value below the trade floor");
    assert.equal(r.minTrl, null);
    assert.ok(r.checks.find((c) => c.id === "permutation")?.status === "info");
  }
});

test("report is well-formed with all expected checks", () => {
  const r = verifyStrategy(spec(crossStrat()), new Map([["X", choppy(220)]]), [], { iterations: 20 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(["untested", "fragile", "holds-up", "diverged"].includes(r.grade));
  for (const id of ["data-quality", "out-of-sample", "baseline", "walk-forward", "param-robust", "cost-stress", "exposure", "sample-size", "permutation"]) {
    assert.ok(r.checks.some((c) => c.id === id), `missing check ${id}`);
  }
  assert.match(r.specHash, /^[0-9a-f]{32}$/);
  assert.match(r.engineHash, /^[0-9a-f]{16}$/);
});
