/**
 * Parse the result of Robinhood's review_equity_order (a per-order DRY RUN that
 * returns the live quote plus pre-trade alerts: buying power, PDT, halt, price
 * collar, etc.). The approve path currently fetches this and throws it away; this
 * turns it into a real pre-trade verdict.
 *
 * NOTE: the exact review payload shape is not yet confirmed against a live call,
 * so parsing is intentionally defensive — it reads any structured alert array it
 * recognises and classifies by keyword. HARD alerts (halt / PDT / insufficient
 * buying power) should block placement; SOFT alerts (price collar / slippage)
 * should warn. Tune the field names in alertEntries() once a real payload is seen.
 */
export type ReviewAlertKind = "buying-power" | "pdt" | "halt" | "collar" | "other";

export type ReviewAlert = {
  kind: ReviewAlertKind;
  severity: "hard" | "soft";
  message: string;
};

export type ParsedReview = {
  alerts: ReviewAlert[];
  quote: number | null;
  hasHard: boolean;
};

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// Pull candidate alert objects/strings out of whatever structured fields the
// review payload exposes. Only known array fields are read — we do NOT scan the
// whole stringified payload (that produces false positives off field names).
function alertEntries(review: any): unknown[] {
  if (!review || typeof review !== "object") return [];
  const out: unknown[] = [];
  for (const key of ["alerts", "warnings", "messages", "pre_trade_alerts", "preTradeAlerts", "notices"]) {
    const arr = review[key];
    if (Array.isArray(arr)) out.push(...arr);
  }
  return out;
}

function entryText(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    const e = entry as Record<string, unknown>;
    return [e.type, e.code, e.title, e.message, e.detail, e.description, e.severity]
      .filter((x) => typeof x === "string")
      .join(" ");
  }
  return String(entry ?? "");
}

function classify(text: string): ReviewAlert {
  const t = text.toLowerCase();
  if (/halt|suspend/.test(t)) return { kind: "halt", severity: "hard", message: text };
  if (/pattern day|\bpdt\b|day trade/.test(t)) return { kind: "pdt", severity: "hard", message: text };
  if (/buying power|insufficient (funds|buying|cash)|not enough/.test(t)) return { kind: "buying-power", severity: "hard", message: text };
  if (/collar|price (band|collar)|slippage|marketable|away from|protection/.test(t)) return { kind: "collar", severity: "soft", message: text };
  // An explicit severity flag on the entry can still mark it hard.
  if (/\b(error|reject|block|fail)\b/.test(t)) return { kind: "other", severity: "hard", message: text };
  return { kind: "other", severity: "soft", message: text };
}

function extractQuote(review: any): number | null {
  if (!review || typeof review !== "object") return null;
  const q = review.quote ?? review.quotes ?? {};
  return (
    num(review.last_trade_price) ??
    num(review.price) ??
    num(q?.last_trade_price) ??
    num(q?.price) ??
    num(q?.ask_price) ??
    num(review.estimated_price) ??
    null
  );
}

export function parseReview(review: unknown): ParsedReview {
  const entries = alertEntries(review);
  const alerts = entries
    .map((e) => entryText(e).trim())
    .filter(Boolean)
    .map(classify);
  return {
    alerts,
    quote: extractQuote(review),
    hasHard: alerts.some((a) => a.severity === "hard"),
  };
}

/**
 * The pre-trade gate: given a broker review dry-run, THROW on a hard alert
 * (halt / PDT / insufficient buying power) and otherwise return the soft alerts +
 * live quote to record. Every real-money order-placement path routes through this
 * one function, so the manual ticket and the proposal-approval path enforce the
 * same hard-block instead of one inlining it and the other skipping it.
 */
export function gateReview(review: unknown): { alerts: ReviewAlert[]; quote: number | null } {
  const parsed = parseReview(review);
  if (parsed.hasHard) {
    const msgs = parsed.alerts
      .filter((a) => a.severity === "hard")
      .map((a) => `${a.kind}: ${a.message}`)
      .join("; ");
    throw new Error(`Pre-trade review blocked the order — ${msgs}`);
  }
  return { alerts: parsed.alerts, quote: parsed.quote };
}
