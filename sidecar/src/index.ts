import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { ensureDirs, WS_PORT } from "./config.ts";
import { RobinhoodGateway } from "./robinhood.ts";
import { ResearchManager } from "./research.ts";
import { ProposalQueue } from "./proposals.ts";
import { PluginManager } from "./plugins.ts";

ensureDirs();

const rh = new RobinhoodGateway();
const plugins = new PluginManager();
const research = new ResearchManager(plugins);
const proposals = new ProposalQueue(rh, research);

const wss = new WebSocketServer({ host: "127.0.0.1", port: WS_PORT });

function broadcast(event: string, payload: unknown) {
  const msg = JSON.stringify({ type: "event", event, payload });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

rh.onAuthUrl = (url) => broadcast("rh.auth-url", { url });
research.onEvent = (ev) => broadcast("research", ev);
research.onProposalsMaybeChanged = (tabId) => proposals.ingest(tabId);
proposals.onChanged = () => broadcast("proposals.changed", { proposals: proposals.list() });

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
  "research.create": ({ topic, notes, intervalMinutes }) =>
    research.create(topic, notes ?? "", intervalMinutes ?? 30),
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

wss.on("connection", (ws) => {
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
});

console.log(`[moobot-sidecar] listening on ws://127.0.0.1:${WS_PORT}`);

// Connect eagerly if we have tokens (or can import Claude Code's), so the UI
// loads data instantly without a browser round-trip.
if (rh.hasStoredTokens() || rh.importFromClaudeCode()) {
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
