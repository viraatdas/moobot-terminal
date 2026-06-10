import fs from "node:fs";
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { OAUTH_CALLBACK_PORT, RH_AUTH_FILE, RH_MCP_URL } from "./config.ts";

interface PersistedAuth {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

function loadAuth(): PersistedAuth {
  try {
    return JSON.parse(fs.readFileSync(RH_AUTH_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveAuth(auth: PersistedAuth) {
  fs.writeFileSync(RH_AUTH_FILE, JSON.stringify(auth, null, 2), { mode: 0o600 });
}

class FileOAuthProvider implements OAuthClientProvider {
  onAuthUrl?: (url: string) => void;

  get redirectUrl() {
    return `http://localhost:${OAUTH_CALLBACK_PORT}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Moobot Terminal",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  clientInformation() {
    return loadAuth().clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationMixed) {
    saveAuth({ ...loadAuth(), clientInformation: info });
  }

  tokens() {
    return loadAuth().tokens;
  }

  saveTokens(tokens: OAuthTokens) {
    saveAuth({ ...loadAuth(), tokens });
  }

  redirectToAuthorization(url: URL) {
    this.onAuthUrl?.(url.toString());
    spawn("open", [url.toString()], { stdio: "ignore", detached: true }).unref();
  }

  saveCodeVerifier(v: string) {
    saveAuth({ ...loadAuth(), codeVerifier: v });
  }

  codeVerifier() {
    const v = loadAuth().codeVerifier;
    if (!v) throw new Error("No PKCE code verifier saved");
    return v;
  }
}

export class RobinhoodGateway {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private provider = new FileOAuthProvider();
  private connecting: Promise<void> | null = null;
  onAuthUrl?: (url: string) => void;

  get authenticated() {
    return this.client !== null;
  }

  hasStoredTokens() {
    return Boolean(loadAuth().tokens);
  }

  /**
   * Robinhood's authorize page won't issue codes to dynamically-registered
   * clients (it bounces to /agentic), so first-run auth borrows the working
   * credentials Claude Code already holds for this same MCP server from the
   * macOS keychain. Refresh then proceeds normally via the SDK.
   */
  /**
   * Server-mode: load Robinhood MCP tokens from an env secret (no macOS
   * keychain on Linux). RH_MCP_OAUTH is a JSON blob
   * {accessToken, refreshToken, clientId, expiresAt, scope}.
   */
  importFromEnv(): boolean {
    const blob = process.env.RH_MCP_OAUTH;
    if (!blob) return false;
    try {
      const rh = JSON.parse(blob);
      if (!rh.accessToken) return false;
      saveAuth({
        clientInformation: { client_id: rh.clientId },
        tokens: {
          access_token: rh.accessToken,
          refresh_token: rh.refreshToken,
          token_type: "bearer",
          scope: rh.scope ?? "internal",
          expires_in: Math.max(
            60,
            Math.floor((Number(rh.expiresAt ?? Date.now() + 3600_000) - Date.now()) / 1000),
          ),
        },
      });
      console.log("[robinhood] imported credentials from RH_MCP_OAUTH env");
      return true;
    } catch {
      return false;
    }
  }

  importFromClaudeCode(): boolean {
    try {
      const raw = execFileSync(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { encoding: "utf8" },
      );
      const creds = JSON.parse(raw);
      const key = Object.keys(creds.mcpOAuth ?? {}).find((k) =>
        k.startsWith("robinhood-trading|"),
      );
      if (!key) return false;
      const rh = creds.mcpOAuth[key];
      if (!rh.accessToken) return false;
      saveAuth({
        clientInformation: { client_id: rh.clientId },
        tokens: {
          access_token: rh.accessToken,
          refresh_token: rh.refreshToken,
          token_type: "bearer",
          scope: rh.scope,
          expires_in: Math.max(
            60,
            Math.floor((Number(rh.expiresAt) - Date.now()) / 1000),
          ),
        },
      });
      console.log("[robinhood] imported credentials from Claude Code keychain");
      return true;
    } catch {
      return false;
    }
  }

  /** Connect, driving the OAuth flow (browser + local callback) if needed. */
  async connect(): Promise<void> {
    if (this.client) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    this.provider.onAuthUrl = (url) => this.onAuthUrl?.(url);
    if (!this.hasStoredTokens()) this.importFromEnv() || this.importFromClaudeCode();
    try {
      await this.tryConnect();
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;
      // Browser has been opened by the provider; wait for the callback.
      const code = await this.waitForCallback();
      await this.transport!.finishAuth(code);
      this.client = null;
      this.transport = null;
      await this.tryConnect();
    }
  }

  private async tryConnect(): Promise<void> {
    const transport = new StreamableHTTPClientTransport(new URL(RH_MCP_URL), {
      authProvider: this.provider,
    });
    const client = new Client({ name: "moobot-terminal", version: "0.1.0" });
    this.transport = transport;
    try {
      await client.connect(transport);
      this.client = client;
    } catch (err) {
      this.client = null;
      throw err;
    }
  }

  private waitForCallback(): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", `http://localhost:${OAUTH_CALLBACK_PORT}`);
        if (url.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<html><body style='font-family:-apple-system;background:#0a0b0e;color:#e8e8ea;display:grid;place-items:center;height:100vh'><div><h2>Moobot Terminal connected to Robinhood</h2><p>You can close this tab.</p></div></body></html>",
        );
        server.close();
        clearTimeout(timer);
        if (code) resolve(code);
        else reject(new Error(`OAuth failed: ${error ?? "no code returned"}`));
      });
      server.listen(OAUTH_CALLBACK_PORT);
      server.on("error", reject);
      const timer = setTimeout(
        () => {
          server.close();
          reject(new Error("OAuth timed out after 5 minutes"));
        },
        5 * 60 * 1000,
      );
    });
  }

  /**
   * Manual fallback: finish OAuth from a pasted callback URL (or bare code)
   * when the localhost redirect didn't reach us.
   */
  async finishAuthManually(codeOrUrl: string): Promise<void> {
    let code = codeOrUrl.trim();
    try {
      const url = new URL(codeOrUrl);
      code = url.searchParams.get("code") ?? code;
    } catch {
      // bare code, use as-is
    }
    const transport = new StreamableHTTPClientTransport(new URL(RH_MCP_URL), {
      authProvider: this.provider,
    });
    await transport.finishAuth(code);
    this.client = null;
    this.transport = null;
    await this.tryConnect();
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.client) await this.connect();
    try {
      return await this.call(name, args);
    } catch (err) {
      // Token may have expired mid-session: reconnect once and retry.
      if (err instanceof UnauthorizedError || /401|unauthorized/i.test(String(err))) {
        this.client = null;
        await this.connect();
        return await this.call(name, args);
      }
      throw err;
    }
  }

  private async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.client!.callTool({ name, arguments: args });
    if (result.isError) {
      const text = (result.content as Array<{ type: string; text?: string }>)
        ?.map((c) => c.text ?? "")
        .join("\n");
      throw new Error(text || `Tool ${name} failed`);
    }
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    try {
      const parsed = JSON.parse(text);
      // Robinhood wraps results in a {"data": ..., "guide": "..."} envelope —
      // unwrap the data, drop the agent-guidance prose.
      if (parsed && typeof parsed === "object" && "data" in parsed) {
        return parsed.data;
      }
      return parsed;
    } catch {
      return text;
    }
  }

  async listTools(): Promise<string[]> {
    if (!this.client) await this.connect();
    const { tools } = await this.client!.listTools();
    return tools.map((t) => t.name);
  }
}
