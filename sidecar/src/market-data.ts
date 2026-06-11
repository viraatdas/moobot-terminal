import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.ts";

export interface MarketHistoryPoint {
  time: string;
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
}

export interface MarketHistoryMeta {
  currency: string | null;
  exchangeName: string | null;
  instrumentType: string | null;
  timezone: string | null;
  regularMarketPrice: number | null;
  regularMarketTime: string | null;
}

export interface MarketHistory {
  symbol: string;
  yahooSymbol: string | null;
  range: string;
  interval: string;
  source: "yahoo" | "cache" | "unavailable";
  stale: boolean;
  savedAt: number | null;
  updatedAt: string;
  meta: MarketHistoryMeta | null;
  points: MarketHistoryPoint[];
  candles: MarketHistoryPoint[];
  warning?: string;
}

interface CachedMarketHistory extends Omit<MarketHistory, "source"> {
  source: "yahoo" | "cache";
}

const HISTORY_DIR = path.join(DATA_DIR, "market-history", "ohlcv");
const DAILY_CACHE_MS = 12 * 60 * 60 * 1000;
const INTRADAY_CACHE_MS = 15 * 60 * 1000;
const DEFAULT_RANGE = "1y";
const DEFAULT_INTERVAL = "1d";

const VALID_RANGES = new Set([
  "1d",
  "5d",
  "1mo",
  "3mo",
  "6mo",
  "1y",
  "2y",
  "5y",
  "10y",
  "ytd",
  "max",
]);

const VALID_INTERVALS = new Set([
  "1m",
  "2m",
  "5m",
  "15m",
  "30m",
  "60m",
  "90m",
  "1h",
  "1d",
  "5d",
  "1wk",
  "1mo",
  "3mo",
]);

const CRYPTO_SYMBOLS = new Set([
  "ADA",
  "AVAX",
  "BCH",
  "BTC",
  "DOGE",
  "DOT",
  "ETH",
  "LINK",
  "LTC",
  "SHIB",
  "SOL",
  "XRP",
]);

function normalizeSymbol(value: unknown): string {
  const symbol = String(value ?? "")
    .trim()
    .replace(/^\$/, "")
    .toUpperCase();
  if (!symbol || !/^[A-Z0-9.^_-]+$/.test(symbol)) {
    throw new Error("Valid symbol required");
  }
  return symbol;
}

function normalizeRange(value: unknown): string {
  const range = String(value ?? DEFAULT_RANGE).trim().toLowerCase();
  return VALID_RANGES.has(range) ? range : DEFAULT_RANGE;
}

function normalizeInterval(value: unknown): string {
  const interval = String(value ?? DEFAULT_INTERVAL).trim().toLowerCase();
  return VALID_INTERVALS.has(interval) ? interval : DEFAULT_INTERVAL;
}

function toYahooSymbol(symbol: string): string | null {
  if (symbol === "CRYPTO") return null;
  if (symbol.endsWith("-USD")) return symbol;
  if (CRYPTO_SYMBOLS.has(symbol)) return `${symbol}-USD`;
  if (symbol === "BRK.B") return "BRK-B";
  return symbol.replace(/\./g, "-");
}

function cacheTtl(interval: string): number {
  return interval.endsWith("m") || interval.endsWith("h") ? INTRADAY_CACHE_MS : DAILY_CACHE_MS;
}

function cachePath(symbol: string, range: string, interval: string): string {
  const key = `${symbol}_${range}_${interval}`.replace(/[^A-Z0-9.^_-]/gi, "_");
  return path.join(HISTORY_DIR, `${key}.json`);
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function readCache(file: string): CachedMarketHistory | null {
  try {
    const cached = JSON.parse(fs.readFileSync(file, "utf8")) as CachedMarketHistory;
    if (
      typeof cached.symbol === "string" &&
      Array.isArray(cached.points) &&
      typeof cached.savedAt === "number"
    ) {
      return {
        ...cached,
        candles: Array.isArray(cached.candles) ? cached.candles : cached.points,
      };
    }
  } catch {}
  return null;
}

function unavailable(
  symbol: string,
  yahooSymbol: string | null,
  range: string,
  interval: string,
  warning: string,
): MarketHistory {
  return {
    symbol,
    yahooSymbol,
    range,
    interval,
    source: "unavailable",
    stale: false,
    savedAt: null,
    updatedAt: new Date().toISOString(),
    meta: null,
    points: [],
    candles: [],
    warning,
  };
}

function yahooUrl(yahooSymbol: string, range: string, interval: string): string {
  const url = new URL(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}`,
  );
  url.searchParams.set("range", range);
  url.searchParams.set("interval", interval);
  url.searchParams.set("events", "history");
  url.searchParams.set("includePrePost", "false");
  return url.toString();
}

function parseYahooHistory(
  symbol: string,
  yahooSymbol: string,
  range: string,
  interval: string,
  payload: any,
): CachedMarketHistory {
  const result = payload?.chart?.result?.[0];
  const error = payload?.chart?.error;
  if (error) throw new Error(String(error?.description ?? error?.code ?? "Yahoo chart error"));
  if (!result) throw new Error("Yahoo chart returned no result");

  const timestamps: number[] = Array.isArray(result.timestamp) ? result.timestamp : [];
  const quote = result?.indicators?.quote?.[0] ?? {};
  const opens: unknown[] = Array.isArray(quote.open) ? quote.open : [];
  const highs: unknown[] = Array.isArray(quote.high) ? quote.high : [];
  const lows: unknown[] = Array.isArray(quote.low) ? quote.low : [];
  const closes: unknown[] = Array.isArray(quote.close) ? quote.close : [];
  const volumes: unknown[] = Array.isArray(quote.volume) ? quote.volume : [];
  const points: MarketHistoryPoint[] = [];

  for (let i = 0; i < timestamps.length; i += 1) {
    const close = finiteNumber(closes[i]);
    if (close === null || close <= 0) continue;
    const time = new Date(timestamps[i] * 1000).toISOString();
    points.push({
      time,
      date: time.slice(0, 10),
      open: finiteNumber(opens[i]),
      high: finiteNumber(highs[i]),
      low: finiteNumber(lows[i]),
      close,
      volume: finiteNumber(volumes[i]),
    });
  }

  const meta = result.meta ?? {};
  const regularMarketTime = finiteNumber(meta.regularMarketTime);
  const savedAt = Date.now();
  return {
    symbol,
    yahooSymbol,
    range,
    interval,
    source: "yahoo",
    stale: false,
    savedAt,
    updatedAt: new Date(savedAt).toISOString(),
    meta: {
      currency: typeof meta.currency === "string" ? meta.currency : null,
      exchangeName: typeof meta.exchangeName === "string" ? meta.exchangeName : null,
      instrumentType: typeof meta.instrumentType === "string" ? meta.instrumentType : null,
      timezone: typeof meta.timezone === "string" ? meta.timezone : null,
      regularMarketPrice: finiteNumber(meta.regularMarketPrice),
      regularMarketTime:
        regularMarketTime === null ? null : new Date(regularMarketTime * 1000).toISOString(),
    },
    points,
    candles: points,
  };
}

export class MarketData {
  async history(
    rawSymbol: unknown,
    opts: { range?: unknown; interval?: unknown } = {},
  ): Promise<MarketHistory> {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    const symbol = normalizeSymbol(rawSymbol);
    const range = normalizeRange(opts.range);
    const interval = normalizeInterval(opts.interval);
    const yahooSymbol = toYahooSymbol(symbol);
    const file = cachePath(symbol, range, interval);
    const cached = readCache(file);
    const ttl = cacheTtl(interval);

    if (cached && cached.savedAt && Date.now() - cached.savedAt < ttl) {
      return { ...cached, source: "cache", stale: false };
    }
    if (!yahooSymbol) {
      return cached
        ? {
            ...cached,
            source: "cache",
            stale: true,
            warning: "Yahoo symbol unavailable for this instrument.",
          }
        : unavailable(symbol, yahooSymbol, range, interval, "Yahoo symbol unavailable.");
    }

    try {
      const res = await fetch(yahooUrl(yahooSymbol, range, interval), {
        headers: { "User-Agent": "moobot-terminal/0.2.0" },
      });
      if (!res.ok) throw new Error(`Yahoo chart HTTP ${res.status}`);
      const history = parseYahooHistory(symbol, yahooSymbol, range, interval, await res.json());
      fs.writeFileSync(file, JSON.stringify(history, null, 2));
      return history;
    } catch (err) {
      if (cached) {
        return {
          ...cached,
          source: "cache",
          stale: true,
          warning: `Yahoo chart unavailable, serving stale cache: ${String(err)}`,
        };
      }
      return unavailable(symbol, yahooSymbol, range, interval, `Yahoo chart unavailable: ${String(err)}`);
    }
  }
}
