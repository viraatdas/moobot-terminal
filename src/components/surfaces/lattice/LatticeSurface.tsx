import { useEffect, useMemo, useRef, useState } from "react";
import { fmtMoney } from "../../../lib/client";
import { Cashtags, openTicker } from "../../../lib/cashtags";
import { cleanSymbol, Empty } from "../_shared";
import {
  corrForWindow,
  maybeNumber,
  nodeExposure,
  nodeExposureMagnitude,
  normalizeLatticeNodes,
  type GCluster,
  type GEdge,
  type GNode,
  type LatticeWindow,
} from "./types";

export function LatticeSurface({ data }: { data: any }) {
  const [view, setView] = useState<"graph" | "matrix">("graph");
  const [window, setWindow] = useState<LatticeWindow>("90d");
  if (!data || !Array.isArray(data.nodes) || data.nodes.length === 0)
    return <Empty>No correlation map yet. The agent maps how your holdings move together.</Empty>;

  const nodes = normalizeLatticeNodes(data.nodes);
  const edges: GEdge[] = (Array.isArray(data.edges) ? data.edges : []).map((e: any) => ({
    a: cleanSymbol(e.a),
    b: cleanSymbol(e.b),
    corr: Number(e.corr) || 0,
    corr30: maybeNumber(e.corr30),
    corr90: maybeNumber(e.corr90),
    corr252: maybeNumber(e.corr252),
    source: e.source === "estimated" ? "estimated" : "measured",
    observations: Number(e.observations) || 0,
    riskContribution: Math.max(0, Number(e.riskContribution) || 0),
  }));
  const rawClusters: any[] = Array.isArray(data.clusters) ? data.clusters : [];
  const clusters = rawClusters
    .map((c): GCluster => ({
      label: String(c.label ?? "cluster"),
      symbols: Array.isArray(c.symbols) ? c.symbols.map((s: unknown) => cleanSymbol(s)).filter(Boolean) : [],
      value: Number(c.value) || 0,
      share: Math.max(0, Math.min(1, Number(c.share) || 0)),
      avgCorr: Number(c.avgCorr) || 0,
    }))
    .filter((c) => c.symbols.length > 1)
    .slice(0, 3);

  if (nodes.length === 0)
    return <Empty>No correlation map yet. The agent maps how your holdings move together.</Empty>;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-start gap-3 px-5 pt-4 pb-2">
        {data.insight ? (
          <div className="min-w-0 flex-1 rounded-sm border border-amber/25 bg-amber-dim/40 px-3 py-2 text-[12px] leading-snug text-amber select-text">
            <Cashtags text={data.insight} />
            <div className="mt-1 font-data text-[9.5px] text-amber/70">
              {Math.round((Number(data.measuredPct) || 0) * 100)}% measured · gross{" "}
              {fmtMoney(data.grossExposure)} · {data.method ?? "return correlations"}
            </div>
          </div>
        ) : (
          <div className="flex-1" />
        )}
        <div className="flex shrink-0 flex-col gap-1.5">
          <Segmented
            value={window}
            values={["30d", "90d", "252d"] as const}
            labels={{ "30d": "30D", "90d": "90D", "252d": "1Y" }}
            onChange={setWindow}
          />
          <Segmented
            value={view}
            values={["graph", "matrix"] as const}
            labels={{ graph: "Graph", matrix: "Matrix" }}
            onChange={setView}
          />
        </div>
      </div>

      {(clusters.length > 0 || edges.length > 0) && (
        <div className="grid shrink-0 grid-cols-[1fr_1fr] gap-px border-y border-hairline bg-hairline">
          <ClusterStrip clusters={clusters} />
          <RelationshipStrip nodes={nodes} edges={edges} window={window} />
        </div>
      )}

      {view === "graph" ? (
        <LatticeGraph nodes={nodes} edges={edges} window={window} />
      ) : (
        <LatticeMatrix nodes={nodes} edges={edges} window={window} />
      )}

      <div className="flex shrink-0 flex-wrap gap-x-4 gap-y-1 px-5 py-2 text-[9.5px] text-ink-faint">
        <span>
          <span
            className="mr-1 inline-block h-2 w-3 rounded-sm align-middle"
            style={{ background: "rgba(63,220,151,0.7)" }}
          />
          move together
        </span>
        <span>
          <span
            className="mr-1 inline-block h-2 w-3 rounded-sm align-middle"
            style={{ background: "rgba(255,93,93,0.7)" }}
          />
          move opposite
        </span>
        <span>line width = relationship score · dashed = estimated · node size = $ exposure</span>
      </div>
    </div>
  );
}

function Segmented<T extends string>({
  value,
  values,
  labels,
  onChange,
}: {
  value: T;
  values: readonly T[];
  labels: Record<T, string>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex overflow-hidden rounded-sm border border-hairline">
      {values.map((v) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={`px-2.5 py-1 text-[10px] font-medium tracking-wide uppercase ${
            value === v ? "bg-amber-dim text-amber" : "text-ink-faint hover:text-ink-dim"
          }`}
        >
          {labels[v]}
        </button>
      ))}
    </div>
  );
}

function ClusterStrip({ clusters }: { clusters: GCluster[] }) {
  return (
    <div className="min-w-0 bg-bg px-5 py-2">
      <div className="mb-1 text-[9px] tracking-[0.14em] uppercase text-ink-faint">clusters</div>
      {clusters.length === 0 ? (
        <div className="text-[11px] text-ink-faint">No dominant high-correlation cluster.</div>
      ) : (
        <div className="flex min-w-0 gap-2 overflow-hidden">
          {clusters.map((c) => (
            <div key={c.label} className="min-w-0 rounded-sm border border-hairline bg-panel px-2 py-1">
              <div className="truncate text-[11px] font-semibold text-ink">{c.label}</div>
              <div className="font-data text-[9.5px] text-ink-faint">
                {Math.round(c.share * 100)}% · corr {c.avgCorr.toFixed(2)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RelationshipStrip({
  nodes,
  edges,
  window,
}: {
  nodes: GNode[];
  edges: GEdge[];
  window: LatticeWindow;
}) {
  const nodeSet = new Set(nodes.map((n) => n.id));
  const top = edges
    .filter((e) => nodeSet.has(e.a) && nodeSet.has(e.b))
    .sort((a, b) => b.riskContribution - a.riskContribution)
    .slice(0, 3);
  return (
    <div className="min-w-0 bg-bg px-5 py-2">
      <div className="mb-1 text-[9px] tracking-[0.14em] uppercase text-ink-faint">strongest relationships</div>
      {top.length === 0 ? (
        <div className="text-[11px] text-ink-faint">No pair relationships yet.</div>
      ) : (
        <div className="space-y-1">
          {top.map((e) => {
            const c = corrForWindow(e, window);
            return (
              <div key={`${e.a}-${e.b}`} className="flex items-center gap-2 text-[11px]">
                <span className="font-data min-w-0 flex-1 truncate text-ink">
                  {e.a}/{e.b}
                </span>
                <span className={c >= 0 ? "text-pos" : "text-neg"}>{c.toFixed(2)}</span>
                <span className="font-data text-ink-faint">
                  {(e.riskContribution * 100).toFixed(1)}%
                </span>
                <span className={e.source === "measured" ? "text-ink-faint" : "text-amber"}>
                  {e.source}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function LatticeGraph({
  nodes,
  edges,
  window,
}: {
  nodes: GNode[];
  edges: GEdge[];
  window: LatticeWindow;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 680, h: 440 });
  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>({});
  const [hover, setHover] = useState<string | null>(null);

  const nodeKey = nodes.map((n) => `${n.id}:${n.kind}:${Math.round(n.value)}`).join("|");
  const maxVal = Math.max(1, ...nodes.map((n) => nodeExposureMagnitude(n)));
  const radiusOf = (v: number) => 9 + 24 * Math.sqrt((Math.abs(v) || 0) / maxVal);

  const gEdges = useMemo<GEdge[]>(() => {
    const set = new Set(nodes.map((n) => n.id));
    return edges
      .map((e) => ({ ...e, corr: corrForWindow(e, window) }))
      .filter(
        (e) =>
          e.a !== e.b &&
          set.has(e.a) &&
          set.has(e.b) &&
          (Math.abs(e.corr) >= 0.15 || e.riskContribution >= 0.02),
      );
  }, [nodeKey, edges, window]);

  // The running sim reads the latest edges through a ref, so correlation
  // updates don't force a full re-layout (which would visually reset).
  const edgesRef = useRef(gEdges);
  edgesRef.current = gEdges;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      if (r.width > 20 && r.height > 20) setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const { w, h } = size;
    if (nodes.length === 0 || w < 20) return;
    const cx = w / 2;
    const cy = h / 2;
    const sim = nodes.map((n, i) => {
      const ang = (i / nodes.length) * Math.PI * 2 - Math.PI / 2;
      const rr = Math.min(w, h) / 3;
      return {
        id: n.id,
        x: cx + Math.cos(ang) * rr,
        y: cy + Math.sin(ang) * rr,
        vx: 0,
        vy: 0,
        r: radiusOf(nodeExposure(n)),
      };
    });
    const byId = new Map(sim.map((s) => [s.id, s]));
    const writeOut = () => {
      const out: Record<string, { x: number; y: number }> = {};
      for (const s of sim) out[s.id] = { x: s.x, y: s.y };
      setPos(out);
    };
    writeOut();
    let alpha = 1;
    let raf = 0;
    const tick = () => {
      alpha *= 0.97;
      // pairwise repulsion + hard separation
      for (let i = 0; i < sim.length; i++) {
        for (let j = i + 1; j < sim.length; j++) {
          const a = sim[i];
          const b = sim[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy || 0.01;
          const d = Math.sqrt(d2);
          const ux = dx / d;
          const uy = dy / d;
          const rep = 11000 / d2;
          a.vx += ux * rep;
          a.vy += uy * rep;
          b.vx -= ux * rep;
          b.vy -= uy * rep;
          const minD = a.r + b.r + 22;
          if (d < minD) {
            const push = (minD - d) * 0.5;
            a.vx += ux * push;
            a.vy += uy * push;
            b.vx -= ux * push;
            b.vy -= uy * push;
          }
        }
      }
      // correlation springs: positive corr clusters, negative corr separates.
      // Strength scales with the pair's contribution to portfolio relationship risk.
      for (const e of edgesRef.current) {
        const a = byId.get(e.a);
        const b = byId.get(e.b);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const rest = 80 + (1 - e.corr) * 70; // corr 1 -> 80px, corr -1 -> 220px
        const k = 0.012 + 0.05 * Math.sqrt(Math.min(0.25, e.riskContribution) / 0.25);
        const f = (d - rest) * k;
        const ux = dx / d;
        const uy = dy / d;
        a.vx += ux * f;
        a.vy += uy * f;
        b.vx -= ux * f;
        b.vy -= uy * f;
      }
      // gravity + integrate with friction, clamp to bounds
      const step = Math.min(1, alpha + 0.12);
      for (const s of sim) {
        s.vx += (cx - s.x) * 0.01;
        s.vy += (cy - s.y) * 0.01;
        s.vx *= 0.82;
        s.vy *= 0.82;
        s.x += s.vx * step;
        s.y += s.vy * step;
        const pad = s.r + 6;
        s.x = Math.max(pad, Math.min(w - pad, s.x));
        s.y = Math.max(pad, Math.min(h - pad, s.y));
      }
      writeOut();
      if (alpha > 0.02) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [nodeKey, size.w, size.h]);

  const connected = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of gEdges) {
      if (!m.has(e.a)) m.set(e.a, new Set());
      if (!m.has(e.b)) m.set(e.b, new Set());
      m.get(e.a)!.add(e.b);
      m.get(e.b)!.add(e.a);
    }
    return m;
  }, [gEdges]);

  const kindColor = (kind: string) =>
    kind === "option"
      ? "var(--color-amber)"
      : kind === "crypto"
        ? "var(--color-pos)"
        : "var(--color-ink-dim)";

  const hoverNode = hover ? nodes.find((n) => n.id === hover) : null;
  const hoverNeighbors = hover ? [...(connected.get(hover) ?? [])] : [];

  return (
    <div ref={wrapRef} className="relative min-h-0 flex-1 overflow-hidden">
      <svg width={size.w} height={size.h} className="block">
        {gEdges.map((e, i) => {
          const a = pos[e.a];
          const b = pos[e.b];
          if (!a || !b) return null;
          const active = !hover || e.a === hover || e.b === hover;
          const col = e.corr >= 0 ? "63,220,151" : "255,93,93";
          const relation = Math.min(0.35, e.riskContribution);
          const op = (0.1 + 0.55 * Math.max(Math.abs(e.corr), relation / 0.35)) * (active ? 1 : 0.1);
          return (
            <line
              key={i}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={`rgba(${col},${op})`}
              strokeWidth={1 + 7 * Math.sqrt(relation / 0.35)}
              strokeDasharray={e.source === "estimated" ? "5 5" : undefined}
            >
              <title>
                {`${e.a}/${e.b} ${window}: ${e.corr.toFixed(2)} · relationship ${(e.riskContribution * 100).toFixed(
                  1,
                )}% · ${e.source}${e.observations ? ` · ${e.observations} obs` : ""}`}
              </title>
            </line>
          );
        })}
        {nodes.map((n) => {
          const p = pos[n.id];
          if (!p) return null;
          const r = radiusOf(nodeExposure(n));
          const dim = !!hover && hover !== n.id && !hoverNeighbors.includes(n.id);
          const col = kindColor(n.kind);
          return (
            <g
              key={n.id}
              transform={`translate(${p.x},${p.y})`}
              style={{
                cursor: "pointer",
                opacity: dim ? 0.28 : 1,
                transition: "opacity 0.15s ease",
              }}
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover((cur) => (cur === n.id ? null : cur))}
              onClick={() => openTicker(n.id)}
            >
              <circle
                r={r}
                fill="var(--color-panel-2)"
                stroke={col}
                strokeWidth={hover === n.id ? 2.5 : 1.5}
              />
              <text
                textAnchor="middle"
                dominantBaseline="central"
                className="font-data"
                fill="var(--color-ink)"
                fontSize={Math.max(8, Math.min(12, r * 0.5))}
                style={{ pointerEvents: "none" }}
              >
                {n.id}
              </text>
            </g>
          );
        })}
      </svg>
      {hoverNode && pos[hoverNode.id] && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-sm border border-hairline-2 bg-panel px-2.5 py-1.5 shadow-xl"
          style={{
            left: pos[hoverNode.id].x,
            top: pos[hoverNode.id].y + radiusOf(hoverNode.value) + 8,
          }}
        >
          <div className="font-data text-[11px] font-semibold text-ink">{hoverNode.id}</div>
          <div className="text-[9.5px] text-ink-faint">{hoverNode.kind} · {fmtMoney(hoverNode.value)}</div>
          <div className="font-data text-[9.5px] text-ink-faint">
            delta {fmtMoney(hoverNode.deltaDollars)} · wt {(hoverNode.weight * 100).toFixed(1)}%
          </div>
          <div className="font-data text-[9.5px] text-ink-faint">
            vol {hoverNode.vol90 !== null ? `${Math.round(hoverNode.vol90 * 100)}%` : "n/a"} · beta{" "}
            {hoverNode.betaSpy90 !== null ? hoverNode.betaSpy90.toFixed(2) : "n/a"}
          </div>
        </div>
      )}
    </div>
  );
}

function LatticeMatrix({
  nodes,
  edges,
  window,
}: {
  nodes: GNode[];
  edges: GEdge[];
  window: LatticeWindow;
}) {
  const syms = nodes.map((n) => n.id);
  const corr = (a: string, b: string): number | null => {
    if (a === b) return 1;
    const e = edges.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
    return e ? corrForWindow(e, window) : null;
  };
  const cellColor = (c: number | null) => {
    if (c === null) return "transparent";
    const intensity = Math.min(1, Math.abs(c));
    return c >= 0 ? `rgba(63,220,151,${intensity * 0.7})` : `rgba(255,93,93,${intensity * 0.7})`;
  };
  return (
    <div className="min-h-0 flex-1 overflow-auto p-5">
      <table className="border-collapse">
        <thead>
          <tr>
            <th className="sticky left-0 bg-bg" />
            {syms.map((s) => (
              <th key={s} className="font-data h-16 w-7 px-0 align-bottom text-[9px] text-ink-faint">
                <div className="rotate-180 [writing-mode:vertical-rl]">{s}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {syms.map((a) => (
            <tr key={a}>
              <td className="font-data sticky left-0 bg-bg pr-2 text-right text-[10px] text-ink-dim">
                {a}
              </td>
              {syms.map((b) => {
                const c = corr(a, b);
                return (
                  <td
                    key={b}
                    title={c !== null ? `${a}/${b} ${window}: ${c.toFixed(2)}` : `${a}/${b}: n/a`}
                    className="h-7 w-7 border border-bg text-center"
                    style={{ background: cellColor(c) }}
                  >
                    <span className="font-data text-[8px] text-ink/70">
                      {c !== null && a !== b ? c.toFixed(1).replace("0.", ".") : ""}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
