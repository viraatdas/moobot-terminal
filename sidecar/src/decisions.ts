import crypto from "node:crypto";
import { DECISIONS_FILE } from "./config.ts";
import { readJsonl, appendJsonl } from "./json-store.ts";

/**
 * An immutable record of one human decision on a proposal. Entries are only ever
 * appended to decisions.jsonl — never edited or deleted — so the log is a
 * faithful audit trail of what was proposed, what the human did, and what hit
 * the broker (or was simulated in paper mode).
 */
export interface DecisionEntry {
  id: string;
  at: string;
  proposalId: string;
  tabId: string;
  tabTopic: string;
  symbol: string;
  side: "buy" | "sell";
  action: "approve" | "reject";
  paper: boolean;
  accountNumber: string | null;
  /** What the agent originally proposed. */
  proposed: {
    quantity: number;
    orderType: "market" | "limit";
    limitPrice: number | null;
    confidence: number;
    thesis: string;
    whyNow: string;
    stop: number | null;
    target: number | null;
    entryPrice: number | null;
  };
  /** What was actually executed (null for rejects). */
  executed: {
    quantity: number;
    orderType: "market" | "limit";
    limitPrice: number | null;
    modified: boolean;
    fillPrice: number | null;
  } | null;
  outcome: "approved" | "rejected" | "failed";
  error: string | null;
}

export class DecisionLog {
  private entries: DecisionEntry[] = [];

  constructor() {
    const { records, dropped } = readJsonl<DecisionEntry>(DECISIONS_FILE);
    this.entries = records;
    // A truncated final line (process killed mid-append) parses to null and is
    // dropped — surface it loudly rather than silently losing an audit entry.
    if (dropped > 0) console.error(`[decisions] dropped ${dropped} corrupt audit line(s) on load`);
  }

  append(entry: Omit<DecisionEntry, "id" | "at">): DecisionEntry {
    const full: DecisionEntry = {
      id: crypto.randomUUID().slice(0, 8),
      at: new Date().toISOString(),
      ...entry,
    };
    this.entries.push(full);
    try {
      // Open + fsync (via appendJsonl) so the audit entry survives a crash/power
      // loss immediately after approval — appendFileSync alone can leave it
      // buffered in the OS.
      appendJsonl(DECISIONS_FILE, full);
    } catch (err) {
      console.error(`[decisions] append failed: ${err}`);
    }
    return full;
  }

  list(): DecisionEntry[] {
    return [...this.entries].sort((a, b) => b.at.localeCompare(a.at));
  }
}
