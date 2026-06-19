/**
 * Per-venue authenticated connections (Kalshi / Polymarket / Hyperliquid).
 *
 * Secrets (API keys, RSA PEM, wallet/agent private keys) live ONLY in 0o600 files
 * under DATA_DIR — never in settings.json (which is broadcast to the UI) and never
 * over WS. This store loads/saves those secret files and exposes a strictly REDACTED
 * status(). The non-secret config (enabled/env/network/address/trading) lives in
 * settings.connections. `trading` is a money-arming bit flipped only via the gated
 * connections.setArming handler. Order placement does NOT live here — it will route
 * through the same proposals.approve + paper-mode gate as Robinhood.
 */
import fs from "node:fs";
import { KALSHI_KEY_FILE, POLYMARKET_KEY_FILE, HYPERLIQUID_KEY_FILE } from "./config.ts";
import type { SettingsStore, Venue } from "./settings.ts";

export interface KalshiKey {
  env: "demo" | "prod";
  keyId: string;
  privateKeyPem: string;
}
export interface HyperliquidKey {
  network: "mainnet" | "testnet";
  accountAddress: string;
  agentPrivateKey: string;
}
export interface PolymarketKey {
  privateKey: string;
  funder: string;
  creds?: { key?: string; apiKey?: string; secret: string; passphrase: string; nonce?: number };
}

const FILES: Record<Venue, string> = {
  kalshi: KALSHI_KEY_FILE,
  polymarket: POLYMARKET_KEY_FILE,
  hyperliquid: HYPERLIQUID_KEY_FILE,
};

function loadSecret<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}
function saveSecret(file: string, value: unknown): void {
  // 0o600 — owner read/write only, exactly like robinhood.ts saveAuth.
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}
function removeSecret(file: string): void {
  try {
    fs.rmSync(file);
  } catch {
    /* already gone */
  }
}
function mask(value: string | null | undefined, keep = 4): string | null {
  if (!value) return null;
  const v = String(value);
  return v.length <= keep ? "…" : `…${v.slice(-keep)}`;
}

export class ConnectionsStore {
  private settings: SettingsStore;
  constructor(settings: SettingsStore) {
    this.settings = settings;
  }

  hasKey(venue: Venue): boolean {
    return loadSecret(FILES[venue]) !== null;
  }
  kalshiKey(): KalshiKey | null {
    return loadSecret<KalshiKey>(FILES.kalshi);
  }
  hyperliquidKey(): HyperliquidKey | null {
    return loadSecret<HyperliquidKey>(FILES.hyperliquid);
  }
  polymarketKey(): PolymarketKey | null {
    return loadSecret<PolymarketKey>(FILES.polymarket);
  }

  savePolymarketCreds(creds: { key: string; secret: string; passphrase: string; nonce?: number }): void {
    const current = this.polymarketKey();
    if (!current) throw new Error("connect polymarket first");
    saveSecret(FILES.polymarket, { ...current, creds });
  }

  /** Validate + persist a venue's secret (0o600) and enable the connection. NEVER
   * echoes the secret back; callers return status() only. */
  saveKey(venue: Venue, payload: unknown): void {
    const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, any>;
    if (venue === "kalshi") {
      const env = p.env === "prod" ? "prod" : "demo";
      const keyId = String(p.keyId ?? "").trim();
      const privateKeyPem = String(p.privateKeyPem ?? "").trim();
      if (!keyId) throw new Error("Kalshi: API Key ID is required");
      if (!privateKeyPem.includes("PRIVATE KEY"))
        throw new Error("Kalshi: paste the RSA PRIVATE KEY PEM (the .txt shown once when you created the key)");
      saveSecret(FILES.kalshi, { env, keyId, privateKeyPem });
      this.settings.set({ connections: { kalshi: { enabled: true, env } } });
    } else if (venue === "hyperliquid") {
      const network = p.network === "mainnet" ? "mainnet" : "testnet";
      const accountAddress = String(p.accountAddress ?? "").trim();
      const agentPrivateKey = String(p.agentPrivateKey ?? "").trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(accountAddress))
        throw new Error("Hyperliquid: a 0x… master account address (40 hex chars) is required");
      if (!/^0x[0-9a-fA-F]{64}$/.test(agentPrivateKey))
        throw new Error("Hyperliquid: a 0x… agent/API-wallet private key (64 hex chars) is required");
      saveSecret(FILES.hyperliquid, { network, accountAddress, agentPrivateKey });
      this.settings.set({ connections: { hyperliquid: { enabled: true, network, accountAddress } } });
    } else if (venue === "polymarket") {
      const privateKey = String(p.privateKey ?? "").trim();
      const funder = String(p.funder ?? "").trim();
      if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey))
        throw new Error("Polymarket: a 0x… Polygon wallet private key (64 hex chars) is required");
      saveSecret(FILES.polymarket, { privateKey, funder });
      this.settings.set({ connections: { polymarket: { enabled: true } } });
    } else {
      throw new Error(`unknown venue: ${venue}`);
    }
  }

  /** Remove a venue's secret, then disarm + disable it. */
  clearKey(venue: Venue): void {
    removeSecret(FILES[venue]);
    this.settings.setConnectionArming(venue, { trading: false });
    this.settings.set({ connections: { [venue]: { enabled: false } } });
  }

  /** REDACTED status — safe to send over WS / render. Never includes a private key. */
  status() {
    const c = this.settings.get().connections;
    const k = this.kalshiKey();
    const h = this.hyperliquidKey();
    const p = this.polymarketKey();
    return {
      kalshi: {
        enabled: c.kalshi.enabled,
        env: c.kalshi.env,
        trading: c.kalshi.trading,
        hasStoredKey: !!k,
        keyIdMasked: mask(k?.keyId),
      },
      polymarket: {
        enabled: c.polymarket.enabled,
        trading: c.polymarket.trading,
        hasStoredKey: !!p,
        funderMasked: mask(p?.funder, 6),
      },
      hyperliquid: {
        enabled: c.hyperliquid.enabled,
        network: c.hyperliquid.network,
        trading: c.hyperliquid.trading,
        hasStoredKey: !!h,
        addressMasked: mask(c.hyperliquid.accountAddress, 6),
      },
    };
  }
}

// --- Hyperliquid public read (no key, no signing) ---
const HL_BASE: Record<"mainnet" | "testnet", string> = {
  mainnet: "https://api.hyperliquid.xyz",
  testnet: "https://api.hyperliquid-testnet.xyz",
};

/** POST the public /info endpoint. Read-only market + (public) account state. */
export async function hyperliquidInfo(
  network: "mainnet" | "testnet",
  body: Record<string, unknown>,
): Promise<any> {
  const res = await fetch(`${HL_BASE[network]}/info`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`hyperliquid HTTP ${res.status}`);
  return res.json();
}
