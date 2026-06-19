import crypto from "node:crypto";

/**
 * Reviewed-order replay guard for the manual trade ticket. trade.review stamps a
 * one-time token bound to a hash of the exact order; trade.place must present
 * that token and the same order or it's rejected. This stops a confirmed order
 * from being placed if it was edited after review, replayed, or never reviewed.
 * The token store is module-private; only remember/consume are exported.
 */

const TRADE_REVIEW_TTL_MS = 5 * 60 * 1000;
const reviewedOrders = new Map<string, { orderKey: string; expiresAt: number }>();

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => [key, sortedJson(val)]),
  );
}

function reviewedOrderKey(order: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(sortedJson(order ?? {})))
    .digest("hex");
}

function pruneReviewedOrders(now = Date.now()) {
  for (const [token, review] of reviewedOrders) {
    if (review.expiresAt <= now) reviewedOrders.delete(token);
  }
}

export function rememberReviewedOrder(order: unknown): { reviewToken: string; expiresAt: string } {
  const now = Date.now();
  pruneReviewedOrders(now);
  const reviewToken = crypto.randomUUID();
  const expiresAt = now + TRADE_REVIEW_TTL_MS;
  reviewedOrders.set(reviewToken, { orderKey: reviewedOrderKey(order), expiresAt });
  return { reviewToken, expiresAt: new Date(expiresAt).toISOString() };
}

export function consumeReviewedOrder(order: unknown, reviewToken: unknown) {
  if (typeof reviewToken !== "string" || !reviewToken) {
    throw new Error("Review this exact order before placing it");
  }
  pruneReviewedOrders();
  const review = reviewedOrders.get(reviewToken);
  if (!review) throw new Error("Order review expired - review the order again");
  reviewedOrders.delete(reviewToken);
  if (review.orderKey !== reviewedOrderKey(order)) {
    throw new Error("Order changed after review - review the order again");
  }
}
