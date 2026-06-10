// Token lifecycle for the full-account Robinhood REST connection.
//
// The token is pulled from a logged-in Robinhood web session. The user can paste
// either the bare access_token or the full `web:auth_state` JSON blob (which also
// carries a refresh_token, letting us auto-refresh instead of re-pasting daily).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "./config.ts";
import { RobinhoodRest, RobinhoodAuthError } from "./robinhood-rest.ts";

const TOKEN_FILE = path.join(DATA_DIR, "rh-rest.json");
// Robinhood's public web client id — used for refresh_token grants.
const RH_WEB_CLIENT_ID = "c82SH0WZOsabOXGP2sxqcj34FxkvfnWRZBKlBjFS";
const OAUTH_TOKEN_URL = "https://api.robinhood.com/oauth2/token/";

interface StoredToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // ms epoch
  savedAt: number;
}

function load(): StoredToken | null {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  } catch {
    return null;
  }
}

function save(tok: StoredToken) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tok, null, 2), { mode: 0o600 });
}

/** Parse a pasted blob: bare token, or `web:auth_state` JSON with refresh_token. */
function parsePaste(raw: string): StoredToken | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    const accessToken = obj.access_token ?? obj.accessToken;
    if (!accessToken) return null;
    return {
      accessToken,
      refreshToken: obj.refresh_token ?? obj.refreshToken,
      expiresAt: obj.expires_in
        ? Date.now() + Number(obj.expires_in) * 1000
        : undefined,
      savedAt: Date.now(),
    };
  } catch {
    // Bare token string.
    return { accessToken: trimmed, savedAt: Date.now() };
  }
}

/** One-time convenience seed from the sibling moobot project's env file. */
function seedFromMoobot(): StoredToken | null {
  const envPath = path.join(os.homedir(), "Documents", "moobot", ".env.local");
  try {
    const text = fs.readFileSync(envPath, "utf8");
    const m = text.match(/^ROBINHOOD_BEARER_TOKEN=(.+)$/m);
    if (!m) return null;
    const accessToken = m[1].trim().replace(/^["']|["']$/g, "");
    if (!accessToken) return null;
    return { accessToken, savedAt: Date.now() };
  } catch {
    return null;
  }
}

export class RobinhoodRestAuth {
  private token: StoredToken | null;
  private expired = false;
  readonly rest: RobinhoodRest;

  constructor() {
    this.token = load() ?? seedFromMoobot();
    if (this.token && !load()) save(this.token); // persist the seed
    this.rest = new RobinhoodRest(() => {
      if (!this.token) throw new RobinhoodAuthError("No Robinhood REST token set");
      return this.token.accessToken;
    });
  }

  status() {
    return {
      connected: Boolean(this.token) && !this.expired,
      hasToken: Boolean(this.token),
      expired: this.expired,
    };
  }

  /** Persist a pasted token/blob and verify it works. */
  async setToken(raw: string): Promise<{ connected: boolean; accounts: string[] }> {
    const parsed = parsePaste(raw);
    if (!parsed) throw new Error("Could not parse token");
    this.token = parsed;
    save(parsed);
    this.expired = false;
    const accounts = await this.rest.accounts(); // throws if bad
    return { connected: true, accounts };
  }

  /** Try a refresh_token grant; returns true on success. */
  private async refresh(): Promise<boolean> {
    if (!this.token?.refreshToken) return false;
    try {
      const res = await fetch(OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: this.token.refreshToken,
          client_id: RH_WEB_CLIENT_ID,
        }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (!data.access_token) return false;
      this.token = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? this.token.refreshToken,
        expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
        savedAt: Date.now(),
      };
      save(this.token);
      this.expired = false;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run a REST read, transparently refreshing once on auth failure. Marks the
   * connection `expired` (for the UI reconnect banner) if refresh can't recover.
   */
  async call<T>(fn: (rest: RobinhoodRest) => Promise<T>): Promise<T> {
    if (!this.token) throw new RobinhoodAuthError("No Robinhood REST token set");
    try {
      const result = await fn(this.rest);
      this.expired = false;
      return result;
    } catch (err) {
      if (err instanceof RobinhoodAuthError) {
        if (await this.refresh()) return fn(this.rest);
        this.expired = true;
      }
      throw err;
    }
  }
}
