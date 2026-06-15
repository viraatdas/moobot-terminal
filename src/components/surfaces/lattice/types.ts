import { cleanSymbol } from "../_shared";

/* ---------- Lattice: correlation graph (force-directed) + matrix ---------- */
export type LatticeWindow = "30d" | "90d" | "252d";

export interface GNode {
  id: string;
  kind: string;
  value: number;
  deltaDollars: number;
  weight: number;
  vol90: number | null;
  betaSpy90: number | null;
}
export interface GEdge {
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
export interface GCluster {
  label: string;
  symbols: string[];
  value: number;
  share: number;
  avgCorr: number;
}

export function maybeNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function nodeExposure(node: { deltaDollars?: unknown; value?: unknown }): number {
  return maybeNumber(node.deltaDollars) ?? maybeNumber(node.value) ?? 0;
}

export function nodeExposureMagnitude(node: { deltaDollars?: unknown; value?: unknown }): number {
  return Math.abs(nodeExposure(node));
}

export function corrForWindow(edge: GEdge, window: LatticeWindow): number {
  const value =
    window === "30d" ? edge.corr30 : window === "252d" ? edge.corr252 : edge.corr90;
  return Math.max(-1, Math.min(1, value ?? edge.corr));
}

export function normalizeLatticeNodes(rawNodes: any[]): GNode[] {
  const byId = new Map<string, GNode>();
  for (const raw of rawNodes) {
    const id = cleanSymbol(raw?.symbol ?? raw?.id);
    if (!id) continue;
    const value = Number(raw?.value) || 0;
    const deltaDollars = maybeNumber(raw?.deltaDollars) ?? value;
    const weight = Number(raw?.weight) || 0;
    const existing = byId.get(id);
    if (existing) {
      existing.value += value;
      existing.deltaDollars += deltaDollars;
      existing.weight += weight;
      if (existing.kind === "equity" && raw?.kind) existing.kind = String(raw.kind);
    } else {
      byId.set(id, {
        id,
        kind: String(raw?.kind ?? "equity").toLowerCase(),
        value,
        deltaDollars,
        weight,
        vol90: maybeNumber(raw?.vol90),
        betaSpy90: maybeNumber(raw?.betaSpy90),
      });
    }
  }
  const rows = [...byId.values()].sort(
    (a, b) => nodeExposureMagnitude(b) - nodeExposureMagnitude(a),
  );
  const totalWeight = rows.reduce((sum, n) => sum + n.weight, 0);
  const gross = rows.reduce((sum, n) => sum + nodeExposureMagnitude(n), 0) || 1;
  return rows
    .map((n) => ({ ...n, weight: totalWeight > 0 ? n.weight : nodeExposureMagnitude(n) / gross }))
    .slice(0, 14);
}
