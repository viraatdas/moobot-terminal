import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDataQuality, checkSeriesQuality } from "../src/data-quality.ts";
import type { Bar } from "../src/backtest.ts";

function series(prices: number[], vol = 1000): Bar[] {
  const base = Date.UTC(2023, 0, 1);
  return prices.map((p, i) => ({
    date: new Date(base + i * 86_400_000).toISOString().slice(0, 10),
    open: p, high: p, low: p, close: p, volume: vol,
  }));
}

test("clean adjusted series passes", () => {
  const bars = series(Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 3));
  const r = checkDataQuality(new Map([["X", bars]]));
  assert.equal(r.passed, true, JSON.stringify(r.findings));
});

test("a planted unadjusted-split gap FAILS the gate", () => {
  // 60 flat-ish bars, then a single -50% bar (the unadjusted 2:1 split signature).
  const prices = Array.from({ length: 60 }, () => 100);
  prices[40] = 50; // 50% single-bar drop
  const bars = series(prices);
  const r = checkDataQuality(new Map([["X", bars]]));
  assert.equal(r.passed, false, "a 50% single-bar gap must void the result");
  assert.ok(r.findings.some((f) => f.kind === "gap" && f.severity === "fail"));
});

test("a 30% earnings move WARNS but does not fail", () => {
  const prices = Array.from({ length: 60 }, () => 100);
  prices[40] = 130; // +30% — plausible earnings move
  const r = checkDataQuality(new Map([["X", series(prices)]]));
  assert.equal(r.passed, true, "a sub-40% move should not hard-fail");
  assert.ok(r.findings.some((f) => f.kind === "gap" && f.severity === "warn"));
});

test("non-positive price FAILS", () => {
  const prices = Array.from({ length: 40 }, () => 100);
  prices[10] = 0;
  const r = checkDataQuality(new Map([["X", series(prices)]]));
  assert.equal(r.passed, false);
  assert.ok(r.findings.some((f) => f.kind === "non-positive-price"));
});

test("too few bars FAILS", () => {
  const r = checkSeriesQuality("X", series([1, 2, 3, 4, 5]));
  assert.ok(r.some((f) => f.kind === "too-few-bars" && f.severity === "fail"));
});

test("a long zero-volume run WARNS", () => {
  const bars = series(Array.from({ length: 60 }, () => 100), 0);
  const r = checkSeriesQuality("X", bars);
  assert.ok(r.some((f) => f.kind === "zero-volume-run" && f.severity === "warn"));
});
