// Full-account Robinhood read layer over the official REST API (api.robinhood.com).
// Ported from /Users/viraat/Documents/moobot/lib/robinhood/client.ts, adapted to:
//  - take an injected bearer token (no process.env coupling)
//  - throw RobinhoodAuthError on 401 so the auth layer can flag expiry
//  - enrich option positions with strike + live mark + greeks + real P&L
//
// This is the READ + market-data layer. Trading stays on the approval-gated
// agent MCP (robinhood.ts). Nothing here places orders.

const DEFAULT_BASE_URL = "https://api.robinhood.com";
const NUMMUS_BASE_URL = "https://nummus.robinhood.com";
const FETCH_TIMEOUT_MS = 15_000;

export class RobinhoodAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RobinhoodAuthError";
  }
}

type QueryValue = string | number | boolean | undefined | null;

interface ListResponse<T> {
  next: string | null;
  previous: string | null;
  results: T[];
}

export interface PortfolioSnapshot {
  accountNumber: string;
  equity: number;
  cash: number;
  invested: number;
  pnl: number;
  pnlPercent: number;
  previousClose: number;
  asOf: number;
}

export interface EquityPosition {
  kind: "equity";
  symbol: string;
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  value: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
}

export interface OptionPosition {
  kind: "option";
  symbol: string;
  title: string;
  side: "call" | "put";
  strike: number | null;
  expirationDate: string | null;
  daysToExpiry: number | null;
  quantity: number;
  averagePrice: number;
  markPrice: number | null;
  value: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  delta: number | null;
  iv: number | null;
}

export interface CryptoPosition {
  kind: "crypto";
  symbol: string;
  quantity: number;
  averagePrice: number;
  markPrice: number | null;
  value: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
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

function toUnixSeconds(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function daysUntil(dateValue: string | null | undefined): number | null {
  if (!dateValue) return null;
  const ms = Date.parse(dateValue);
  if (!Number.isFinite(ms)) return null;
  return Math.floor((ms - Date.now()) / 86400000);
}

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

export class RobinhoodRest {
  private getToken: () => string;

  constructor(getToken: () => string) {
    this.getToken = getToken;
  }

  private headers() {
    return {
      Authorization: `Bearer ${this.getToken()}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "moobot-terminal/0.1.0",
    };
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: this.headers(),
        cache: "no-store",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    if (res.status === 401 || /jwt verification failed/i.test(text)) {
      throw new RobinhoodAuthError(`Robinhood token expired (${res.status})`);
    }
    if (!res.ok) {
      throw new Error(`Robinhood ${res.status}: ${text.slice(0, 240)}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  private url(base: string, path: string, query?: Record<string, QueryValue>): string {
    const u = new URL(`${base}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
      }
    }
    return u.toString();
  }

  private get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.fetchJson<T>(this.url(DEFAULT_BASE_URL, path, query));
  }

  private async listAll<T>(
    path: string,
    query?: Record<string, QueryValue>,
    maxPages = 10,
  ): Promise<T[]> {
    const all: T[] = [];
    let nextUrl: string | null = null;
    let page = 0;
    while (page < maxPages) {
      const payload: ListResponse<T> = nextUrl
        ? await this.fetchJson<ListResponse<T>>(nextUrl)
        : await this.get<ListResponse<T>>(path, query);
      if (Array.isArray(payload.results)) all.push(...payload.results);
      nextUrl = payload.next || null;
      page += 1;
      if (!nextUrl) break;
    }
    return all;
  }

  /** Verify the token works and return the brokerage account numbers. */
  async accounts(): Promise<string[]> {
    const payload = await this.get<ListResponse<{ account_number: string }>>("/accounts/");
    return (payload.results || []).map((a) => a.account_number).filter(Boolean);
  }

  async portfolio(accountNumber: string): Promise<PortfolioSnapshot> {
    const [accts, value] = await Promise.all([
      this.get<ListResponse<any>>("/accounts/", { account_numbers: accountNumber }),
      this.get<any>("/portfolios/historicals/", { account: accountNumber }).catch(() =>
        this.get<{ results?: any[] }>("/portfolios/", { account_numbers: accountNumber }).then(
          (p) => p.results?.[0] ?? {},
        ),
      ),
    ]);
    const account = accts.results?.[0] ?? {};
    const equity = toNumber(value.equity ?? value.market_value);
    const previousClose = toNumber(
      value.adjusted_portfolio_equity_previous_close ??
        value.portfolio_equity_previous_close ??
        value.equity_previous_close,
    );
    const cash = toNumber(
      account.cash_available_for_withdrawal_without_margin ??
        account.cash_available_for_withdrawal ??
        account.cash ??
        account.buying_power,
    );
    const pnl = previousClose > 0 ? equity - previousClose : 0;
    return {
      accountNumber,
      equity,
      cash,
      invested: Math.max(0, equity - cash),
      pnl,
      pnlPercent: previousClose > 0 ? (pnl / previousClose) * 100 : 0,
      previousClose,
      asOf: Math.floor(Date.now() / 1000),
    };
  }

  async quotes(symbols: string[]): Promise<Map<string, any>> {
    const unique = [...new Set(symbols.filter(Boolean))];
    if (unique.length === 0) return new Map();
    const map = new Map<string, any>();
    for (const batch of chunk(unique, 50)) {
      const payload = await this.get<{ results?: any[] }>("/quotes/", {
        symbols: batch.join(","),
      });
      for (const q of payload.results || []) if (q?.symbol) map.set(q.symbol, q);
    }
    return map;
  }

  async equityPositions(accountNumber: string): Promise<EquityPosition[]> {
    const rows = await this.listAll<any>("/positions/", {
      account_numbers: accountNumber,
      nonzero: true,
    });
    const live = rows.filter((r) => toNumber(r.quantity) > 0);
    const quoteMap = await this.quotes(live.map((r) => r.symbol)).catch(() => new Map());
    return live.map((row) => {
      const symbol = row.symbol || "";
      const quantity = toNumber(row.quantity);
      const averagePrice = toNumber(row.average_buy_price);
      const q = quoteMap.get(symbol);
      const currentPrice = toNumber(
        q?.last_trade_price ?? q?.last_extended_hours_trade_price ?? q?.previous_close,
        averagePrice,
      );
      const totalCost = averagePrice * quantity;
      const value = currentPrice * quantity;
      const unrealizedPnl = value - totalCost;
      return {
        kind: "equity" as const,
        symbol,
        quantity,
        averagePrice,
        currentPrice,
        value,
        unrealizedPnl,
        unrealizedPnlPercent: totalCost > 0 ? (unrealizedPnl / totalCost) * 100 : 0,
      };
    });
  }

  async optionPositions(accountNumber: string): Promise<OptionPosition[]> {
    let rows = await this.listAll<any>("/options/positions/", {
      account_numbers: accountNumber,
      nonzero: true,
    }).catch(() => [] as any[]);
    if (rows.length === 0) {
      rows = await this.listAll<any>("/options/positions/", { account: accountNumber }).catch(
        () => [] as any[],
      );
    }
    const live = rows.filter((r) => toNumber(r.quantity) > 0 && r.option);
    if (live.length === 0) return [];

    // Enrich: fetch each option instrument (strike/expiry/type) + live marketdata.
    const instrumentUrls = [...new Set(live.map((r) => r.option as string))];
    const instruments = new Map<string, any>();
    await Promise.all(
      instrumentUrls.map(async (u) => {
        try {
          instruments.set(u, await this.fetchJson<any>(u));
        } catch {
          /* skip */
        }
      }),
    );
    const market = new Map<string, any>();
    for (const batch of chunk(instrumentUrls, 40)) {
      try {
        const payload = await this.get<{ results?: any[] }>("/marketdata/options/", {
          instruments: batch.join(","),
        });
        for (const m of payload.results || []) if (m?.instrument) market.set(m.instrument, m);
      } catch {
        /* skip batch */
      }
    }

    return live.map((row) => {
      const inst = instruments.get(row.option) ?? {};
      const mkt = market.get(row.option) ?? {};
      const quantity = toNumber(row.quantity);
      const averagePrice = toNumber(row.average_price);
      const multiplier = Math.max(1, toNumber(row.trade_value_multiplier, 100));
      const side: "call" | "put" = (inst.type || row.type) === "put" ? "put" : "call";
      const strike = toNullableNumber(inst.strike_price);
      const expirationDate = inst.expiration_date || row.expiration_date || null;
      const markPrice =
        toNullableNumber(mkt.mark_price) ?? toNullableNumber(mkt.adjusted_mark_price);
      const symbol = row.chain_symbol || inst.chain_symbol || "OPTION";
      // average_price is per-share already scaled by multiplier in RH's API.
      const costBasis = averagePrice * quantity;
      const value = markPrice !== null ? markPrice * quantity * multiplier : costBasis;
      const unrealizedPnl = value - costBasis;
      return {
        kind: "option" as const,
        symbol,
        title: `${symbol} ${side.toUpperCase()}${strike !== null ? ` ${strike}` : ""}${
          expirationDate ? ` ${expirationDate}` : ""
        }`,
        side,
        strike,
        expirationDate,
        daysToExpiry: daysUntil(expirationDate),
        quantity,
        averagePrice,
        markPrice,
        value,
        unrealizedPnl,
        unrealizedPnlPercent: costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : 0,
        delta: toNullableNumber(mkt.delta),
        iv: toNullableNumber(mkt.implied_volatility),
      };
    });
  }

  async cryptoPositions(): Promise<CryptoPosition[]> {
    // nummus is a separate host; same bearer token.
    const holdingsUrl = this.url(NUMMUS_BASE_URL, "/holdings/", { nonzero: "true" });
    const payload = await this.fetchJson<ListResponse<any>>(holdingsUrl).catch(
      () => ({ results: [] }) as ListResponse<any>,
    );
    const rows = (payload.results || []).filter((h) => toNumber(h.quantity) > 0);
    if (rows.length === 0) return [];
    return Promise.all(
      rows.map(async (h) => {
        const symbol = h.currency?.code || h.currency_pair_id || "CRYPTO";
        const quantity = toNumber(h.quantity);
        const costBases = Array.isArray(h.cost_bases) ? h.cost_bases[0] : undefined;
        const directCost = toNumber(costBases?.direct_cost_basis);
        const averagePrice = quantity > 0 && directCost > 0 ? directCost / quantity : 0;
        let markPrice: number | null = null;
        const pairId = h.currency_pair_id;
        if (pairId) {
          try {
            const q = await this.get<any>(`/marketdata/forex/quotes/${pairId}/`);
            markPrice = toNullableNumber(q.mark_price);
          } catch {
            /* skip */
          }
        }
        const value = markPrice !== null ? markPrice * quantity : directCost;
        const unrealizedPnl = value - directCost;
        return {
          kind: "crypto" as const,
          symbol,
          quantity,
          averagePrice,
          markPrice,
          value,
          unrealizedPnl,
          unrealizedPnlPercent: directCost > 0 ? (unrealizedPnl / directCost) * 100 : 0,
        };
      }),
    );
  }

  async chainExpirations(symbol: string): Promise<string[]> {
    const rows = await this.listAll<any>(
      "/options/instruments/",
      { chain_symbol: symbol.toUpperCase(), state: "active", tradability: "tradable" },
      3,
    );
    const set = new Set<string>();
    for (const r of rows) if (r.expiration_date) set.add(r.expiration_date);
    return [...set].sort();
  }

  async chainForExpiration(symbol: string, expirationDate: string): Promise<OptionContract[]> {
    const rows = await this.listAll<any>(
      "/options/instruments/",
      {
        chain_symbol: symbol.toUpperCase(),
        expiration_dates: expirationDate,
        state: "active",
        tradability: "tradable",
      },
      10,
    );
    const instruments = rows
      .filter(
        (r) =>
          toNullableNumber(r.strike_price) !== null &&
          (r.type === "call" || r.type === "put") &&
          (r.url || r.id) &&
          r.expiration_date === expirationDate,
      )
      .map((r) => ({
        strike: toNumber(r.strike_price),
        optionType: r.type as "call" | "put",
        ref: (r.url || r.id) as string,
      }));
    if (instruments.length === 0) return [];

    const market = new Map<string, any>();
    for (const batch of chunk(instruments, 40)) {
      try {
        const payload = await this.get<{ results?: any[] }>("/marketdata/options/", {
          instruments: batch.map((i) => i.ref).join(","),
        });
        for (const m of payload.results || []) if (m?.instrument) market.set(m.instrument, m);
      } catch {
        /* skip batch */
      }
    }
    return instruments
      .map((i) => {
        const m = market.get(i.ref) ?? {};
        const bid = toNullableNumber(m.bid_price);
        const ask = toNullableNumber(m.ask_price);
        return {
          symbol: symbol.toUpperCase(),
          expirationDate,
          strike: i.strike,
          optionType: i.optionType,
          bid,
          ask,
          mark:
            toNullableNumber(m.mark_price) ??
            toNullableNumber(m.adjusted_mark_price) ??
            (bid !== null && ask !== null ? (bid + ask) / 2 : null),
          delta: toNullableNumber(m.delta),
          gamma: toNullableNumber(m.gamma),
          theta: toNullableNumber(m.theta),
          vega: toNullableNumber(m.vega),
          iv: toNullableNumber(m.implied_volatility),
          openInterest: toNullableNumber(m.open_interest),
          volume: toNullableNumber(m.volume),
        };
      })
      .sort((a, b) => a.strike - b.strike);
  }
}
