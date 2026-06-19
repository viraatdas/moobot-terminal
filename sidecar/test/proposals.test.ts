import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Point the data dir at a temp location BEFORE importing the module (config reads
// MOOBOT_DATA_DIR at load), then dynamic-import so PROPOSALS_FILE resolves there.
process.env.MOOBOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "moobot-prop-"));
const { PROPOSALS_FILE } = await import("../src/config.ts");
const { ProposalQueue } = await import("../src/proposals.ts");

const rhThatThrows = { callTool: async () => { throw new Error("broker must not be called in paper mode"); } } as any;
const researchStub = { proposalsDir: () => path.join(process.env.MOOBOT_DATA_DIR!, "p"), get: () => ({ topic: "t" }) } as any;

function row(over: Record<string, unknown>) {
  return {
    id: "id-" + Math.random().toString(36).slice(2, 8),
    tabId: "t1", tabTopic: "T", sourceFile: "s.json",
    symbol: "AAPL", side: "buy", quantity: 10,
    orderType: "market", limitPrice: null, stop: null, target: null,
    thesis: "", whyNow: "", confidence: 6, timeHorizon: "",
    entryPrice: 150, entryAt: "2026-01-01T00:00:00Z", strategySpecHash: null,
    createdAt: "2026-01-01T00:00:00Z", status: "pending",
    result: null, execution: null, error: null,
    ...over,
  };
}

function seed(rows: unknown[]) {
  fs.writeFileSync(PROPOSALS_FILE, JSON.stringify(rows));
}

test("normalizeLoaded drops corrupt persisted rows the same rules validate() enforces", () => {
  seed([
    row({ id: "good" }),
    row({ id: "zero-qty", quantity: 0 }), // validate rejects qty<=0 → load must too
    row({ id: "neg-qty", quantity: -5 }),
    row({ id: "limit-no-price", orderType: "limit", limitPrice: null }),
    row({ id: "bad-symbol", symbol: "totally not a ticker" }),
  ]);
  const q = new ProposalQueue(rhThatThrows, researchStub, { isPaper: () => true });
  const ids = q.list().map((p: any) => p.id);
  assert.deepEqual(ids, ["good"], "only the valid row survives the load coercion");
});

test("a persisted limit order keeps its limit price", () => {
  seed([row({ id: "lim", orderType: "limit", limitPrice: 142.5 })]);
  const q = new ProposalQueue(rhThatThrows, researchStub, { isPaper: () => true });
  const p = q.list()[0] as any;
  assert.equal(p.orderType, "limit");
  assert.equal(p.limitPrice, 142.5);
});

test("paper approve simulates the fill, sets execution, and never touches the broker", async () => {
  seed([row({ id: "buy1", quantity: 10, entryPrice: 150 })]);
  const q = new ProposalQueue(rhThatThrows, researchStub, {
    isPaper: () => true,
    quotes: async (syms: string[]) => new Map(syms.map((s) => [s, 152])),
  });
  const p = await q.approve("buy1", "ACCT-1");
  assert.equal(p.status, "approved");
  assert.ok(p.execution, "execution recorded");
  assert.equal(p.execution.paper, true);
  assert.equal(p.execution.quantity, 10);
  assert.equal(p.execution.fillPrice, 152, "market order marks at the live quote");
  assert.equal(p.execution.reviewAlerts, null, "no broker review in paper mode");
  assert.equal((p.result as any).paper, true);
});

test("approving the same proposal twice fails the second time (lock)", async () => {
  seed([row({ id: "once" })]);
  const q = new ProposalQueue(rhThatThrows, researchStub, { isPaper: () => true });
  await q.approve("once", "ACCT-1");
  await assert.rejects(() => q.approve("once", "ACCT-1"), /is approved/);
});

test("reject moves a pending proposal to rejected", () => {
  seed([row({ id: "nope" })]);
  const q = new ProposalQueue(rhThatThrows, researchStub, { isPaper: () => true });
  const p = q.reject("nope");
  assert.equal(p.status, "rejected");
});

test("approve honors a quantity override and marks the proposal modified", async () => {
  seed([row({ id: "ov", quantity: 10 })]);
  const q = new ProposalQueue(rhThatThrows, researchStub, {
    isPaper: () => true,
    quotes: async (syms: string[]) => new Map(syms.map((s) => [s, 100])),
  });
  const p = await q.approve("ov", "ACCT-1", { quantity: 4 });
  assert.equal(p.execution.quantity, 4);
  assert.equal(p.execution.modified, true);
});

test("approve rejects a non-positive override quantity, leaving the proposal pending", async () => {
  seed([row({ id: "badov" })]);
  const q = new ProposalQueue(rhThatThrows, researchStub, { isPaper: () => true });
  await assert.rejects(() => q.approve("badov", "ACCT-1", { quantity: 0 }), /bad override quantity/);
  assert.equal((q.list()[0] as any).status, "pending", "a bad override must not consume the proposal");
});

test("an interrupted 'approving' row recovers as failed-needs-reconcile, never re-approvable", () => {
  seed([row({ id: "stuck", status: "approving" })]);
  const q = new ProposalQueue(rhThatThrows, researchStub, { isPaper: () => true });
  const p = q.list()[0] as any;
  assert.equal(p.status, "failed", "a crash mid-placement must not leave the row re-approvable as pending");
  assert.match(p.error, /verify with the broker/i);
});
