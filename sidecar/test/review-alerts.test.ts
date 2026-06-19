import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReview } from "../src/review-alerts.ts";

test("halt alert is hard and blocks", () => {
  const r = parseReview({ alerts: [{ type: "trading_halt", message: "NVDA is halted" }], last_trade_price: 120 });
  assert.equal(r.hasHard, true);
  assert.equal(r.alerts[0].kind, "halt");
  assert.equal(r.quote, 120);
});

test("insufficient buying power is hard", () => {
  const r = parseReview({ warnings: ["Insufficient buying power for this order"] });
  assert.equal(r.hasHard, true);
  assert.equal(r.alerts[0].kind, "buying-power");
});

test("pattern day trade is hard", () => {
  const r = parseReview({ messages: [{ code: "PDT", detail: "This would be your 4th day trade" }] });
  assert.equal(r.hasHard, true);
  assert.equal(r.alerts[0].kind, "pdt");
});

test("price collar is soft (warn, does not block)", () => {
  const r = parseReview({ alerts: [{ message: "Order price is outside the collar band" }], quote: { last_trade_price: 50 } });
  assert.equal(r.hasHard, false);
  assert.equal(r.alerts[0].kind, "collar");
  assert.equal(r.alerts[0].severity, "soft");
  assert.equal(r.quote, 50);
});

test("clean review has no alerts and does not block", () => {
  const r = parseReview({ estimated_price: 99.5, account_buying_power: 100000 });
  assert.equal(r.hasHard, false);
  assert.equal(r.alerts.length, 0, "field names must NOT be scanned as alerts");
  assert.equal(r.quote, 99.5);
});

test("non-object review is handled", () => {
  assert.deepEqual(parseReview(null), { alerts: [], quote: null, hasHard: false });
  assert.deepEqual(parseReview("oops"), { alerts: [], quote: null, hasHard: false });
});
