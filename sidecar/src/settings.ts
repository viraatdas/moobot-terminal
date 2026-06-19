import fs from "node:fs";
import { SETTINGS_FILE } from "./config.ts";
import { writeJsonFileAtomic } from "./json-store.ts";

/** Autonomous auto-trader config. Approves a live strategy's proposals WITHOUT human
 * review, within hard caps. `allowReal` is the explicit override that lets it place
 * REAL orders (otherwise it only ever simulates in paper mode), so real money is
 * impossible without setting it on purpose. */
export interface AutoTradeConfig {
  enabled: boolean;
  /** When true (default), generated signals are auto-approved within the caps. When
   * false (MANUAL mode), the strategy keeps generating proposals into the pending
   * queue but each one waits for an explicit human approve — same caps still bound the
   * eventual placement. This is the "find trades, but I approve each one" switch. */
  autoApprove: boolean;
  /** Explicit override required for real-money placement (paper needs nothing). */
  allowReal: boolean;
  /** Account auto-trades route to (the agentic account for real money). */
  account: string;
  /** Max $ notional per single trade. */
  maxPerTrade: number;
  /** Max auto-trades per calendar day. */
  maxPerDay: number;
  /** Disable for the day if the account is down more than this ($, positive). */
  dailyLossKill: number;
  /** The strategy tab whose proposals are auto-approved. */
  strategyTabId: string | null;
  /** Which proposals the auto-approve covers: only the wired auto-trader strategy's
   * (`strategy`), or EVERY pending proposal that lands in the queue (`all`) — both
   * bounded by the identical caps + kill-switch + paper short-circuit. */
  approveScope: "strategy" | "all";
  /** Explicit, deliberate override that lets the auto-trader open REAL positions on
   * an UNVERIFIED strategy (the user accepted this is -EV). Scoped strictly to
   * `strategyTabId`; every other strategy stays hard-gated. Worthless without
   * `allowReal` + paper off — the hard caps and the daily-loss kill-switch are the
   * only protection once this is on. A MONEY-ARMING bit: settable ONLY via
   * `setAutoTradeArming` (autotrade.arm/disarm/setup), never the generic merge. */
  acceptUnverifiedReal: boolean;
}

/** NON-SECRET per-venue connection config. Holds only enable flags, modes, and
 * PUBLIC addresses — never private keys (those live in 0o600 secret files, see
 * connections.ts). `trading` is a money-arming bit: settable ONLY via
 * `setConnectionArming`, never the generic `set()` merge — same discipline as the
 * auto-trader's `allowReal`. This block IS broadcast to the UI, so it must stay secret-free. */
export interface ConnectionConfig {
  kalshi: { enabled: boolean; env: "demo" | "prod"; trading: boolean };
  polymarket: { enabled: boolean; trading: boolean };
  hyperliquid: { enabled: boolean; network: "mainnet" | "testnet"; trading: boolean; accountAddress: string };
}

export type Venue = "kalshi" | "polymarket" | "hyperliquid";

export interface Settings {
  /** When true, approvals are simulated against live quotes instead of sent to Robinhood. */
  paperMode: boolean;
  /** When true, agents wake on material events (price moves, new filings), not just the timer. */
  eventTriggers: boolean;
  autoTrade: AutoTradeConfig;
  connections: ConnectionConfig;
}

const DEFAULT_AUTOTRADE: AutoTradeConfig = {
  enabled: false,
  autoApprove: true,
  allowReal: false,
  account: "",
  maxPerTrade: 100,
  maxPerDay: 4,
  dailyLossKill: 80,
  strategyTabId: null,
  approveScope: "strategy",
  acceptUnverifiedReal: false,
};

const DEFAULT_CONNECTIONS: ConnectionConfig = {
  kalshi: { enabled: false, env: "demo", trading: false },
  polymarket: { enabled: false, trading: false },
  hyperliquid: { enabled: false, network: "testnet", trading: false, accountAddress: "" },
};

function cloneConnections(c: ConnectionConfig): ConnectionConfig {
  return { kalshi: { ...c.kalshi }, polymarket: { ...c.polymarket }, hyperliquid: { ...c.hyperliquid } };
}

// Robust load: coerce arbitrary on-disk JSON into a well-typed, default-filled config.
function coerceConnections(raw: unknown): ConnectionConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const k = r.kalshi && typeof r.kalshi === "object" ? r.kalshi : {};
  const p = r.polymarket && typeof r.polymarket === "object" ? r.polymarket : {};
  const h = r.hyperliquid && typeof r.hyperliquid === "object" ? r.hyperliquid : {};
  return {
    kalshi: { enabled: k.enabled === true, env: k.env === "prod" ? "prod" : "demo", trading: k.trading === true },
    polymarket: { enabled: p.enabled === true, trading: p.trading === true },
    hyperliquid: {
      enabled: h.enabled === true,
      network: h.network === "mainnet" ? "mainnet" : "testnet",
      trading: h.trading === true,
      accountAddress: typeof h.accountAddress === "string" ? h.accountAddress : "",
    },
  };
}

const DEFAULTS: Settings = {
  paperMode: false,
  eventTriggers: true,
  autoTrade: { ...DEFAULT_AUTOTRADE },
  connections: cloneConnections(DEFAULT_CONNECTIONS),
};

export class SettingsStore {
  private settings: Settings = { ...DEFAULTS, autoTrade: { ...DEFAULT_AUTOTRADE }, connections: cloneConnections(DEFAULT_CONNECTIONS) };
  onChanged?: (settings: Settings) => void;

  constructor() {
    try {
      const loaded = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
      const obj = loaded && typeof loaded === "object" ? loaded : {};
      this.settings = {
        ...DEFAULTS,
        ...obj,
        autoTrade: { ...DEFAULT_AUTOTRADE, ...(obj.autoTrade && typeof obj.autoTrade === "object" ? obj.autoTrade : {}) },
        connections: coerceConnections(obj.connections),
      };
    } catch {
      this.settings = { ...DEFAULTS, autoTrade: { ...DEFAULT_AUTOTRADE }, connections: cloneConnections(DEFAULT_CONNECTIONS) };
    }
  }

  get(): Settings {
    return { ...this.settings, autoTrade: { ...this.settings.autoTrade }, connections: cloneConnections(this.settings.connections) };
  }

  isPaper(): boolean {
    return this.settings.paperMode === true;
  }

  eventTriggersOn(): boolean {
    return this.settings.eventTriggers === true;
  }

  autoTradeConfig(): AutoTradeConfig {
    return { ...this.settings.autoTrade };
  }

  set(patch: {
    paperMode?: boolean;
    eventTriggers?: boolean;
    autoTrade?: Partial<AutoTradeConfig>;
    connections?: Record<string, any>;
  }): Settings {
    if (typeof patch.paperMode === "boolean") this.settings.paperMode = patch.paperMode;
    if (typeof patch.eventTriggers === "boolean") this.settings.eventTriggers = patch.eventTriggers;
    if (patch.connections && typeof patch.connections === "object") {
      // FIELD-WHITELIST per venue. `trading` is a money-arming bit and is deliberately
      // NOT settable here — it flips ONLY through setConnectionArming (paper-off +
      // key-present gated), mirroring the autoTrade allowReal discipline.
      const pc = patch.connections as Record<string, any>;
      const c = this.settings.connections;
      if (pc.kalshi && typeof pc.kalshi === "object") {
        if (typeof pc.kalshi.enabled === "boolean") c.kalshi.enabled = pc.kalshi.enabled;
        if (pc.kalshi.env === "demo" || pc.kalshi.env === "prod") c.kalshi.env = pc.kalshi.env;
      }
      if (pc.polymarket && typeof pc.polymarket === "object") {
        if (typeof pc.polymarket.enabled === "boolean") c.polymarket.enabled = pc.polymarket.enabled;
      }
      if (pc.hyperliquid && typeof pc.hyperliquid === "object") {
        if (typeof pc.hyperliquid.enabled === "boolean") c.hyperliquid.enabled = pc.hyperliquid.enabled;
        if (pc.hyperliquid.network === "mainnet" || pc.hyperliquid.network === "testnet") c.hyperliquid.network = pc.hyperliquid.network;
        if (typeof pc.hyperliquid.accountAddress === "string") c.hyperliquid.accountAddress = pc.hyperliquid.accountAddress;
      }
    }
    if (patch.autoTrade && typeof patch.autoTrade === "object") {
      // FIELD-WHITELIST the merge — NEVER blind-spread client input into the money-path
      // config. `allowReal` and `acceptUnverifiedReal` are real-money arming bits and are
      // deliberately NOT settable here; they change ONLY through `setAutoTradeArming`
      // (the autotrade.arm/disarm/setup paths, which validate + confirm). Without this,
      // any WS client could flip real money on with no guard. (Reviewed: HIGH finding.)
      const p = patch.autoTrade as Partial<AutoTradeConfig>;
      const at = this.settings.autoTrade;
      if (typeof p.enabled === "boolean") at.enabled = p.enabled;
      if (typeof p.autoApprove === "boolean") at.autoApprove = p.autoApprove;
      if (typeof p.account === "string") at.account = p.account;
      if (typeof p.maxPerTrade === "number" && p.maxPerTrade > 0) at.maxPerTrade = p.maxPerTrade;
      if (typeof p.maxPerDay === "number" && p.maxPerDay > 0) at.maxPerDay = Math.floor(p.maxPerDay);
      if (typeof p.dailyLossKill === "number" && p.dailyLossKill > 0) at.dailyLossKill = p.dailyLossKill;
      if (p.strategyTabId === null || typeof p.strategyTabId === "string") at.strategyTabId = p.strategyTabId;
      if (p.approveScope === "strategy" || p.approveScope === "all") at.approveScope = p.approveScope;
    }
    try {
      writeJsonFileAtomic(SETTINGS_FILE, this.settings);
    } catch (err) {
      console.error(`[settings] persist failed: ${err}`);
    }
    this.onChanged?.(this.get());
    return this.get();
  }

  /** The ONE sanctioned setter for the real-money arming bits (`allowReal`,
   * `acceptUnverifiedReal`) and the `enabled` flag when armed together. The generic
   * `set()` cannot touch the arming bits, so this is the only way they flip — keeping
   * every real-money transition on the deliberate, validated autotrade.arm/disarm path. */
  setAutoTradeArming(opts: { allowReal?: boolean; acceptUnverifiedReal?: boolean; enabled?: boolean }): Settings {
    const at = this.settings.autoTrade;
    if (typeof opts.allowReal === "boolean") at.allowReal = opts.allowReal;
    if (typeof opts.acceptUnverifiedReal === "boolean") at.acceptUnverifiedReal = opts.acceptUnverifiedReal;
    if (typeof opts.enabled === "boolean") at.enabled = opts.enabled;
    try {
      writeJsonFileAtomic(SETTINGS_FILE, this.settings);
    } catch (err) {
      console.error(`[settings] persist failed: ${err}`);
    }
    this.onChanged?.(this.get());
    return this.get();
  }

  /** The ONE sanctioned setter for a venue's `trading` money-arming bit — the
   * generic `set()` cannot touch it. The caller (connections.setArming handler)
   * must independently gate this on paper-OFF + a present, validated secret key. */
  setConnectionArming(venue: Venue, opts: { trading?: boolean }): Settings {
    if (typeof opts.trading === "boolean") this.settings.connections[venue].trading = opts.trading;
    try {
      writeJsonFileAtomic(SETTINGS_FILE, this.settings);
    } catch (err) {
      console.error(`[settings] persist failed: ${err}`);
    }
    this.onChanged?.(this.get());
    return this.get();
  }
}
