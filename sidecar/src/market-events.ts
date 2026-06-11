import type { Position, RobinhoodMcpData } from "./rh-mcp-data.ts";

export type MarketEventSeverity = "low" | "medium" | "high";

export interface MarketEvent {
  id: string;
  type: "expiry" | "filing" | "news";
  severity: MarketEventSeverity;
  title: string;
  detail: string;
  symbols: string[];
  at: string;
  source?: string;
  details?: Record<string, unknown>;
}

export interface MarketEventsPlaceholder {
  source: "filings" | "news";
  status: "unavailable";
  title: string;
  description: string;
  symbols: string[];
}

export interface MarketEventsResponse {
  updatedAt: string;
  accountNumber: string;
  windowDays: number;
  nearExpiryDays: number;
  events: MarketEvent[];
  placeholders: MarketEventsPlaceholder[];
}

interface ExpirationGroup {
  symbol: string;
  expirationDate: string;
  positions: Position[];
  netQuantity: number;
  absoluteQuantity: number;
  value: number;
  unrealizedPnl: number;
}

function dateOnlyDaysUntil(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return null;
  const expiry = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((expiry - today) / 86400000);
}

function cleanPositiveNumber(value: unknown, fallback: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.floor(n));
}

function formatMoney(value: number): string {
  return `USD ${value.toFixed(2)}`;
}

function contractLabel(value: number): string {
  const rounded = Number.isInteger(value) ? String(value) : value.toFixed(2);
  return `${rounded} contract${Math.abs(value) === 1 ? "" : "s"}`;
}

function severityForDays(days: number): MarketEventSeverity {
  if (days <= 1) return "high";
  if (days <= 3) return "medium";
  return "low";
}

function optionTitle(position: Position): string {
  if (position.title) return position.title;
  const side = position.side ? position.side.toUpperCase() : "OPTION";
  const strike =
    position.strike === null || position.strike === undefined ? "" : ` ${position.strike}`;
  return `${position.symbol} ${position.expirationDate ?? ""}${strike} ${side}`.trim();
}

function normalizeSymbols(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [
    ...new Set(
      values
        .map((value) =>
          String(value ?? "")
            .replace(/^\$/, "")
            .trim()
            .toUpperCase(),
        )
        .filter((symbol) => /^[A-Z0-9.^_-]+$/.test(symbol)),
    ),
  ];
}

function buildPlaceholders(symbols: string[]): MarketEventsPlaceholder[] {
  return [
    {
      source: "filings",
      status: "unavailable",
      title: "Filings unavailable",
      description:
        "No filings calendar is configured for the sidecar. This endpoint does not guess SEC or issuer filing dates.",
      symbols,
    },
    {
      source: "news",
      status: "unavailable",
      title: "News unavailable",
      description:
        "No news feed is configured for the sidecar. This endpoint returns position-derived events only.",
      symbols,
    },
  ];
}

export class MarketEventsService {
  private rhData: RobinhoodMcpData;

  constructor(rhData: RobinhoodMcpData) {
    this.rhData = rhData;
  }

  async events(
    accountNumber?: string,
    opts: { windowDays?: unknown; nearExpiryDays?: unknown; symbols?: unknown } = {},
  ): Promise<MarketEventsResponse> {
    const windowDays = cleanPositiveNumber(opts.windowDays, 45, 366);
    const nearExpiryDays = cleanPositiveNumber(opts.nearExpiryDays, 7, windowDays);
    const snapshot = await this.rhData.snapshot(accountNumber);
    const now = new Date().toISOString();
    const symbols = [
      ...new Set(
        [
          ...normalizeSymbols(opts.symbols),
          ...[...snapshot.equities, ...snapshot.options, ...snapshot.crypto]
            .map((position) => position.symbol)
            .filter(Boolean),
        ].sort(),
      ),
    ];

    const groups = new Map<string, ExpirationGroup>();
    const nearExpiry: MarketEvent[] = [];

    for (const position of snapshot.options) {
      const days = dateOnlyDaysUntil(position.expirationDate);
      if (days === null || days < 0 || days > windowDays || !position.expirationDate) continue;
      const key = `${position.symbol}:${position.expirationDate}`;
      const quantity = Number(position.quantity) || 0;
      const value = Math.abs(Number(position.value) || 0);
      const pnl = Number(position.unrealizedPnl) || 0;
      let existing = groups.get(key);
      if (!existing) {
        existing = {
          symbol: position.symbol,
          expirationDate: position.expirationDate,
          positions: [],
          netQuantity: 0,
          absoluteQuantity: 0,
          value: 0,
          unrealizedPnl: 0,
        };
      }
      existing.positions.push(position);
      existing.netQuantity += quantity;
      existing.absoluteQuantity += Math.abs(quantity);
      existing.value += value;
      existing.unrealizedPnl += pnl;
      groups.set(key, existing);

      if (days <= nearExpiryDays) {
        nearExpiry.push({
          id: `option-near-expiry:${position.symbol}:${position.expirationDate}:${position.side ?? "option"}:${
            position.strike ?? "unknown"
          }`,
          type: "expiry",
          title: `${optionTitle(position)} near expiry`,
          detail: `${contractLabel(Math.abs(quantity))} expire in ${days} day${
            days === 1 ? "" : "s"
          }. Marked value ${formatMoney(value)}.`,
          severity: severityForDays(days),
          symbols: [position.symbol],
          at: position.expirationDate,
          source: "Robinhood MCP",
          details: {
            daysToExpiry: days,
            quantity,
            value,
            unrealizedPnl: pnl,
            side: position.side ?? null,
            strike: position.strike ?? null,
            delta: position.delta ?? null,
            iv: position.iv ?? null,
          },
        });
      }
    }

    const expirations: MarketEvent[] = [...groups.values()].map((group) => {
      const days = dateOnlyDaysUntil(group.expirationDate) ?? 0;
      return {
        id: `option-expiration:${group.symbol}:${group.expirationDate}`,
        type: "expiry",
        title: `${group.symbol} option expiration`,
        detail: `${group.positions.length} open option position${
          group.positions.length === 1 ? "" : "s"
        }, ${contractLabel(group.absoluteQuantity)}, marked value ${formatMoney(group.value)}.`,
        severity: severityForDays(days),
        symbols: [group.symbol],
        at: group.expirationDate,
        source: "Robinhood MCP",
        details: {
          daysToExpiry: days,
          netQuantity: group.netQuantity,
          absoluteQuantity: group.absoluteQuantity,
          value: group.value,
          unrealizedPnl: group.unrealizedPnl,
          positions: group.positions.map((position) => ({
            title: optionTitle(position),
            side: position.side ?? null,
            strike: position.strike ?? null,
            quantity: position.quantity,
            value: position.value,
            unrealizedPnl: position.unrealizedPnl,
            delta: position.delta ?? null,
            iv: position.iv ?? null,
          })),
        },
      };
    });

    return {
      updatedAt: now,
      accountNumber: snapshot.accountNumber,
      windowDays,
      nearExpiryDays,
      events: [...nearExpiry, ...expirations].sort((a, b) => b.at.localeCompare(a.at)),
      placeholders: buildPlaceholders(symbols),
    };
  }
}
