import type { RobinhoodGateway } from "./robinhood.ts";
import { PortfolioHistoryService, type PortfolioDayPerformance } from "./portfolio-history.ts";

export interface PortfolioSnapshot {
  accountNumber: string;
  equity: number;
  cash: number;
  invested: number;
  pnl: number;
  pnlPercent: number;
  pnlLabel: string;
  dayPnl?: number;
  dayPnlPercent?: number;
  dayStartEquity?: number;
  dayStartAt?: number;
  previousClose: number;
  asOf: number;
}

export interface Position {
  kind: "equity" | "option" | "crypto";
  symbol: string;
  title?: string;
  side?: "call" | "put";
  strike?: number | null;
  expirationDate?: string | null;
  daysToExpiry?: number | null;
  quantity: number;
  averagePrice: number;
  currentPrice?: number;
  markPrice?: number | null;
  value: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  delta?: number | null;
  iv?: number | null;
}

export interface OptionContract {
  symbol: string;
  expirationDate: string;
  strike: number;
  optionType: "call" | "put";
  bid: number | null;
  ask: number | null;
  mark: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  iv: number | null;
  openInterest: number | null;
  volume: number | null;
}

function toNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function pickNumber(row: unknown, keys: string[]): number | null {
  if (!row || typeof row !== "object") return null;
  for (const key of keys) {
    let value: unknown = row;
    for (const part of key.split(".")) {
      if (!value || typeof value !== "object") {
        value = undefined;
        break;
      }
      value = (value as Record<string, unknown>)[part];
    }
    const n = toNullableNumber(value);
    if (n !== null) return n;
  }
  return null;
}

function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function pctFromBaseline(change: number, baseline: number): number {
  return baseline > 0 ? (change / baseline) * 100 : 0;
}

function normalizePct(value: number | null): number | null {
  if (value === null) return null;
  return Math.abs(value) <= 1 ? value * 100 : value;
}

function brokerDayPerformance(
  portfolioRaw: unknown,
  equity: number,
  nowMs: number,
): PortfolioDayPerformance | null {
  const previousClose = pickNumber(portfolioRaw, [
    "equity_previous_close",
    "adjusted_equity_previous_close",
    "previous_close_equity",
    "previous_equity",
    "portfolio_previous_close",
    "total_value_previous_close",
    "previous_total_value",
    "previous_close",
  ]);
  if (previousClose !== null && previousClose > 0) {
    const dayPnl = equity - previousClose;
    return {
      dayPnl,
      dayPnlPercent: pctFromBaseline(dayPnl, previousClose),
      dayStartEquity: previousClose,
      dayStartAt: startOfLocalDay(nowMs),
    };
  }

  const dayPnl = pickNumber(portfolioRaw, [
    "day_pnl",
    "day_pnl_amount",
    "today_pnl",
    "todays_pnl",
    "today_profit_loss",
    "todays_return",
    "todays_return_amount",
    "intraday_profit_loss",
  ]);
  if (dayPnl === null) return null;
  const baseline = equity - dayPnl;
  const explicitPct = normalizePct(
    pickNumber(portfolioRaw, [
      "day_pnl_percent",
      "today_pnl_percent",
      "todays_return_percent",
      "intraday_profit_loss_percent",
    ]),
  );
  return {
    dayPnl,
    dayPnlPercent: explicitPct ?? pctFromBaseline(dayPnl, baseline),
    dayStartEquity: baseline,
    dayStartAt: startOfLocalDay(nowMs),
  };
}

function rows(payload: any, key: string): any[] {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.[key])) return payload[key];
  if (Array.isArray(payload?.results)) return payload.results;
  return [];
}

function nextCursor(next: unknown): string | null {
  if (typeof next !== "string" || !next) return null;
  try {
    return new URL(next).searchParams.get("cursor");
  } catch {
    return next;
  }
}

function daysUntil(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return Math.floor((ms - Date.now()) / 86400000);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function quotePrice(row: any): number | null {
  const q = row?.quote ?? row;
  return toNullableNumber(
    q?.last_trade_price ??
      q?.last_non_reg_trade_price ??
      q?.mark_price ??
      q?.adjusted_mark_price ??
      q?.previous_close_price ??
      q?.previous_close,
  );
}

export class RobinhoodMcpData {
  private rh: RobinhoodGateway;
  private history: PortfolioHistoryService | null;

  constructor(rh: RobinhoodGateway, history?: PortfolioHistoryService) {
    this.rh = rh;
    this.history = history ?? null;
  }

  private async allPages(tool: string, args: Record<string, unknown>, key: string): Promise<any[]> {
    const out: any[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i += 1) {
      const payload = await this.rh.callTool(tool, cursor ? { ...args, cursor } : args);
      out.push(...rows(payload, key));
      cursor = nextCursor((payload as any)?.next);
      if (!cursor) break;
    }
    return out;
  }

  async accounts(): Promise<any[]> {
    const payload = await this.rh.callTool("get_accounts");
    return rows(payload, "accounts");
  }

  async snapshot(accountNumber?: string): Promise<{
    accountNumber: string;
    portfolio: PortfolioSnapshot;
    equities: Position[];
    options: Position[];
    crypto: Position[];
  }> {
    const accounts = await this.accounts();
    const acct =
      accountNumber ||
      accounts.find((a) => a?.is_default)?.account_number ||
      accounts[0]?.account_number;
    if (!acct) throw new Error("No Robinhood account available");

    const [portfolioRaw, equities, options] = await Promise.all([
      this.rh.callTool("get_portfolio", { account_number: acct }),
      this.equityPositions(acct),
      this.optionPositions(acct),
    ]);
    const totalValue = toNumber((portfolioRaw as any)?.total_value);
    const cash = toNumber((portfolioRaw as any)?.cash);
    const positions = [...equities, ...options];
    const positionValue = positions.reduce((sum, p) => sum + p.value, 0);
    const pnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
    const costBasis = positionValue - pnl;
    const equity = totalValue || cash + positionValue;
    const nowMs = Date.now();
    const cryptoValue = toNumber((portfolioRaw as any)?.crypto_value);
    const crypto: Position[] =
      cryptoValue > 0
        ? [
            {
              kind: "crypto",
              symbol: "CRYPTO",
              quantity: 0,
              averagePrice: 0,
              markPrice: null,
              value: cryptoValue,
              unrealizedPnl: 0,
              unrealizedPnlPercent: 0,
            },
          ]
        : [];
    if (this.history) {
      this.history.record(acct, {
        time: nowMs,
        equity,
        cash,
        invested: Math.max(0, equity - cash),
        asOf: nowMs,
      });
    }
    const dayPerf =
      brokerDayPerformance(portfolioRaw, equity, nowMs) ??
      this.history?.dayPerformance(acct, equity, nowMs) ??
      null;
    return {
      accountNumber: acct,
      portfolio: {
        accountNumber: acct,
        equity,
        cash,
        invested: Math.max(0, equity - cash),
        pnl,
        pnlPercent: costBasis > 0 ? (pnl / costBasis) * 100 : 0,
        pnlLabel: "unrealized",
        previousClose: dayPerf?.dayStartEquity ?? equity - pnl,
        ...(dayPerf
          ? {
              dayPnl: dayPerf.dayPnl,
              dayPnlPercent: dayPerf.dayPnlPercent,
              dayStartEquity: dayPerf.dayStartEquity,
              dayStartAt: dayPerf.dayStartAt,
            }
          : {}),
        asOf: nowMs,
      },
      equities,
      options,
      crypto,
    };
  }

  /** Latest reference price per symbol. Symbols with no quote are omitted. */
  async quotes(symbols: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const clean = [...new Set(symbols.map((s) => String(s ?? "").toUpperCase()).filter(Boolean))];
    for (const batch of chunk(clean, 20)) {
      let payload: unknown;
      try {
        payload = await this.rh.callTool("get_equity_quotes", { symbols: batch });
      } catch {
        continue;
      }
      for (const row of rows(payload, "results")) {
        const q = (row as any)?.quote ?? row;
        const symbol = String(q?.symbol ?? "").toUpperCase();
        const price = quotePrice(row);
        if (symbol && price !== null) out.set(symbol, price);
      }
    }
    return out;
  }

  async equityPositions(accountNumber: string): Promise<Position[]> {
    const positions = await this.allPages(
      "get_equity_positions",
      { account_number: accountNumber },
      "positions",
    );
    const open = positions.filter((p) => Math.abs(toNumber(p?.quantity)) > 0);
    const symbols = [...new Set(open.map((p) => String(p?.symbol ?? "").toUpperCase()).filter(Boolean))];
    const quotes = new Map<string, any>();
    for (const batch of chunk(symbols, 20)) {
      const payload = await this.rh.callTool("get_equity_quotes", { symbols: batch });
      for (const row of rows(payload, "results")) {
        const q = row?.quote ?? row;
        if (q?.symbol) quotes.set(String(q.symbol).toUpperCase(), row);
      }
    }
    return open.map((p) => {
      const symbol = String(p?.symbol ?? "").toUpperCase();
      const quantity = toNumber(p?.quantity);
      const averagePrice = toNumber(p?.average_buy_price);
      const price = quotePrice(quotes.get(symbol)) ?? averagePrice;
      const value = quantity * price;
      const cost = quantity * averagePrice;
      const unrealizedPnl = value - cost;
      return {
        kind: "equity" as const,
        symbol,
        quantity,
        averagePrice,
        currentPrice: price,
        value,
        unrealizedPnl,
        unrealizedPnlPercent: cost > 0 ? (unrealizedPnl / cost) * 100 : 0,
      };
    });
  }

  async optionPositions(accountNumber: string): Promise<Position[]> {
    const positions = await this.allPages(
      "get_option_positions",
      { account_number: accountNumber, nonzero: true },
      "positions",
    );
    const open = positions.filter((p) => Math.abs(toNumber(p?.quantity)) > 0);
    const ids = [...new Set(open.map((p) => String(p?.option_id ?? "")).filter(Boolean))];
    const instruments = new Map<string, any>();
    for (const batch of chunk(ids, 40)) {
      const payload = await this.rh.callTool("get_option_instruments", {
        ids: batch.join(","),
      });
      for (const inst of rows(payload, "instruments")) {
        if (inst?.id) instruments.set(String(inst.id), inst);
      }
    }
    const quotes = new Map<string, any>();
    for (const batch of chunk(ids, 20)) {
      const payload = await this.rh.callTool("get_option_quotes", { instrument_ids: batch });
      for (const row of rows(payload, "results")) {
        const q = row?.quote ?? row;
        if (q?.instrument_id) quotes.set(String(q.instrument_id), row);
      }
    }
    return open.map((p) => {
      const id = String(p?.option_id ?? "");
      const inst = instruments.get(id) ?? {};
      const qrow = quotes.get(id);
      const q = qrow?.quote ?? qrow ?? {};
      const symbol = String(p?.chain_symbol ?? inst?.chain_symbol ?? "").toUpperCase();
      const optionType = inst?.type === "put" ? "put" : "call";
      const quantity = toNumber(p?.quantity);
      const averagePrice = toNumber(p?.average_price);
      const multiplier = toNumber(p?.trade_value_multiplier ?? 100, 100);
      const markPrice = toNullableNumber(q?.mark_price ?? q?.adjusted_mark_price);
      const cost = averagePrice * quantity;
      const value = markPrice !== null ? markPrice * quantity * multiplier : cost;
      const unrealizedPnl = value - cost;
      const expirationDate = String(p?.expiration_date ?? inst?.expiration_date ?? "") || null;
      const strike = toNullableNumber(inst?.strike_price);
      return {
        kind: "option" as const,
        symbol,
        title: `${symbol} ${expirationDate ?? ""} ${strike ?? ""} ${optionType.toUpperCase()}`,
        side: optionType,
        strike,
        expirationDate,
        daysToExpiry: daysUntil(expirationDate),
        quantity,
        averagePrice,
        markPrice,
        value,
        unrealizedPnl,
        unrealizedPnlPercent: cost > 0 ? (unrealizedPnl / cost) * 100 : 0,
        delta: toNullableNumber(q?.delta),
        iv: toNullableNumber(q?.implied_volatility),
      };
    });
  }

  async optionExpirations(symbol: string): Promise<string[]> {
    const payload = await this.rh.callTool("get_option_chains", {
      underlying_symbol: symbol.toUpperCase(),
    });
    const set = new Set<string>();
    for (const chain of rows(payload, "chains")) {
      for (const exp of chain?.expiration_dates ?? []) set.add(String(exp));
    }
    return [...set].sort();
  }

  async optionChain(symbol: string, expirationDate: string): Promise<OptionContract[]> {
    const instruments = await this.allPages(
      "get_option_instruments",
      {
        chain_symbol: symbol.toUpperCase(),
        expiration_dates: expirationDate,
        state: "active",
        tradability: "tradable",
      },
      "instruments",
    );
    const rowsForDate = instruments.filter(
      (inst) =>
        inst?.expiration_date === expirationDate &&
        (inst?.type === "call" || inst?.type === "put") &&
        toNullableNumber(inst?.strike_price) !== null,
    );
    const ids = rowsForDate.map((inst) => String(inst.id)).filter(Boolean);
    const quotes = new Map<string, any>();
    for (const batch of chunk(ids, 20)) {
      const payload = await this.rh.callTool("get_option_quotes", { instrument_ids: batch });
      for (const row of rows(payload, "results")) {
        const q = row?.quote ?? row;
        if (q?.instrument_id) quotes.set(String(q.instrument_id), row);
      }
    }
    return rowsForDate.map((inst) => {
      const qrow = quotes.get(String(inst.id));
      const q = qrow?.quote ?? qrow ?? {};
      return {
        symbol: symbol.toUpperCase(),
        expirationDate,
        strike: toNumber(inst.strike_price),
        optionType: inst.type === "put" ? "put" : "call",
        bid: toNullableNumber(q?.bid_price),
        ask: toNullableNumber(q?.ask_price),
        mark: toNullableNumber(q?.mark_price ?? q?.adjusted_mark_price),
        delta: toNullableNumber(q?.delta),
        gamma: toNullableNumber(q?.gamma),
        theta: toNullableNumber(q?.theta),
        vega: toNullableNumber(q?.vega),
        iv: toNullableNumber(q?.implied_volatility),
        openInterest: toNullableNumber(q?.open_interest),
        volume: toNullableNumber(q?.volume),
      };
    });
  }
}
