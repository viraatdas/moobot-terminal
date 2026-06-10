import crypto from "node:crypto";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { ensureDirs, WS_PORT, BIND_HOST, SERVER_TOKEN } from "./config.ts";
import { RobinhoodGateway } from "./robinhood.ts";
import { ResearchManager } from "./research.ts";
import { ProposalQueue } from "./proposals.ts";
import { PluginManager } from "./plugins.ts";
import { RobinhoodRestAuth } from "./rh-rest-auth.ts";
import { AlertManager, notify } from "./alerts.ts";

ensureDirs();

const rh = new RobinhoodGateway();
const rhRest = new RobinhoodRestAuth();
const plugins = new PluginManager();
const research = new ResearchManager(plugins);
const proposals = new ProposalQueue(rh, research);
const alerts = new AlertManager(rh);

let wss: WebSocketServer | null = null;

/**
 * Local HTTP API for research agents (separate claude processes that can't use
 * the UI WebSocket). Read-only market data backed by the REST token. Loopback
 * only. Lets the options-research plugin curl live chains/positions.
 */
function isLoopback(req: http.IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

/** In server mode, non-loopback callers must present the shared secret. */
function httpAuthorized(req: http.IncomingMessage, url: URL): boolean {
  if (!SERVER_TOKEN) return true; // local mode, no auth
  if (isLoopback(req)) return true; // in-container agents curl loopback
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  return bearer === SERVER_TOKEN || url.searchParams.get("token") === SERVER_TOKEN;
}

async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${WS_PORT}`);
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  try {
    if (url.pathname === "/health") return send(200, { ok: true });
    if (!httpAuthorized(req, url)) return send(401, { error: "unauthorized" });
    if (url.pathname === "/chain") {
      const symbol = url.searchParams.get("symbol");
      const exp = url.searchParams.get("expiration");
      if (!symbol) return send(400, { error: "symbol required" });
      if (!exp) {
        const expirations = await rhRest.call((r) => r.chainExpirations(symbol));
        return send(200, { symbol, expirations });
      }
      const contracts = await rhRest.call((r) => r.chainForExpiration(symbol, exp));
      return send(200, { symbol, expiration: exp, contracts });
    }
    if (url.pathname === "/positions") {
      const acct = url.searchParams.get("account") || (await rhRest.call((r) => r.accounts()))[0];
      const [equities, options, cryptoPos] = await Promise.all([
        rhRest.call((r) => r.equityPositions(acct)),
        rhRest.call((r) => r.optionPositions(acct)),
        rhRest.call((r) => r.cryptoPositions()).catch(() => []),
      ]);
      return send(200, { account: acct, equities, options, crypto: cryptoPos });
    }
    return send(404, { error: "not found" });
  } catch (err) {
    return send(502, { error: String(err) });
  }
}

function listen(attempt = 0) {
  const httpServer = http.createServer((req, res) => void handleHttp(req, res));
  const server = new WebSocketServer({
    server: httpServer,
    // In server mode, the WS handshake must carry the shared secret.
    verifyClient: (info) => {
      if (!SERVER_TOKEN) return true;
      const url = new URL(info.req.url ?? "/", `http://x:${WS_PORT}`);
      const proto = info.req.headers["sec-websocket-protocol"];
      return url.searchParams.get("token") === SERVER_TOKEN || proto === SERVER_TOKEN;
    },
  });
  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    // A previous sidecar may still hold the port for a moment (app relaunch,
    // dev instance shutting down) — retry before giving up.
    if (err.code === "EADDRINUSE" && attempt < 10) {
      console.error(`[moobot-sidecar] port ${WS_PORT} in use, retry ${attempt + 1}/10`);
      httpServer.close();
      setTimeout(() => listen(attempt + 1), 2000);
      return;
    }
    console.error(`[moobot-sidecar] fatal server error: ${err}`);
    process.exit(1);
  });
  httpServer.on("listening", () => {
    wss = server;
    console.log(
      `[moobot-sidecar] listening on ws+http://${BIND_HOST}:${WS_PORT}` +
        (SERVER_TOKEN ? " (token-protected)" : ""),
    );
  });
  server.on("connection", onConnection);
  httpServer.listen(WS_PORT, BIND_HOST);
}

function broadcast(event: string, payload: unknown) {
  if (!wss) return;
  const msg = JSON.stringify({ type: "event", event, payload });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

rh.onAuthUrl = (url) => broadcast("rh.auth-url", { url });
research.onEvent = (ev) => broadcast("research", ev);
research.onProposalsMaybeChanged = (tabId) => proposals.ingest(tabId);
alerts.onTriggered = (a) => broadcast("alert.triggered", { alert: a });

// Notify (native + UI) when a research agent files a new pending proposal.
let lastPendingIds = new Set(proposals.list().filter((p) => p.status === "pending").map((p) => p.id));
proposals.onChanged = () => {
  const list = proposals.list();
  broadcast("proposals.changed", { proposals: list });
  const pending = list.filter((p) => p.status === "pending");
  for (const p of pending) {
    if (!lastPendingIds.has(p.id)) {
      notify(
        `New trade proposal: ${p.side.toUpperCase()} ${p.quantity} ${p.symbol}`,
        `from "${p.tabTopic}" · conf ${p.confidence}/10`,
      );
    }
  }
  lastPendingIds = new Set(pending.map((p) => p.id));
};

type Handler = (payload: any) => Promise<unknown> | unknown;

const handlers: Record<string, Handler> = {
  "rh.status": () => ({
    authenticated: rh.authenticated,
    hasStoredTokens: rh.hasStoredTokens(),
  }),
  "rh.connect": async () => {
    await rh.connect();
    return { authenticated: true };
  },
  "rh.finish": async ({ codeOrUrl }) => {
    await rh.finishAuthManually(codeOrUrl);
    return { authenticated: true };
  },
  "rh.call": async ({ tool, args }) => {
    if (/place_equity_order|cancel_equity_order/.test(tool)) {
      throw new Error(`${tool} is not callable via rh.call — use the approval flow`);
    }
    return rh.callTool(tool, args ?? {});
  },
  // Full-account REST connection (read + market data).
  "rhrest.status": () => rhRest.status(),
  "rhrest.setToken": ({ token }) => rhRest.setToken(token),
  "account.snapshot": async ({ accountNumber }) => {
    const acct = accountNumber || (await rhRest.call((r) => r.accounts()))[0];
    if (!acct) throw new Error("No account available");
    const [portfolio, equities, options, cryptoPos] = await Promise.all([
      rhRest.call((r) => r.portfolio(acct)),
      rhRest.call((r) => r.equityPositions(acct)),
      rhRest.call((r) => r.optionPositions(acct)),
      rhRest.call((r) => r.cryptoPositions()).catch(() => []),
    ]);
    return { accountNumber: acct, portfolio, equities, options, crypto: cryptoPos };
  },
  "options.chain": async ({ symbol, expiration }) => {
    if (!expiration) {
      const exps = await rhRest.call((r) => r.chainExpirations(symbol));
      return { expirations: exps, contracts: [] };
    }
    const contracts = await rhRest.call((r) => r.chainForExpiration(symbol, expiration));
    return { expirations: [expiration], contracts };
  },
  "alerts.list": () => alerts.list(),
  "alerts.create": ({ symbol, op, price, note }) =>
    alerts.create(symbol, op, Number(price), note ?? ""),
  "alerts.update": ({ id, ...patch }) => alerts.update(id, patch),
  "alerts.remove": ({ id }) => {
    alerts.remove(id);
    return { ok: true };
  },
  "research.runAll": () => {
    for (const tab of research.list()) if (!tab.paused) void research.run(tab.id);
    return { started: true };
  },
  "plugins.list": () => plugins.list(),
  "plugins.setEnabled": ({ name, enabled }) => {
    plugins.setEnabled(name, enabled);
    return plugins.list();
  },
  "plugins.reload": () => {
    plugins.reload();
    return plugins.list();
  },
  "research.list": () => research.list(),
  "research.create": ({ topic, notes, intervalMinutes, type, refs }) =>
    research.create(topic, notes ?? "", intervalMinutes ?? 30, type ?? "research", refs ?? []),
  "research.update": ({ id, ...patch }) => research.update(id, patch),
  "research.remove": ({ id }) => {
    research.remove(id);
    return { ok: true };
  },
  "research.run": ({ id }) => {
    void research.run(id);
    return { started: true };
  },
  "research.findings": ({ id }) => research.findings(id),
  // Manual order ticket — human-initiated from the UI. Review first, then place.
  "trade.review": ({ order }) => rh.callTool("review_equity_order", order),
  "trade.place": async ({ order, confirmed }) => {
    if (confirmed !== true) throw new Error("Order not confirmed by user");
    return rh.callTool("place_equity_order", {
      ...order,
      ref_id: crypto.randomUUID(),
    });
  },
  "proposals.list": () => proposals.list(),
  "proposals.approve": ({ id, accountNumber }) => proposals.approve(id, accountNumber),
  "proposals.reject": ({ id }) => proposals.reject(id),
};

function onConnection(ws: WebSocket) {
  ws.on("message", async (data) => {
    let req: { id: string; type: string; payload?: unknown };
    try {
      req = JSON.parse(data.toString());
    } catch {
      return;
    }
    const handler = handlers[req.type];
    try {
      if (!handler) throw new Error(`Unknown request type: ${req.type}`);
      const result = await handler(req.payload ?? {});
      ws.send(JSON.stringify({ id: req.id, ok: true, data: result }));
    } catch (err) {
      ws.send(JSON.stringify({ id: req.id, ok: false, error: String(err) }));
    }
  });
}

listen();

// Connect eagerly if we have tokens (or can import Claude Code's), so the UI
// loads data instantly without a browser round-trip.
if (rh.hasStoredTokens() || rh.importFromEnv() || rh.importFromClaudeCode()) {
  rh.connect().catch((err) => console.error(`[moobot-sidecar] rh connect: ${err}`));
}

process.on("SIGTERM", () => {
  research.stopAll();
  process.exit(0);
});
process.on("SIGINT", () => {
  research.stopAll();
  process.exit(0);
});
