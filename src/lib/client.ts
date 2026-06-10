// WebSocket client for the moobot sidecar.

export type LensType = "research" | "pulse" | "scout" | "exposure" | "lattice" | "trade";

export interface ResearchTab {
  id: string;
  type: LensType;
  topic: string;
  notes: string;
  refs: string[];
  intervalMinutes: number;
  paused: boolean;
  createdAt: string;
  lastRunAt: string | null;
  lastRunStatus: "idle" | "running" | "ok" | "error";
  lastError: string | null;
  sessionId: string | null;
  runCount: number;
}

export const LENS_META: Record<
  LensType,
  { label: string; glyph: string; blurb: string; hasTopic: boolean }
> = {
  research: { label: "Research", glyph: "◎", blurb: "Deep dive on a topic — living thesis + proposals", hasTopic: true },
  pulse: { label: "Pulse", glyph: "◇", blurb: "Live heartbeat — what's moving in your book right now", hasTopic: true },
  scout: { label: "Scout", glyph: "◆", blurb: "Discovery — brings you new setups unprompted", hasTopic: true },
  exposure: { label: "Exposure", glyph: "▦", blurb: "Risk — net delta, scenarios over your book", hasTopic: false },
  lattice: { label: "Lattice", glyph: "⬡", blurb: "Correlation map across all your holdings", hasTopic: false },
  trade: { label: "Trade", glyph: "▲", blurb: "Turn intent + @other tabs into trade proposals", hasTopic: true },
};

export interface ResearchState {
  sentiment?: "bullish" | "bearish" | "neutral";
  conviction?: number;
  headline?: string;
  updatedAt?: string;
}

export interface TradeProposal {
  id: string;
  tabId: string;
  tabTopic: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  orderType: "market" | "limit";
  limitPrice: number | null;
  thesis: string;
  confidence: number;
  timeHorizon: string;
  createdAt: string;
  status: "pending" | "approved" | "rejected" | "failed";
  result: unknown;
  error: string | null;
}

export interface ResearchEvent {
  tabId: string;
  kind: "run-started" | "activity" | "run-finished" | "run-error" | "findings-updated";
  text?: string;
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

export interface AccountSnapshot {
  accountNumber: string;
  portfolio: PortfolioSnapshot;
  equities: Position[];
  options: Position[];
  crypto: Position[];
}

export interface RestStatus {
  connected: boolean;
  hasToken: boolean;
  expired: boolean;
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

type EventHandler = (event: string, payload: any) => void;

const LOCAL_ENDPOINT = "ws://127.0.0.1:4517";

/** Where the UI connects: the local sidecar, or a cloud sidecar (always-on). */
export function getEndpoint(): { url: string; cloud: boolean } {
  const host = localStorage.getItem("moobot.cloud.host"); // e.g. moobot-sidecar.fly.dev
  const token = localStorage.getItem("moobot.cloud.token");
  if (host && token) {
    return { url: `wss://${host}/?token=${encodeURIComponent(token)}`, cloud: true };
  }
  return { url: LOCAL_ENDPOINT, cloud: false };
}

export function setCloudEndpoint(host: string, token: string) {
  localStorage.setItem("moobot.cloud.host", host.replace(/^wss?:\/\//, "").replace(/\/.*$/, ""));
  localStorage.setItem("moobot.cloud.token", token);
}

export function clearCloudEndpoint() {
  localStorage.removeItem("moobot.cloud.host");
  localStorage.removeItem("moobot.cloud.token");
}

class SidecarClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Set<EventHandler>();
  private connListeners = new Set<(up: boolean) => void>();
  connected = false;
  cloud = false;

  start() {
    if (this.ws) return;
    this.connect();
  }

  /** Reconnect to a freshly-changed endpoint. */
  reconnect() {
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
    this.connect();
  }

  private connect() {
    const { url, cloud } = getEndpoint();
    this.cloud = cloud;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      for (const l of this.connListeners) l(true);
    };
    ws.onclose = () => {
      this.connected = false;
      for (const l of this.connListeners) l(false);
      for (const { reject } of this.pending.values())
        reject(new Error("sidecar disconnected"));
      this.pending.clear();
      this.ws = null;
      setTimeout(() => this.connect(), 1000);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (m) => {
      let msg: any;
      try {
        msg = JSON.parse(m.data);
      } catch {
        return;
      }
      if (msg.type === "event") {
        for (const l of this.listeners) l(msg.event, msg.payload);
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new Error(msg.error));
    };
  }

  request<T = any>(type: string, payload?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("sidecar not connected"));
        return;
      }
      const id = String(this.nextId++);
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, type, payload }));
    });
  }

  onEvent(handler: EventHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  onConnection(handler: (up: boolean) => void): () => void {
    this.connListeners.add(handler);
    return () => this.connListeners.delete(handler);
  }
}

export const client = new SidecarClient();

export function fmtMoney(v: number | string | null | undefined): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}
