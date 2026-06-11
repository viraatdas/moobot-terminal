import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.ts";
import type { Position, RobinhoodMcpData } from "./rh-mcp-data.ts";

type WindowKey = "30d" | "90d" | "252d";

interface ReturnPoint {
  date: string;
  value: number;
}

interface PricePoint {
  date: string;
  close: number;
}

interface History {
  symbol: string;
  yahooSymbol: string | null;
  source: "yahoo" | "unavailable";
  points: PricePoint[];
}

interface ExposureNode {
  id: string;
  symbol: string;
  kind: "equity" | "option" | "crypto";
  value: number;
  deltaDollars: number;
  weight: number;
  vol90: number | null;
  betaSpy90: number | null;
}

interface LatticeEdge {
  a: string;
  b: string;
  corr: number;
  corr30: number | null;
  corr90: number | null;
  corr252: number | null;
  source: "measured" | "estimated";
  observations: number;
  riskContribution: number;
}

interface LatticeCluster {
  label: string;
  symbols: string[];
  value: number;
  share: number;
  avgCorr: number;
}

export interface CorrelationLattice {
  updatedAt: string;
  method: string;
  selectedWindow: WindowKey;
  windows: WindowKey[];
  grossExposure: number;
  measuredPct: number;
  avgCorrWeighted: number;
  nodes: ExposureNode[];
  edges: LatticeEdge[];
  clusters: LatticeCluster[];
  insight: string;
}

interface Leg {
  symbol: string;
  kind: "equity" | "option" | "crypto";
  value: number;
  deltaDollars?: number;
  optionDelta?: number | null;
  quantity?: number;
}

const HISTORY_DIR = path.join(DATA_DIR, "market-history");
const CACHE_MS = 12 * 60 * 60 * 1000;
const WINDOWS: Record<WindowKey, number> = { "30d": 30, "90d": 90, "252d": 252 };

function toYahooSymbol(symbol: string): string | null {
  const s = symbol.toUpperCase().replace(/^\$/, "").trim();
  if (!s || s === "CRYPTO") return null;
  if (s === "BTC" || s === "ETH" || s === "SOL" || s === "DOGE") return `${s}-USD`;
  if (s === "BRK.B") return "BRK-B";
  return s.replace(".", "-");
}

function cachePath(symbol: string) {
  return path.join(HISTORY_DIR, `${symbol.replace(/[^A-Z0-9._-]/gi, "_")}.json`);
}

function latestClose(history: History): number | null {
  for (let i = history.points.length - 1; i >= 0; i -= 1) {
    const close = history.points[i]?.close;
    if (Number.isFinite(close) && close > 0) return close;
  }
  return null;
}

function returns(points: PricePoint[]): ReturnPoint[] {
  const out: ReturnPoint[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1]?.close;
    const next = points[i]?.close;
    if (prev > 0 && next > 0) {
      out.push({ date: points[i].date, value: Math.log(next / prev) });
    }
  }
  return out;
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function std(values: number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function corr(a: number[], b: number[]): number | null {
  if (a.length !== b.length || a.length < 12) return null;
  const ma = mean(a);
  const mb = mean(b);
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va === 0 || vb === 0) return null;
  return cov / Math.sqrt(va * vb);
}

function beta(asset: ReturnPoint[], benchmark: ReturnPoint[], window: number): number | null {
  const aligned = align(asset, benchmark, window);
  if (aligned.a.length < 12) return null;
  const ma = mean(aligned.a);
  const mb = mean(aligned.b);
  let cov = 0;
  let vb = 0;
  for (let i = 0; i < aligned.a.length; i += 1) {
    cov += (aligned.a[i] - ma) * (aligned.b[i] - mb);
    vb += (aligned.b[i] - mb) ** 2;
  }
  return vb === 0 ? null : cov / vb;
}

function align(a: ReturnPoint[], b: ReturnPoint[], window: number): { a: number[]; b: number[] } {
  const bm = new Map(b.map((p) => [p.date, p.value]));
  const pairs: Array<{ date: string; a: number; b: number }> = [];
  for (const p of a) {
    const bv = bm.get(p.date);
    if (bv !== undefined) pairs.push({ date: p.date, a: p.value, b: bv });
  }
  const tail = pairs.sort((x, y) => x.date.localeCompare(y.date)).slice(-window);
  return { a: tail.map((p) => p.a), b: tail.map((p) => p.b) };
}

function windowCorr(
  a: ReturnPoint[],
  b: ReturnPoint[],
  window: number,
): { value: number | null; observations: number } {
  const aligned = align(a, b, window);
  return { value: corr(aligned.a, aligned.b), observations: aligned.a.length };
}

function clampCorr(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

function estimateCorr(a: string, b: string): number {
  const pair = new Set([a, b]);
  if (a === b) return 1;
  if (pair.has("SPY") && pair.has("QQQ")) return 0.9;
  if (pair.has("SPY") || pair.has("QQQ")) return 0.62;
  if (pair.has("BTC") || pair.has("ETH")) return 0.35;
  if (pair.has("TLT") || pair.has("GLD")) return -0.15;
  return 0.45;
}

async function loadHistory(symbol: string): Promise<History> {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  const file = cachePath(symbol);
  try {
    const cached = JSON.parse(fs.readFileSync(file, "utf8")) as History & { savedAt: number };
    if (Date.now() - Number(cached.savedAt) < CACHE_MS && Array.isArray(cached.points)) {
      return cached;
    }
  } catch {}

  const yahooSymbol = toYahooSymbol(symbol);
  if (!yahooSymbol) return { symbol, yahooSymbol, source: "unavailable", points: [] };
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    yahooSymbol,
  )}?range=18mo&interval=1d&events=history`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "moobot-terminal/0.1.0" },
    });
    if (!res.ok) throw new Error(`Yahoo ${res.status}`);
    const payload = await res.json();
    const result = payload?.chart?.result?.[0];
    const timestamps: number[] = result?.timestamp ?? [];
    const closes: Array<number | null> = result?.indicators?.quote?.[0]?.close ?? [];
    const points: PricePoint[] = [];
    for (let i = 0; i < timestamps.length; i += 1) {
      const close = closes[i];
      if (typeof close !== "number" || !Number.isFinite(close) || close <= 0) continue;
      points.push({
        date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
        close,
      });
    }
    const history: History = { symbol, yahooSymbol, source: "yahoo", points };
    fs.writeFileSync(file, JSON.stringify({ ...history, savedAt: Date.now() }));
    return history;
  } catch {
    return { symbol, yahooSymbol, source: "unavailable", points: [] };
  }
}

function collectLegs(positions: Position[]): Leg[] {
  const legs: Leg[] = [];
  for (const p of positions) {
    const symbol = String(p.symbol ?? "").toUpperCase();
    if (!symbol) continue;
    if (p.kind === "equity") {
      legs.push({
        symbol,
        kind: "equity",
        value: Math.abs(Number(p.value) || 0),
        deltaDollars: Number(p.value) || 0,
      });
    } else if (p.kind === "option") {
      legs.push({
        symbol,
        kind: "option",
        value: Math.abs(Number(p.value) || 0),
        optionDelta: typeof p.delta === "number" ? p.delta : null,
        quantity: Number(p.quantity) || 0,
      });
    } else if (symbol !== "CRYPTO") {
      legs.push({
        symbol,
        kind: "crypto",
        value: Math.abs(Number(p.value) || 0),
        deltaDollars: Number(p.value) || 0,
      });
    }
  }
  return legs;
}

function aggregateNodes(legs: Leg[], histories: Map<string, History>): ExposureNode[] {
  const bySymbol = new Map<string, ExposureNode & { optionSeen?: boolean }>();
  for (const leg of legs) {
    const h = histories.get(leg.symbol);
    const spot = h ? latestClose(h) : null;
    const deltaDollars =
      leg.deltaDollars ??
      (leg.optionDelta !== null && leg.optionDelta !== undefined && spot !== null
        ? leg.optionDelta * (leg.quantity ?? 0) * 100 * spot
        : Math.sign(leg.quantity ?? 1) * leg.value);
    const existing = bySymbol.get(leg.symbol);
    if (existing) {
      existing.value += leg.value;
      existing.deltaDollars += deltaDollars;
      existing.optionSeen ||= leg.kind === "option";
      if (existing.kind !== "option" && leg.kind === "crypto") existing.kind = "crypto";
    } else {
      bySymbol.set(leg.symbol, {
        id: leg.symbol,
        symbol: leg.symbol,
        kind: leg.kind,
        value: leg.value,
        deltaDollars,
        weight: 0,
        vol90: null,
        betaSpy90: null,
        optionSeen: leg.kind === "option",
      });
    }
  }
  const nodes = [...bySymbol.values()];
  for (const n of nodes) if (n.optionSeen) n.kind = "option";
  const gross = nodes.reduce((sum, n) => sum + Math.abs(n.deltaDollars || n.value), 0) || 1;
  return nodes
    .map((node) => ({
      id: node.id,
      symbol: node.symbol,
      kind: node.kind,
      value: node.value,
      deltaDollars: node.deltaDollars,
      weight: Math.abs(node.deltaDollars || node.value) / gross,
      vol90: node.vol90,
      betaSpy90: node.betaSpy90,
    }))
    .sort((a, b) => Math.abs(b.deltaDollars || b.value) - Math.abs(a.deltaDollars || a.value));
}

function annualVol(points: ReturnPoint[], window: number): number | null {
  const values = points.slice(-window).map((p) => p.value);
  const daily = std(values);
  return daily === null ? null : daily * Math.sqrt(252);
}

function unionClusters(nodes: ExposureNode[], edges: LatticeEdge[]): LatticeCluster[] {
  const parent = new Map(nodes.map((n) => [n.id, n.id]));
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return p;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  for (const e of edges) if (e.corr >= 0.55) union(e.a, e.b);
  const byRoot = new Map<string, string[]>();
  for (const n of nodes) {
    const root = find(n.id);
    byRoot.set(root, [...(byRoot.get(root) ?? []), n.id]);
  }
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const gross = nodes.reduce((sum, n) => sum + n.value, 0) || 1;
  return [...byRoot.values()]
    .filter((symbols) => symbols.length > 1)
    .map((symbols) => {
      const value = symbols.reduce((sum, s) => sum + (nodeById.get(s)?.value ?? 0), 0);
      const pairCorrs = edges
        .filter((e) => symbols.includes(e.a) && symbols.includes(e.b))
        .map((e) => e.corr);
      const avgCorr = pairCorrs.length ? mean(pairCorrs) : 0;
      return {
        label: symbols.slice(0, 3).join(" / "),
        symbols,
        value,
        share: value / gross,
        avgCorr,
      };
    })
    .sort((a, b) => b.value - a.value);
}

function buildInsight(clusters: LatticeCluster[], nodes: ExposureNode[], measuredPct: number): string {
  if (clusters[0]) {
    const c = clusters[0];
    return `${Math.round(c.share * 100)}% of exposed value sits in the ${c.label} cluster; avg corr ${c.avgCorr.toFixed(
      2,
    )}. ${Math.round(measuredPct * 100)}% of relationships are measured from daily returns.`;
  }
  const top = nodes.slice(0, 3).map((n) => n.id).join(" / ");
  return top
    ? `No dominant high-correlation cluster; largest exposures are ${top}. ${Math.round(
        measuredPct * 100,
      )}% of relationships are measured from daily returns.`
    : "No meaningful exposures found for correlation analysis.";
}

export class CorrelationEngine {
  private rhData: RobinhoodMcpData;

  constructor(rhData: RobinhoodMcpData) {
    this.rhData = rhData;
  }

  async lattice(accountNumber?: string): Promise<CorrelationLattice> {
    const snapshot = await this.rhData.snapshot(accountNumber);
    const legs = collectLegs([...snapshot.equities, ...snapshot.options, ...snapshot.crypto]);
    const symbols = [...new Set([...legs.map((l) => l.symbol), "SPY"])];
    const histories = new Map<string, History>();
    await Promise.all(
      symbols.map(async (symbol) => {
        histories.set(symbol, await loadHistory(symbol));
      }),
    );
    const returnsBySymbol = new Map<string, ReturnPoint[]>();
    for (const [symbol, history] of histories) returnsBySymbol.set(symbol, returns(history.points));

    const nodes = aggregateNodes(legs, histories).slice(0, 18);
    const spyReturns = returnsBySymbol.get("SPY") ?? [];
    for (const node of nodes) {
      const rp = returnsBySymbol.get(node.id) ?? [];
      node.vol90 = annualVol(rp, 90);
      node.betaSpy90 = node.id === "SPY" ? 1 : beta(rp, spyReturns, 90);
    }

    const edges: LatticeEdge[] = [];
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i];
        const b = nodes[j];
        const ar = returnsBySymbol.get(a.id) ?? [];
        const br = returnsBySymbol.get(b.id) ?? [];
        const c30 = windowCorr(ar, br, WINDOWS["30d"]);
        const c90 = windowCorr(ar, br, WINDOWS["90d"]);
        const c252 = windowCorr(ar, br, WINDOWS["252d"]);
        const measured = c90.value ?? c252.value ?? c30.value;
        const source = measured === null ? "estimated" : "measured";
        const selected = clampCorr(measured ?? estimateCorr(a.id, b.id));
        const volA = a.vol90 ?? 0.25;
        const volB = b.vol90 ?? 0.25;
        const rawRisk = Math.abs(2 * a.weight * b.weight * selected * volA * volB);
        edges.push({
          a: a.id,
          b: b.id,
          corr: selected,
          corr30: c30.value,
          corr90: c90.value,
          corr252: c252.value,
          source,
          observations: source === "measured" ? Math.max(c90.observations, c252.observations, c30.observations) : 0,
          riskContribution: rawRisk,
        });
      }
    }

    const riskTotal = edges.reduce((sum, e) => sum + e.riskContribution, 0) || 1;
    for (const e of edges) e.riskContribution = e.riskContribution / riskTotal;
    const measuredPct = edges.length
      ? edges.filter((e) => e.source === "measured").length / edges.length
      : 0;
    const clusters = unionClusters(nodes, edges);
    const avgCorrWeighted = edges.reduce((sum, e) => {
      const a = nodes.find((n) => n.id === e.a);
      const b = nodes.find((n) => n.id === e.b);
      return sum + Math.abs(e.corr) * (a?.weight ?? 0) * (b?.weight ?? 0);
    }, 0);
    return {
      updatedAt: new Date().toISOString(),
      method: "MCP exposures + cached daily log-return correlations; estimated edges are explicitly marked",
      selectedWindow: "90d",
      windows: ["30d", "90d", "252d"],
      grossExposure: nodes.reduce((sum, n) => sum + Math.abs(n.deltaDollars || n.value), 0),
      measuredPct,
      avgCorrWeighted,
      nodes,
      edges,
      clusters,
      insight: buildInsight(clusters, nodes, measuredPct),
    };
  }
}
