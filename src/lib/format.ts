// Shared presentational format helpers, deduplicated from component-local copies.
import { fmtMoney } from "./client";

/** Tailwind text-color class for a number's sign (pos/neg, or neutral ink when n/a). */
export function signTone(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "text-ink";
  return v >= 0 ? "text-pos" : "text-neg";
}

/**
 * "Mon D, h:mm AM/PM" timestamp label. Accepts an ISO string or epoch-ms number.
 * On an unparseable value, returns the original string form (preserving the
 * prior `timeLabel` behavior; PortfolioPerformance* only ever passes valid ms).
 */
export function fmtDateTime(value: string | number): string {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return typeof value === "string" ? value : "";
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${d.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

/** Money string with an explicit leading "+" for non-negative values. */
export function fmtSigned(n: number): string {
  return `${n >= 0 ? "+" : ""}${fmtMoney(n)}`;
}
