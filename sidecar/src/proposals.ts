import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PROPOSALS_FILE } from "./config.ts";
import { writeJsonFileAtomic } from "./json-store.ts";
import type { RobinhoodGateway } from "./robinhood.ts";
import type { ResearchManager } from "./research.ts";
import type { DecisionLog } from "./decisions.ts";
import { gateReview, type ReviewAlert } from "./review-alerts.ts";

export interface ProposalExecution {
  quantity: number;
  orderType: "market" | "limit";
  limitPrice: number | null;
  /** True when the human edited size/type/limit before approving. */
  modified: boolean;
  /** True when simulated (paper mode) rather than sent to the broker. */
  paper: boolean;
  /** Reference price recorded at approval (limit price, or live quote). */
  fillPrice: number | null;
  /** Pre-trade alerts from the broker's review dry-run (null in paper mode). */
  reviewAlerts: ReviewAlert[] | null;
  /** Live quote the broker returned in the review (null in paper mode). */
  reviewQuote: number | null;
  refId: string;
  placedAt: string;
}

export interface ProposalQueueDeps {
  /** Latest reference prices, used to stamp entry/fill prices. */
  quotes?: (symbols: string[]) => Promise<Map<string, number>>;
  /** Whether approvals should be simulated instead of sent to the broker. */
  isPaper?: () => boolean;
  /** Append-only audit trail. */
  decisions?: DecisionLog;
  /** Paper-only: auto-approve newly-ingested proposals with no human review. The
   * SettingsStore returns true here ONLY in paper mode, so this can never reach
   * real money. */
  autoApprove?: () => boolean;
  /** Account used for auto-approved orders (unused in paper, where nothing is sent). */
  tradeAccount?: () => string;
  /** Fired after an auto-approved proposal executes (e.g. to send a notification). */
  onTradeExecuted?: (p: TradeProposal) => void;
}

export interface TradeProposal {
  id: string;
  tabId: string;
  tabTopic: string;
  sourceFile: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  orderType: "market" | "limit";
  limitPrice: number | null;
  /** Price at which the thesis is wrong (protective stop). */
  stop: number | null;
  /** Price objective for the trade. */
  target: number | null;
  thesis: string;
  /** The specific new catalyst/data that tripped this proposal right now. */
  whyNow: string;
  confidence: number;
  timeHorizon: string;
  /** Live price captured when the proposal was filed — the track-record entry. */
  entryPrice: number | null;
  entryAt: string | null;
  /** For strategy-lens proposals: the spec hash that fired this, so realized
   * fills attribute back to the exact verified rules (null for manual/research). */
  strategySpecHash: string | null;
  createdAt: string;
  /** "approving" is a transient in-flight lock that blocks double-approval. */
  status: "pending" | "approving" | "approved" | "rejected" | "failed";
  /** Robinhood order review/placement result, when approved. */
  result: unknown;
  /** What was actually placed (may differ from the proposed order if edited). */
  execution: ProposalExecution | null;
  error: string | null;
}

export interface ApprovalOverrides {
  quantity?: number;
  orderType?: "market" | "limit";
  limitPrice?: number | null;
}

type CoercedFields = {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  orderType: "market" | "limit";
  limitPrice: number | null;
  stop: number | null;
  target: number | null;
  thesis: string;
  whyNow: string;
  confidence: number;
  timeHorizon: string;
};

// ONE coercion rule set shared by validate() (new agent proposals) and
// normalizeLoaded() (persisted rows). Throws on an invalid field; the two callers
// differ only in how they handle the throw (reject the file vs drop the row), so a
// rule like "quantity > 0" or "a limit order needs a limit price" can never be
// enforced on one path and silently skipped on the other.
function coerceProposalFields(raw: any): CoercedFields {
  const symbol = String(raw.symbol ?? "").toUpperCase().trim();
  if (!/^[A-Z.]{1,6}$/.test(symbol)) throw new Error(`bad symbol: ${raw.symbol}`);
  const side = raw.side === "buy" || raw.side === "sell" ? raw.side : null;
  if (!side) throw new Error(`bad side: ${raw.side}`);
  const quantity = Number(raw.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`bad quantity: ${raw.quantity}`);
  const orderType = raw.orderType === "limit" ? "limit" : "market";
  // Number(null) === 0 (finite), so require a strictly positive price here — the
  // same bar approve()'s resolveOrder enforces — instead of silently coercing a
  // null/0 limit to 0 that fails only later at placement.
  const limitPrice =
    orderType === "limit" && Number.isFinite(Number(raw.limitPrice)) && Number(raw.limitPrice) > 0
      ? Number(raw.limitPrice)
      : null;
  if (orderType === "limit" && limitPrice === null) throw new Error("limit order without a positive limitPrice");
  const numOrNull = (v: any): number | null => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    symbol,
    side,
    quantity,
    orderType,
    limitPrice,
    stop: numOrNull(raw.stop),
    target: numOrNull(raw.target),
    thesis: String(raw.thesis ?? ""),
    whyNow: String(raw.whyNow ?? ""),
    confidence: Math.min(10, Math.max(1, Number(raw.confidence) || 5)),
    timeHorizon: String(raw.timeHorizon ?? ""),
  };
}

// Resolve the order the human actually approved, applying any approval-ticket
// edits. Pure (reads only p + overrides) and may throw on a bad override — which
// correctly leaves the proposal pending.
function resolveOrder(
  p: TradeProposal,
  overrides: ApprovalOverrides,
): { effOrderType: "market" | "limit"; effQuantity: number; effLimit: number | null; modified: boolean } {
  const effOrderType =
    overrides.orderType === "market" || overrides.orderType === "limit" ? overrides.orderType : p.orderType;
  let effQuantity = p.quantity;
  if (overrides.quantity !== undefined) {
    const q = Number(overrides.quantity);
    if (!Number.isFinite(q) || q <= 0) throw new Error(`bad override quantity: ${overrides.quantity}`);
    effQuantity = q;
  }
  let effLimit = effOrderType === "limit" ? p.limitPrice : null;
  if (effOrderType === "limit" && overrides.limitPrice !== undefined && overrides.limitPrice !== null) {
    const lp = Number(overrides.limitPrice);
    if (!Number.isFinite(lp) || lp <= 0) throw new Error(`bad override limit price: ${overrides.limitPrice}`);
    effLimit = lp;
  }
  if (effOrderType === "limit" && (effLimit === null || effLimit <= 0))
    throw new Error("limit order needs a positive limit price");
  const modified = effQuantity !== p.quantity || effOrderType !== p.orderType || effLimit !== p.limitPrice;
  return { effOrderType, effQuantity, effLimit, modified };
}

export class ProposalQueue {
  private proposals: TradeProposal[] = [];
  onChanged?: () => void;

  private rh: RobinhoodGateway;
  private research: ResearchManager;
  private deps: ProposalQueueDeps;

  constructor(rh: RobinhoodGateway, research: ResearchManager, deps: ProposalQueueDeps = {}) {
    this.rh = rh;
    this.research = research;
    this.deps = deps;
    try {
      const loaded = JSON.parse(fs.readFileSync(PROPOSALS_FILE, "utf8"));
      const rows = Array.isArray(loaded) ? loaded : [];
      this.proposals = rows
        .map((p) => this.normalizeLoaded(p))
        .filter((p): p is TradeProposal => p !== null);
      const dropped = rows.length - this.proposals.length;
      if (dropped > 0) console.error(`[proposals] dropped ${dropped} malformed proposal(s) on load`);
    } catch {
      this.proposals = [];
    }
  }

  /**
   * Coerce a persisted record into a valid TradeProposal, supplying defaults for
   * fields added in later versions. Returns null (and the row is dropped) if a
   * required field is missing/invalid, so a corrupt file can never crash startup
   * downstream (e.g. list()'s createdAt.localeCompare or a null symbol).
   */
  private normalizeLoaded(p: any): TradeProposal | null {
    if (!p || typeof p !== "object") return null;
    const status = ["pending", "approving", "approved", "rejected", "failed"].includes(p.status) ? p.status : null;
    if (!p.id || !p.tabId || !status) return null;
    let f: CoercedFields;
    try {
      f = coerceProposalFields(p); // same rules as validate() — a corrupt row is dropped
    } catch {
      return null;
    }
    const num = (v: any): number | null => (Number.isFinite(Number(v)) ? Number(v) : null);
    return {
      id: String(p.id),
      tabId: String(p.tabId),
      tabTopic: String(p.tabTopic ?? ""),
      sourceFile: String(p.sourceFile ?? ""),
      symbol: f.symbol,
      side: f.side,
      quantity: f.quantity,
      orderType: f.orderType,
      limitPrice: f.limitPrice,
      stop: f.stop,
      target: f.target,
      thesis: f.thesis,
      whyNow: f.whyNow,
      confidence: f.confidence,
      timeHorizon: f.timeHorizon,
      entryPrice: num(p.entryPrice),
      entryAt: typeof p.entryAt === "string" ? p.entryAt : null,
      strategySpecHash: typeof p.strategySpecHash === "string" ? p.strategySpecHash : null,
      // A row left "approving" on disk means the process died MID-placement: the order
      // may or may not have reached the broker. Do NOT silently revert to pending
      // (re-approval could place a duplicate) — mark it failed and force the human to
      // reconcile with the broker before re-filing. This is the recovery counterpart
      // of approve()'s now-persisted "approving" lock.
      createdAt: typeof p.createdAt === "string" ? p.createdAt : new Date().toISOString(),
      status: status === "approving" ? "failed" : status,
      result: p.result ?? null,
      execution: p.execution ?? null,
      error:
        status === "approving"
          ? "Interrupted during order placement — verify with the broker before re-filing (the order may or may not have been placed)."
          : typeof p.error === "string"
            ? p.error
            : null,
    };
  }

  private persist() {
    writeJsonFileAtomic(PROPOSALS_FILE, this.proposals);
    this.onChanged?.();
  }

  list(): TradeProposal[] {
    return [...this.proposals].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Scan a tab's proposals/ dir for new agent-written proposal files. */
  async ingest(tabId: string) {
    const tab = this.research.get(tabId);
    if (!tab) return;
    const dir = this.research.proposalsDir(tabId);
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      return;
    }
    const added: TradeProposal[] = [];
    for (const file of files) {
      const full = path.join(dir, file);
      const already = this.proposals.some(
        (p) => p.tabId === tabId && p.sourceFile === file,
      );
      if (already) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(full, "utf8"));
        const proposal = this.validate(raw, tabId, tab.topic, file);
        this.proposals.push(proposal);
        added.push(proposal);
      } catch (err) {
        console.error(`[proposals] invalid proposal ${full}: ${err}`);
        fs.renameSync(full, `${full}.invalid`);
      }
    }
    if (!added.length) return;
    // Stamp a live entry price BEFORE the first persist so the track record can
    // mark every agent idea to market (acted on or not) and the proposal is never
    // written to disk in a null-entry state that can't later be backfilled.
    if (this.deps.quotes) {
      try {
        const prices = await this.deps.quotes(added.map((p) => p.symbol));
        const at = new Date().toISOString();
        for (const p of added) {
          const price = prices.get(p.symbol);
          if (price !== undefined) {
            p.entryPrice = price;
            p.entryAt = at;
          }
        }
      } catch (err) {
        console.error(`[proposals] entry quote capture failed: ${err}`);
      }
    }
    this.persist();

    // Paper-only auto-trader: approve newly-filed proposals without human review.
    // autoApprove() is true ONLY in paper mode (enforced in SettingsStore), and
    // approve() in paper simulates the fill — so this can never place a real order.
    if (this.deps.autoApprove?.() && this.deps.isPaper?.()) {
      const acct = this.deps.tradeAccount?.() ?? "";
      for (const p of added) {
        try {
          const done = await this.approve(p.id, acct);
          if (done.status === "approved") this.deps.onTradeExecuted?.(done);
        } catch (err) {
          console.error(`[auto-approve] ${p.id}: ${err}`);
        }
      }
    }
  }

  private validate(
    raw: any,
    tabId: string,
    tabTopic: string,
    sourceFile: string,
  ): TradeProposal {
    const f = coerceProposalFields(raw); // throws => the proposal file is rejected
    return {
      id: crypto.randomUUID().slice(0, 8),
      tabId,
      tabTopic,
      sourceFile,
      symbol: f.symbol,
      side: f.side,
      quantity: f.quantity,
      orderType: f.orderType,
      limitPrice: f.limitPrice,
      stop: f.stop,
      target: f.target,
      thesis: f.thesis,
      whyNow: f.whyNow,
      confidence: f.confidence,
      timeHorizon: f.timeHorizon,
      entryPrice: null,
      entryAt: null,
      strategySpecHash: typeof raw.strategySpecHash === "string" ? raw.strategySpecHash : null,
      createdAt: new Date().toISOString(),
      status: "pending",
      result: null,
      execution: null,
      error: null,
    };
  }

  /**
   * Places an order FROM A PROPOSAL, requiring an explicit human approval from the
   * UI. The manual trade.place ticket also places orders; both real-money paths
   * route through the same gateReview pre-trade hard-block (see placeOrder).
   */
  async approve(
    id: string,
    accountNumber: string,
    overrides: ApprovalOverrides = {},
  ): Promise<TradeProposal> {
    const p = this.proposals.find((x) => x.id === id);
    if (!p) throw new Error(`No proposal ${id}`);
    if (p.status !== "pending") throw new Error(`Proposal ${id} is ${p.status}`);

    // Resolve the approved order (pure; may throw on a bad override, which leaves
    // the proposal pending). The agent's original proposal stays immutable.
    const { effOrderType, effQuantity, effLimit, modified } = resolveOrder(p, overrides);
    const refId = crypto.randomUUID();
    const paper = this.deps.isPaper?.() === true;

    // Input is validated and we're about to do async broker work: lock
    // synchronously BEFORE the first await so a second concurrent approve() bails —
    // no duplicate order placement.
    this.transition(p, "approving");
    // Persist the in-flight lock so a crash mid-placement is recoverable: the row is
    // left "approving" on disk and normalizeLoaded marks it failed-needs-reconcile on
    // restart, rather than re-approvable (which could place a DUPLICATE real order).
    this.persist();

    // Reference fill price: the limit for limit orders, else a live quote.
    let fillPrice = effOrderType === "limit" ? effLimit : null;
    if (fillPrice === null && this.deps.quotes) {
      try {
        const prices = await this.deps.quotes([p.symbol]);
        fillPrice = prices.get(p.symbol) ?? p.entryPrice;
      } catch {
        fillPrice = p.entryPrice;
      }
    }

    try {
      const placed = await this.placeOrder(p, { accountNumber, effOrderType, effQuantity, effLimit, fillPrice, paper, refId });
      p.result = placed.result;
      this.transition(p, "approved");
      p.execution = {
        quantity: effQuantity,
        orderType: effOrderType,
        limitPrice: effLimit,
        modified,
        paper,
        fillPrice,
        reviewAlerts: placed.reviewAlerts,
        reviewQuote: placed.reviewQuote,
        refId,
        placedAt: new Date().toISOString(),
      };
    } catch (err) {
      this.transition(p, "failed");
      p.error = String(err);
    }
    // Persist the proposal's final state FIRST (the money-path record), then the
    // best-effort audit log — so a persist failure can't leave a placed order
    // showing "pending" on disk while still logging the decision.
    this.persist();
    this.logDecision(p, "approve", paper, accountNumber, fillPrice);
    return p;
  }

  // Send (or, in paper mode, simulate) the resolved order. Throws on a pre-trade
  // hard alert (gateReview), which approve() records as a failed proposal.
  private async placeOrder(
    p: TradeProposal,
    o: { accountNumber: string; effOrderType: "market" | "limit"; effQuantity: number; effLimit: number | null; fillPrice: number | null; paper: boolean; refId: string },
  ): Promise<{ result: unknown; reviewAlerts: ReviewAlert[] | null; reviewQuote: number | null }> {
    if (o.paper) {
      // Simulated: never touches the broker.
      return {
        result: { paper: true, simulatedFill: { symbol: p.symbol, side: p.side, quantity: o.effQuantity, price: o.fillPrice } },
        reviewAlerts: null,
        reviewQuote: null,
      };
    }
    const order: Record<string, unknown> = {
      account_number: o.accountNumber,
      symbol: p.symbol,
      side: p.side,
      type: o.effOrderType,
      quantity: String(o.effQuantity),
      time_in_force: "gfd",
    };
    if (o.effLimit !== null) order.limit_price = String(o.effLimit);
    const review = await this.rh.callTool("review_equity_order", order);
    // Hard alerts (halt / PDT / insufficient buying power) block placement even
    // though the human confirmed — review runs HERE, after confirmation. Soft alerts
    // pass through and are recorded.
    const { alerts, quote } = gateReview(review);
    const placed = await this.rh.callTool("place_equity_order", { ...order, ref_id: o.refId });
    return { result: { review, placed }, reviewAlerts: alerts, reviewQuote: quote };
  }

  // The proposal status state machine: every status write goes through here so the
  // legal edges live in one place. (The approving→pending crash-recovery edge is
  // applied at load time in normalizeLoaded, deliberately not routed through here.)
  private transition(p: TradeProposal, to: TradeProposal["status"]) {
    const legal: Record<TradeProposal["status"], TradeProposal["status"][]> = {
      pending: ["approving", "rejected"],
      approving: ["approved", "failed"],
      approved: [],
      rejected: [],
      failed: [],
    };
    if (!legal[p.status].includes(to)) throw new Error(`illegal proposal transition ${p.status} -> ${to}`);
    p.status = to;
  }

  reject(id: string): TradeProposal {
    const p = this.proposals.find((x) => x.id === id);
    if (!p) throw new Error(`No proposal ${id}`);
    if (p.status !== "pending") throw new Error(`Proposal ${id} is ${p.status}`);
    this.transition(p, "rejected");
    this.logDecision(p, "reject", this.deps.isPaper?.() === true, null, null);
    this.persist();
    return p;
  }

  private logDecision(
    p: TradeProposal,
    action: "approve" | "reject",
    paper: boolean,
    accountNumber: string | null,
    fillPrice: number | null,
  ) {
    if (!this.deps.decisions) return;
    this.deps.decisions.append({
      proposalId: p.id,
      tabId: p.tabId,
      tabTopic: p.tabTopic,
      symbol: p.symbol,
      side: p.side,
      action,
      paper,
      accountNumber,
      proposed: {
        quantity: p.quantity,
        orderType: p.orderType,
        limitPrice: p.limitPrice,
        confidence: p.confidence,
        thesis: p.thesis,
        whyNow: p.whyNow,
        stop: p.stop,
        target: p.target,
        entryPrice: p.entryPrice,
      },
      executed:
        action === "approve" && p.execution
          ? {
              quantity: p.execution.quantity,
              orderType: p.execution.orderType,
              limitPrice: p.execution.limitPrice,
              modified: p.execution.modified,
              fillPrice,
            }
          : null,
      outcome: p.status === "approved" ? "approved" : p.status === "failed" ? "failed" : "rejected",
      error: p.error,
    });
  }
}
