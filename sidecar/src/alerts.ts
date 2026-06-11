// Price alerts: poll quotes, fire a native macOS notification when a rule trips.
// Quotes come from the agent MCP (no REST token needed), so alerts work as soon
// as Robinhood is connected.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import {
  DATA_DIR,
  NOTIFY_EMAIL_FROM,
  NOTIFY_EMAIL_TO,
  RESEND_API_KEY,
} from "./config.ts";
import type { RobinhoodGateway } from "./robinhood.ts";

const ALERTS_FILE = path.join(DATA_DIR, "alerts.json");
const POLL_MS = 30_000;

export interface Alert {
  id: string;
  symbol: string;
  op: "above" | "below";
  price: number;
  note: string;
  enabled: boolean;
  createdAt: string;
  lastPrice: number | null;
  triggeredAt: string | null;
}

/** Fire a native macOS notification (works regardless of window focus). */
export function notify(title: string, message: string) {
  if (process.platform === "darwin") {
    const escape = (s: string) => s.replace(/["\\]/g, "\\$&");
    const child = spawn(
      "osascript",
      ["-e", `display notification "${escape(message)}" with title "${escape(title)}" sound name "Glass"`],
      { stdio: "ignore", detached: true },
    );
    child.on("error", () => {});
    child.unref();
  }
  void sendEmailNotification(title, message).catch((err) => {
    console.error(`[moobot-alerts] email notification failed: ${err}`);
  });
}

export async function sendEmailNotification(subject: string, text: string): Promise<boolean> {
  if (!RESEND_API_KEY || !NOTIFY_EMAIL_TO) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: NOTIFY_EMAIL_FROM,
      to: NOTIFY_EMAIL_TO.split(",").map((s) => s.trim()).filter(Boolean),
      subject,
      text,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend ${res.status}: ${body.slice(0, 500)}`);
  }
  return true;
}

export class AlertManager {
  private rh: RobinhoodGateway;
  private alerts: Alert[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  onTriggered?: (alert: Alert) => void;

  constructor(rh: RobinhoodGateway) {
    this.rh = rh;
    try {
      this.alerts = JSON.parse(fs.readFileSync(ALERTS_FILE, "utf8"));
    } catch {
      this.alerts = [];
    }
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  private persist() {
    fs.writeFileSync(ALERTS_FILE, JSON.stringify(this.alerts, null, 2));
  }

  list(): Alert[] {
    return [...this.alerts].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  create(symbol: string, op: "above" | "below", price: number, note = ""): Alert {
    const alert: Alert = {
      id: crypto.randomUUID().slice(0, 8),
      symbol: symbol.toUpperCase().trim(),
      op,
      price,
      note,
      enabled: true,
      createdAt: new Date().toISOString(),
      lastPrice: null,
      triggeredAt: null,
    };
    this.alerts.push(alert);
    this.persist();
    return alert;
  }

  update(id: string, patch: Partial<Pick<Alert, "enabled" | "price" | "op" | "note">>) {
    const a = this.alerts.find((x) => x.id === id);
    if (!a) throw new Error(`No alert ${id}`);
    Object.assign(a, patch);
    // Re-arm when edited.
    a.triggeredAt = null;
    this.persist();
    return a;
  }

  remove(id: string) {
    this.alerts = this.alerts.filter((a) => a.id !== id);
    this.persist();
  }

  private async poll() {
    const active = this.alerts.filter((a) => a.enabled && !a.triggeredAt);
    if (active.length === 0 || !this.rh.authenticated) return;
    const symbols = [...new Set(active.map((a) => a.symbol))];
    let quotes: any;
    try {
      quotes = await this.rh.callTool("get_equity_quotes", { symbols });
    } catch {
      return;
    }
    const rows: any[] = Array.isArray(quotes)
      ? quotes
      : (quotes?.quotes ?? quotes?.results ?? []);
    const priceBySymbol = new Map<string, number>();
    for (const row of rows) {
      // get_equity_quotes nests each quote under `quote`.
      const q = row?.quote ?? row;
      const sym = q?.symbol;
      const price = Number(
        q?.last_trade_price ?? q?.price ?? q?.last_price ?? q?.mark_price ?? q?.last_extended_hours_trade_price,
      );
      if (sym && Number.isFinite(price)) priceBySymbol.set(sym, price);
    }

    let changed = false;
    for (const a of active) {
      const price = priceBySymbol.get(a.symbol);
      if (price === undefined) continue;
      a.lastPrice = price;
      const tripped = a.op === "above" ? price >= a.price : price <= a.price;
      if (tripped) {
        a.triggeredAt = new Date().toISOString();
        changed = true;
        notify(
          `${a.symbol} ${a.op} ${a.price}`,
          `Now ${price.toFixed(2)}${a.note ? ` — ${a.note}` : ""}`,
        );
        this.onTriggered?.(a);
      }
    }
    if (changed) this.persist();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
