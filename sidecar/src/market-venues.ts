import crypto from "node:crypto";
import { ClobClient, OrderType, Side, SignatureTypeV2, AssetType, Chain } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import type { ConnectionsStore, KalshiKey, PolymarketKey, HyperliquidKey } from "./connections.ts";
import type { SettingsStore } from "./settings.ts";

const KALSHI_BASE = {
  demo: "https://external-api.demo.kalshi.co/trade-api/v2",
  prod: "https://external-api.kalshi.com/trade-api/v2",
} as const;

const POLYMARKET_HOST = "https://clob.polymarket.com";

type Venue = "kalshi" | "polymarket" | "hyperliquid";

export interface KalshiOrderInput {
  ticker: unknown;
  side: unknown;
  count: unknown;
  price: unknown;
  timeInForce?: unknown;
  postOnly?: unknown;
  reduceOnly?: unknown;
  clientOrderId?: unknown;
}

export interface PolymarketOrderInput {
  tokenId: unknown;
  side: unknown;
  price?: unknown;
  size?: unknown;
  amount?: unknown;
  orderType?: unknown;
  postOnly?: unknown;
}

export interface HyperliquidOrderInput {
  asset: unknown;
  isBuy: unknown;
  price: unknown;
  size: unknown;
  reduceOnly?: unknown;
  tif?: unknown;
  cloid?: unknown;
}

function ensureObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("expected object payload");
  return value as Record<string, unknown>;
}

function positiveNumber(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
}

function positiveInt(value: unknown, name: string): number {
  const n = positiveNumber(value, name);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer`);
  return n;
}

function fixed(value: unknown, name: string): string {
  const n = positiveNumber(value, name);
  return String(n).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function kalshiTicker(value: unknown): string {
  const ticker = String(value ?? "").toUpperCase().trim();
  if (!/^[A-Z0-9_.-]{2,80}$/.test(ticker)) throw new Error(`bad Kalshi ticker: ${value}`);
  return ticker;
}

function tokenId(value: unknown): string {
  const s = String(value ?? "").trim();
  if (!/^[0-9]{20,90}$/.test(s)) throw new Error("Polymarket tokenId must be a numeric conditional-token id");
  return s;
}

function ethAddress(value: unknown, name: string): `0x${string}` {
  const s = String(value ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) throw new Error(`${name} must be a 0x address`);
  return s as `0x${string}`;
}

function privateKey(value: unknown): `0x${string}` {
  const s = String(value ?? "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(s)) throw new Error("private key must be 0x + 64 hex chars");
  return s as `0x${string}`;
}

function cloid(value: unknown): `0x${string}` | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const s = String(value).trim();
  if (!/^0x[0-9a-fA-F]{32}$/.test(s)) throw new Error("cloid must be 0x + 32 hex chars");
  return s as `0x${string}`;
}

function requireConnected<T>(key: T | null, venue: Venue): T {
  if (!key) throw new Error(`connect ${venue} first`);
  return key;
}

function requireTrading(settings: SettingsStore, venue: Venue): void {
  const cfg = settings.get().connections[venue];
  if (!cfg.trading) throw new Error(`arm ${venue} live trading first`);
}

function paperOrArmed(settings: SettingsStore, venue: Venue): { paper: boolean } {
  const paper = settings.isPaper();
  if (!paper) requireTrading(settings, venue);
  return { paper };
}

class KalshiClient {
  key: KalshiKey;
  base: string;

  constructor(key: KalshiKey) {
    this.key = key;
    this.base = KALSHI_BASE[key.env];
  }

  async get(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<unknown> {
    return this.request("GET", path, { query });
  }

  async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", path, { body });
  }

  private sign(method: string, pathAndQuery: string, timestampMs: string): string {
    const msg = `${timestampMs}${method.toUpperCase()}${pathAndQuery}`;
    return crypto
      .sign("sha256", Buffer.from(msg), {
        key: this.key.privateKeyPem,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      })
      .toString("base64");
  }

  private async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: Record<string, unknown> } = {},
  ): Promise<unknown> {
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`${this.base}${cleanPath}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    const timestamp = String(Date.now());
    const signPath = url.pathname;
    const res = await fetch(url, {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "KALSHI-ACCESS-KEY": this.key.keyId,
        "KALSHI-ACCESS-TIMESTAMP": timestamp,
        "KALSHI-ACCESS-SIGNATURE": this.sign(method, signPath, timestamp),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`Kalshi HTTP ${res.status}: ${data?.message ?? data?.error ?? text}`);
    return data;
  }
}

async function kalshiPublic(
  env: "demo" | "prod",
  path: string,
  query?: Record<string, string | number | boolean | undefined>,
): Promise<unknown> {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${KALSHI_BASE[env]}${cleanPath}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`Kalshi HTTP ${res.status}: ${data?.message ?? data?.error ?? text}`);
  return data;
}

function normalizePolymarketCreds(key: PolymarketKey) {
  const c = key.creds;
  if (!c) return null;
  const apiKey = c.key ?? c.apiKey;
  if (!apiKey || !c.secret || !c.passphrase) return null;
  return { key: apiKey, secret: c.secret, passphrase: c.passphrase, nonce: c.nonce };
}

export class MarketVenues {
  private settings: SettingsStore;
  private connections: ConnectionsStore;

  constructor(settings: SettingsStore, connections: ConnectionsStore) {
    this.settings = settings;
    this.connections = connections;
  }

  docs() {
    return {
      kalshi: [
        "https://docs.kalshi.com/getting_started/api_keys",
        "https://docs.kalshi.com/api-reference/portfolio/get-balance",
        "https://docs.kalshi.com/api-reference/orders/create-order-v2",
      ],
      polymarket: [
        "https://docs.polymarket.com/api-reference/clients-sdks",
        "https://docs.polymarket.com/api-reference/authentication",
        "https://docs.polymarket.com/trading/orders/create",
        "https://docs.polymarket.com/v2-migration",
      ],
      hyperliquid: [
        "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint",
        "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint",
        "https://www.npmjs.com/package/@nktkas/hyperliquid",
      ],
    };
  }

  async statusDeep() {
    const status = this.connections.status();
    const out: Record<string, unknown> = { status, checkedAt: new Date().toISOString() };
    if (status.kalshi.hasStoredKey) out.kalshi = await this.kalshiPortfolio().catch((err) => ({ error: String(err) }));
    if (status.polymarket.hasStoredKey) out.polymarket = await this.polymarketAccount().catch((err) => ({ error: String(err) }));
    if (status.hyperliquid.hasStoredKey) out.hyperliquid = await this.hyperliquidAccount().catch((err) => ({ error: String(err) }));
    return out;
  }

  kalshiClient(): KalshiClient {
    return new KalshiClient(requireConnected(this.connections.kalshiKey(), "kalshi"));
  }

  async kalshiPortfolio() {
    const client = this.kalshiClient();
    const [balance, positions, orders] = await Promise.all([
      client.get("/portfolio/balance"),
      client.get("/portfolio/positions", { limit: 100 }),
      client.get("/portfolio/orders", { status: "open", limit: 100 }),
    ]);
    return { balance, positions, orders };
  }

  async kalshiMarkets(query?: unknown, limit?: unknown) {
    const q = String(query ?? "").trim();
    return kalshiPublic(this.settings.get().connections.kalshi.env, "/markets", {
      status: "open",
      limit: Math.min(200, Math.max(1, Number(limit) || 25)),
      ...(q ? { search: q } : {}),
    });
  }

  async placeKalshiOrder(inputRaw: unknown, confirmed: unknown) {
    const input = ensureObject(inputRaw) as unknown as KalshiOrderInput;
    if (confirmed !== true) throw new Error("Order not confirmed by user");
    const { paper } = paperOrArmed(this.settings, "kalshi");
    const price = positiveNumber(input.price, "price");
    if (price <= 0 || price >= 1) throw new Error("Kalshi price must be between 0 and 1 dollars");
    const side =
      input.side === "bid" || input.side === "buy" ? "bid" : input.side === "ask" || input.side === "sell" ? "ask" : null;
    if (!side) throw new Error("Kalshi side must be bid/buy or ask/sell");
    const body = {
      client_order_id: typeof input.clientOrderId === "string" && input.clientOrderId ? input.clientOrderId : crypto.randomUUID(),
      ticker: kalshiTicker(input.ticker),
      side,
      count: fixed(input.count, "count"),
      type: "limit",
      price: fixed(price, "price"),
      time_in_force: input.timeInForce === "immediate_or_cancel" ? "immediate_or_cancel" : "good_till_canceled",
      self_trade_prevention_type: "taker_at_cross",
      post_only: input.postOnly === true,
      reduce_only: input.reduceOnly === true,
    };
    if (paper) return { paper: true, simulated: body };
    return this.kalshiClient().post("/portfolio/events/orders", body);
  }

  private async polymarketClient(requireAuth: boolean): Promise<ClobClient> {
    const key = this.connections.polymarketKey();
    if (!key) {
      if (requireAuth) throw new Error("connect polymarket first");
      return new ClobClient({ host: POLYMARKET_HOST, chain: Chain.POLYGON });
    }
    const account = privateKeyToAccount(privateKey(key.privateKey));
    const signer = createWalletClient({ account, chain: polygon, transport: http() });
    const funderAddress = key.funder ? ethAddress(key.funder, "funder") : undefined;
    const signatureType = funderAddress ? SignatureTypeV2.POLY_PROXY : SignatureTypeV2.EOA;
    let creds = normalizePolymarketCreds(key);
    if (requireAuth && !creds) {
      const l1 = new ClobClient({
        host: POLYMARKET_HOST,
        chain: Chain.POLYGON,
        signer,
        signatureType,
        funderAddress,
        useServerTime: true,
      });
      creds = await l1.createOrDeriveApiKey();
      this.connections.savePolymarketCreds(creds);
    }
    return new ClobClient({
      host: POLYMARKET_HOST,
      chain: Chain.POLYGON,
      signer,
      creds: creds ?? undefined,
      signatureType,
      funderAddress,
      useServerTime: true,
      retryOnError: true,
    });
  }

  async polymarketMarkets(cursor?: unknown) {
    const client = await this.polymarketClient(false);
    return client.getMarkets(typeof cursor === "string" ? cursor : undefined);
  }

  async polymarketAccount() {
    const client = await this.polymarketClient(true);
    const [openOrders, collateral] = await Promise.all([
      client.getOpenOrders(undefined, true),
      client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }),
    ]);
    return { openOrders, collateral };
  }

  async placePolymarketOrder(inputRaw: unknown, confirmed: unknown) {
    const input = ensureObject(inputRaw) as unknown as PolymarketOrderInput;
    if (confirmed !== true) throw new Error("Order not confirmed by user");
    const { paper } = paperOrArmed(this.settings, "polymarket");
    const side = input.side === "buy" || input.side === "BUY" ? Side.BUY : input.side === "sell" || input.side === "SELL" ? Side.SELL : null;
    if (!side) throw new Error("Polymarket side must be buy or sell");
    const base = { tokenID: tokenId(input.tokenId), side };
    const orderType = input.orderType === "FAK" ? OrderType.FAK : input.orderType === "FOK" ? OrderType.FOK : OrderType.GTC;
    const client = await this.polymarketClient(!paper);
    let body: Record<string, unknown>;
    let result: unknown;
    if (input.amount !== undefined && input.amount !== null && input.amount !== "") {
      body = { ...base, amount: positiveNumber(input.amount, "amount"), price: input.price == null ? undefined : positiveNumber(input.price, "price") };
      if (!paper) result = await client.createAndPostMarketOrder(body as any, undefined, orderType === OrderType.FAK ? OrderType.FAK : OrderType.FOK);
    } else {
      body = { ...base, price: positiveNumber(input.price, "price"), size: positiveNumber(input.size, "size") };
      if (!paper) result = await client.createAndPostOrder(body as any, undefined, OrderType.GTC, input.postOnly === true);
    }
    if (paper) return { paper: true, simulated: { ...body, orderType, postOnly: input.postOnly === true } };
    return result;
  }

  private hyperliquidTransport(key?: HyperliquidKey): HttpTransport {
    const network = key?.network ?? this.settings.get().connections.hyperliquid.network;
    return new HttpTransport({ isTestnet: network !== "mainnet", timeout: 10_000 });
  }

  async hyperliquidPublic(kind?: unknown, coin?: unknown) {
    const info = new InfoClient({ transport: this.hyperliquidTransport() });
    if (kind === "book") return info.l2Book({ coin: String(coin || "BTC") });
    return info.allMids();
  }

  async hyperliquidAccount() {
    const key = requireConnected(this.connections.hyperliquidKey(), "hyperliquid");
    const info = new InfoClient({ transport: this.hyperliquidTransport(key) });
    const user = ethAddress(key.accountAddress, "accountAddress");
    const [clearinghouseState, openOrders] = await Promise.all([
      info.clearinghouseState({ user }),
      info.openOrders({ user }),
    ]);
    return { clearinghouseState, openOrders };
  }

  async placeHyperliquidOrder(inputRaw: unknown, confirmed: unknown) {
    const input = ensureObject(inputRaw) as unknown as HyperliquidOrderInput;
    if (confirmed !== true) throw new Error("Order not confirmed by user");
    const { paper } = paperOrArmed(this.settings, "hyperliquid");
    const key = requireConnected(this.connections.hyperliquidKey(), "hyperliquid");
    const order = {
      a: positiveInt(input.asset, "asset"),
      b: input.isBuy === true || input.isBuy === "true" || input.isBuy === "buy",
      p: fixed(input.price, "price"),
      s: fixed(input.size, "size"),
      r: input.reduceOnly === true,
      t: { limit: { tif: input.tif === "Ioc" || input.tif === "Alo" || input.tif === "FrontendMarket" ? input.tif : "Gtc" } },
      ...(cloid(input.cloid) ? { c: cloid(input.cloid) } : {}),
    };
    if (paper) return { paper: true, simulated: order };
    const wallet = privateKeyToAccount(privateKey(key.agentPrivateKey));
    const exchange = new ExchangeClient({
      transport: this.hyperliquidTransport(key),
      wallet,
    });
    return exchange.order({ orders: [order], grouping: "na" });
  }
}
