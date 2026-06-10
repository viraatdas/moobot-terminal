import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PROPOSALS_FILE } from "./config.ts";
import type { RobinhoodGateway } from "./robinhood.ts";
import type { ResearchManager } from "./research.ts";

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
  thesis: string;
  confidence: number;
  timeHorizon: string;
  createdAt: string;
  status: "pending" | "approved" | "rejected" | "failed";
  /** Robinhood order review/placement result, when approved. */
  result: unknown;
  error: string | null;
}

export class ProposalQueue {
  private proposals: TradeProposal[] = [];
  onChanged?: () => void;

  private rh: RobinhoodGateway;
  private research: ResearchManager;

  constructor(rh: RobinhoodGateway, research: ResearchManager) {
    this.rh = rh;
    this.research = research;
    try {
      this.proposals = JSON.parse(fs.readFileSync(PROPOSALS_FILE, "utf8"));
    } catch {
      this.proposals = [];
    }
  }

  private persist() {
    fs.writeFileSync(PROPOSALS_FILE, JSON.stringify(this.proposals, null, 2));
    this.onChanged?.();
  }

  list(): TradeProposal[] {
    return [...this.proposals].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Scan a tab's proposals/ dir for new agent-written proposal files. */
  ingest(tabId: string) {
    const tab = this.research.get(tabId);
    if (!tab) return;
    const dir = this.research.proposalsDir(tabId);
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      return;
    }
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
      } catch (err) {
        console.error(`[proposals] invalid proposal ${full}: ${err}`);
        fs.renameSync(full, `${full}.invalid`);
      }
    }
    this.persist();
  }

  private validate(
    raw: any,
    tabId: string,
    tabTopic: string,
    sourceFile: string,
  ): TradeProposal {
    const symbol = String(raw.symbol ?? "").toUpperCase().trim();
    if (!/^[A-Z.]{1,6}$/.test(symbol)) throw new Error(`bad symbol: ${raw.symbol}`);
    const side = raw.side === "buy" || raw.side === "sell" ? raw.side : null;
    if (!side) throw new Error(`bad side: ${raw.side}`);
    const quantity = Number(raw.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0)
      throw new Error(`bad quantity: ${raw.quantity}`);
    const orderType = raw.orderType === "limit" ? "limit" : "market";
    const limitPrice =
      orderType === "limit" && Number.isFinite(Number(raw.limitPrice))
        ? Number(raw.limitPrice)
        : null;
    if (orderType === "limit" && limitPrice === null)
      throw new Error("limit order without limitPrice");
    return {
      id: crypto.randomUUID().slice(0, 8),
      tabId,
      tabTopic,
      sourceFile,
      symbol,
      side,
      quantity,
      orderType,
      limitPrice,
      thesis: String(raw.thesis ?? ""),
      confidence: Math.min(10, Math.max(1, Number(raw.confidence) || 5)),
      timeHorizon: String(raw.timeHorizon ?? ""),
      createdAt: new Date().toISOString(),
      status: "pending",
      result: null,
      error: null,
    };
  }

  /**
   * The ONLY code path in the app that places an order, and it requires an
   * explicit human approval from the UI.
   */
  async approve(id: string, accountNumber: string): Promise<TradeProposal> {
    const p = this.proposals.find((x) => x.id === id);
    if (!p) throw new Error(`No proposal ${id}`);
    if (p.status !== "pending") throw new Error(`Proposal ${id} is ${p.status}`);
    try {
      const order: Record<string, unknown> = {
        account_number: accountNumber,
        symbol: p.symbol,
        side: p.side,
        type: p.orderType,
        quantity: String(p.quantity),
        time_in_force: "gfd",
      };
      if (p.limitPrice !== null) order.limit_price = String(p.limitPrice);
      const review = await this.rh.callTool("review_equity_order", order);
      const placed = await this.rh.callTool("place_equity_order", {
        ...order,
        ref_id: crypto.randomUUID(),
      });
      p.status = "approved";
      p.result = { review, placed };
    } catch (err) {
      p.status = "failed";
      p.error = String(err);
    }
    this.persist();
    return p;
  }

  reject(id: string): TradeProposal {
    const p = this.proposals.find((x) => x.id === id);
    if (!p) throw new Error(`No proposal ${id}`);
    if (p.status !== "pending") throw new Error(`Proposal ${id} is ${p.status}`);
    p.status = "rejected";
    this.persist();
    return p;
  }
}
