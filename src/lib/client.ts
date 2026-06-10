// WebSocket client for the moobot sidecar.

export interface ResearchTab {
  id: string;
  topic: string;
  notes: string;
  intervalMinutes: number;
  paused: boolean;
  createdAt: string;
  lastRunAt: string | null;
  lastRunStatus: "idle" | "running" | "ok" | "error";
  lastError: string | null;
  sessionId: string | null;
  runCount: number;
}

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

type EventHandler = (event: string, payload: any) => void;

class SidecarClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Set<EventHandler>();
  private connListeners = new Set<(up: boolean) => void>();
  connected = false;

  start() {
    if (this.ws) return;
    this.connect();
  }

  private connect() {
    const ws = new WebSocket("ws://127.0.0.1:4517");
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
