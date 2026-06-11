import { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import type { LensType } from "../lib/client";
import { fmtMoney } from "../lib/client";
import { Cashtags, onCashtagClick, openTicker } from "../lib/cashtags";

interface Props {
  type: LensType;
  lens: Record<string, any>;
}

export function LensSurface({ type, lens }: Props) {
  switch (type) {
    case "pulse":
      return <PulseSurface items={lens["pulse.json"] ?? []} />;
    case "scout":
      return <ScoutSurface items={lens["scout.json"] ?? []} />;
    case "thesis":
      return <ThesisSurface data={lens["thesis.json"]} />;
    case "exposure":
      return <ExposureSurface data={lens["exposure.json"]} />;
    case "lattice":
      return <LatticeSurface data={lens["lattice.json"]} />;
    case "trade":
      return <TradeSurface markdown={lens["trade.md"] ?? ""} />;
    default:
      return null;
  }
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center text-[13px] text-ink-faint">
      {children}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 text-[10px] tracking-[0.16em] uppercase text-ink-faint">{children}</div>
  );
}

/** A clickable $TICKER pill that opens the options chain. */
function Ticker({ sym }: { sym: string }) {
  const s = cleanSymbol(sym);
  if (!s) return <span className="text-ink-faint">—</span>;
  return (
    <button className="cashtag" onClick={() => openTicker(s)}>
      ${s}
    </button>
  );
}

function cleanSymbol(value: unknown): string {
  return String(value ?? "")
    .replace(/^\$/, "")
    .trim()
    .toUpperCase();
}

function sourceLabel(s: any): string {
  if (s?.title) return String(s.title).slice(0, 44);
  try {
    return new URL(String(s?.url)).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
}

/* ---------- Pulse: impact-ranked timeline ---------- */
function PulseSurface({ items }: { items: any[] }) {
  if (!Array.isArray(items) || items.length === 0)
    return <Empty>No pulse yet. The agent scans your book for what's moving.</Empty>;
  const sorted = [...items].sort((a, b) => (b.impact ?? 0) - (a.impact ?? 0));
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <div className="space-y-2">
        {sorted.map((it, i) => {
          const impact = Number(it.impact) || 0;
          const dirColor =
            it.direction === "up" ? "text-pos" : it.direction === "down" ? "text-neg" : "text-ink-dim";
          return (
            <div key={i} className="flex gap-3 rounded-sm border border-hairline bg-panel p-3">
              <div className="flex flex-col items-center pt-0.5">
                <div
                  className={`font-data text-[15px] font-semibold ${
                    impact >= 7 ? "text-amber" : impact >= 4 ? "text-ink" : "text-ink-faint"
                  }`}
                >
                  {impact}
                </div>
                <div className="mt-1 h-10 w-1 rounded-full bg-bg">
                  <div
                    className={`w-full rounded-full ${impact >= 7 ? "bg-amber" : "bg-ink-faint"}`}
                    style={{ height: `${Math.min(100, impact * 10)}%` }}
                  />
                </div>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className={`text-[13px] font-semibold ${dirColor}`}>
                    <Cashtags text={it.headline} />
                  </span>
                  <span className="font-data shrink-0 text-[9.5px] text-ink-faint">
                    {(it.symbols ?? []).slice(0, 4).join(" ")}
                  </span>
                </div>
                <div className="mt-0.5 text-[12px] leading-snug text-ink-dim select-text">
                  <Cashtags text={it.detail} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- Scout: discovery candidate cards ---------- */
function ScoutSurface({ items }: { items: any[] }) {
  if (!Array.isArray(items) || items.length === 0)
    return <Empty>No candidates yet. Scout hunts setups that fit your book.</Empty>;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <div className="grid grid-cols-2 gap-3">
        {items.map((it, i) => (
          <div key={i} className="rounded-sm border border-hairline bg-panel p-3">
            <div className="flex items-baseline justify-between">
              <span className="font-data text-[14px] font-semibold text-ink">{it.symbol}</span>
              <span
                className={`text-[10px] font-semibold uppercase ${
                  it.direction === "short" ? "text-neg" : "text-pos"
                }`}
              >
                {it.direction ?? "long"} · {it.confidence ?? "?"}/10
              </span>
            </div>
            <div className="mt-1 text-[11px] font-medium text-amber">{it.setup}</div>
            <div className="mt-1 text-[11.5px] leading-snug text-ink-dim select-text">
              <Cashtags text={it.thesis} />
            </div>
            {it.timeHorizon && (
              <div className="font-data mt-1.5 text-[9.5px] text-ink-faint">{it.timeHorizon}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- Thesis: belief vs. book + sourced ideas ---------- */
function fitTone(fit: string): { text: string; border: string } {
  const f = fit.toLowerCase();
  if (f === "supports") return { text: "text-pos", border: "var(--color-pos)" };
  if (f === "contradicts") return { text: "text-neg", border: "var(--color-neg)" };
  return { text: "text-ink-dim", border: "var(--color-ink-faint)" };
}

function AlignmentRing({ value }: { value: number }) {
  const v = Math.max(0, Math.min(100, value));
  const R = 33;
  const C = 2 * Math.PI * R;
  const off = C * (1 - v / 100);
  const color =
    v >= 66 ? "var(--color-pos)" : v >= 33 ? "var(--color-amber)" : "var(--color-neg)";
  return (
    <svg width="82" height="82" viewBox="0 0 82 82">
      <circle cx="41" cy="41" r={R} fill="none" stroke="var(--color-hairline-2)" strokeWidth="6" />
      <circle
        cx="41"
        cy="41"
        r={R}
        fill="none"
        stroke={color}
        strokeWidth="6"
        strokeLinecap="round"
        strokeDasharray={C}
        strokeDashoffset={off}
        transform="rotate(-90 41 41)"
        style={{ transition: "stroke-dashoffset 0.6s cubic-bezier(0.16,1,0.3,1)" }}
      />
      <text
        x="41"
        y="39"
        textAnchor="middle"
        className="font-data"
        fill="var(--color-ink)"
        fontSize="19"
        fontWeight="600"
      >
        {Math.round(v)}
      </text>
      <text x="41" y="54" textAnchor="middle" fill="var(--color-ink-faint)" fontSize="9">
        / 100
      </text>
    </svg>
  );
}

function ThesisSurface({ data }: { data: any }) {
  if (!data)
    return (
      <Empty>
        No thesis yet. State a belief — the agent scores your book against it, sources evidence
        online, and finds tickers that fit.
      </Empty>
    );
  const align = Math.max(0, Math.min(100, Number(data?.verdict?.alignment) || 0));
  const holdings: any[] = (Array.isArray(data.holdings) ? [...data.holdings] : []).sort(
    (a, b) => (Number(b.value) || 0) - (Number(a.value) || 0),
  );
  const ideas: any[] = Array.isArray(data.ideas) ? data.ideas : [];
  const evidence: any[] = Array.isArray(data.evidence) ? data.evidence : [];

  return (
    <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5 select-text">
      {/* header: thesis + alignment ring */}
      <div className="flex items-start gap-5">
        <div className="min-w-0 flex-1">
          <SectionLabel>The thesis</SectionLabel>
          <div className="text-[15px] leading-snug text-ink">
            <Cashtags text={data.thesis} />
          </div>
          {data.stance && (
            <div className="mt-2 inline-flex items-center gap-1.5 rounded-sm border border-amber/25 bg-amber-dim px-2 py-1 text-[11px] text-amber">
              <span className="text-[9px] tracking-[0.12em] uppercase text-amber/70">The bet</span>
              <Cashtags text={data.stance} />
            </div>
          )}
          {data?.verdict?.summary && (
            <div className="mt-3 text-[12px] leading-snug text-ink-dim">
              <Cashtags text={data.verdict.summary} />
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-center">
          <AlignmentRing value={align} />
          <div className="mt-1 text-[9.5px] tracking-[0.14em] uppercase text-ink-faint">
            book alignment
          </div>
        </div>
      </div>

      {/* book vs. thesis */}
      <section>
        <SectionLabel>Your book vs. this thesis</SectionLabel>
        {holdings.length === 0 ? (
          <div className="text-[11.5px] text-ink-faint">
            No positions read — connect your full account to score the book.
          </div>
        ) : (
          <div className="space-y-1">
            {holdings.map((h, i) => {
              const tone = fitTone(String(h.fit));
              const fit = String(h.fit ?? "neutral").toLowerCase();
              return (
                <div
                  key={i}
                  className="flex items-center gap-3 rounded-sm border-l-2 bg-panel py-1.5 pr-3 pl-2.5"
                  style={{ borderLeftColor: tone.border }}
                >
                  <Ticker sym={h.symbol} />
                  <span className={`shrink-0 text-[9px] uppercase tracking-wide ${tone.text}`}>
                    {fit}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-dim">
                    {h.reason}
                  </span>
                  <span className="font-data shrink-0 text-[10px] text-ink-faint">
                    {fmtMoney(h.value)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* new tickers that fit */}
      <section>
        <SectionLabel>Ideas that fit{ideas.length ? ` · ${ideas.length}` : ""}</SectionLabel>
        {ideas.length === 0 ? (
          <div className="text-[11.5px] text-ink-faint">No new tickers surfaced yet.</div>
        ) : (
          <div className="grid gap-3 xl:grid-cols-2">
            {ideas.map((it, i) => (
              <div key={i} className="rounded-sm border border-hairline bg-panel p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <Ticker sym={it.symbol} />
                  <span
                    className={`text-[10px] font-semibold uppercase ${
                      it.direction === "short" ? "text-neg" : "text-pos"
                    }`}
                  >
                    {it.direction ?? "long"} · {it.confidence ?? "?"}/10
                  </span>
                </div>
                {it.name && <div className="mt-0.5 text-[10px] text-ink-faint">{it.name}</div>}
                <div className="mt-1 text-[11.5px] leading-snug text-ink-dim">
                  <Cashtags text={it.rationale} />
                </div>
                {Array.isArray(it.sources) && it.sources.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                    {it.sources.slice(0, 3).map((s: any, j: number) =>
                      s?.url ? (
                        <a
                          key={j}
                          href={s.url}
                          target="_blank"
                          rel="noreferrer"
                          title={s?.title}
                          className="truncate text-[10px] text-amber hover:underline"
                        >
                          {sourceLabel(s)} ↗
                        </a>
                      ) : null,
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* sourced evidence both ways */}
      <section>
        <SectionLabel>Evidence</SectionLabel>
        {evidence.length === 0 ? (
          <div className="text-[11.5px] text-ink-faint">No sourced evidence yet.</div>
        ) : (
          <div className="space-y-1.5">
            {evidence.map((e, i) => {
              const against = String(e.stance).toLowerCase() === "contradicts";
              return (
                <div
                  key={i}
                  className="flex gap-2.5 rounded-sm border-l-2 bg-panel py-1.5 pr-3 pl-2.5"
                  style={{ borderLeftColor: against ? "var(--color-neg)" : "var(--color-pos)" }}
                >
                  <span
                    className={`shrink-0 text-[14px] leading-tight ${against ? "text-neg" : "text-pos"}`}
                  >
                    {against ? "−" : "+"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[11.5px] leading-snug text-ink-dim">
                      <Cashtags text={e.claim} />
                    </div>
                    {e.source?.url && (
                      <a
                        href={e.source.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[10px] text-amber hover:underline"
                      >
                        {sourceLabel(e.source)} ↗
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {data.gaps && (
        <div className="rounded-sm border border-hairline bg-panel-2 px-3 py-2 text-[11.5px] leading-snug text-ink-dim">
          <span className="mr-1.5 text-[9px] tracking-[0.14em] uppercase text-ink-faint">
            What would break this
          </span>
          <Cashtags text={data.gaps} />
        </div>
      )}
    </div>
  );
}

/* ---------- Exposure: risk dashboard ---------- */
function ExposureSurface({ data }: { data: any }) {
  if (!data) return <Empty>No exposure computed yet. The agent reads your book's risk.</Empty>;
  const scenarios: any[] = data.scenarios ?? [];
  const byU: any[] = data.byUnderlying ?? [];
  const maxAbsPnl = Math.max(1, ...scenarios.map((s) => Math.abs(Number(s.pnl) || 0)));
  const maxShare = Math.max(0.0001, ...byU.map((u) => Math.abs(Number(u.share) || 0)));
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="grid gap-3 xl:grid-cols-2">
        <Stat label="Net delta ($)" value={fmtMoney(data.netDeltaDollars)} signed={data.netDeltaDollars} />
        <Stat label="Gross exposure" value={fmtMoney(data.grossValue)} />
      </div>

      {scenarios.length > 0 && (
        <div className="mt-5">
          <div className="mb-2 text-[10px] tracking-[0.16em] uppercase text-ink-faint">
            If the market moves
          </div>
          <div className="space-y-1.5">
            {scenarios.map((s, i) => {
              const pnl = Number(s.pnl) || 0;
              return (
                <div key={i} className="flex items-center gap-3">
                  <span className="font-data w-12 text-right text-[11px] text-ink-dim">{s.move}</span>
                  <div className="relative h-4 flex-1">
                    <div className="absolute top-0 left-1/2 h-full w-px bg-hairline-2" />
                    <div
                      className={`absolute top-0 h-full ${pnl >= 0 ? "bg-pos/40" : "bg-neg/40"}`}
                      style={{
                        width: `${(Math.abs(pnl) / maxAbsPnl) * 50}%`,
                        left: pnl >= 0 ? "50%" : undefined,
                        right: pnl < 0 ? "50%" : undefined,
                      }}
                    />
                  </div>
                  <span
                    className={`font-data w-20 text-right text-[11px] ${pnl >= 0 ? "text-pos" : "text-neg"}`}
                  >
                    {pnl >= 0 ? "+" : ""}
                    {fmtMoney(pnl)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {byU.length > 0 && (
        <div className="mt-5">
          <div className="mb-2 text-[10px] tracking-[0.16em] uppercase text-ink-faint">
            By underlying
          </div>
          <div className="space-y-1.5">
            {byU.map((u, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="font-data w-14 text-[11px] text-ink">{u.symbol}</span>
                <div className="h-3 flex-1 rounded-sm bg-bg">
                  <div
                    className="h-full rounded-sm bg-amber/50"
                    style={{ width: `${(Math.abs(u.share) / maxShare) * 100}%` }}
                  />
                </div>
                <span className="font-data w-20 text-right text-[10px] text-ink-dim">
                  {fmtMoney(u.deltaDollars)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {data.concentration && (
        <div className="mt-5 rounded-sm border border-amber/25 bg-amber-dim/40 p-3 text-[12px] leading-snug text-amber select-text">
          <Cashtags text={data.concentration} />
        </div>
      )}
      {data.notes && (
        <div className="mt-2 text-[11px] text-ink-faint select-text">
          <Cashtags text={data.notes} />
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, signed }: { label: string; value: string; signed?: number }) {
  const color =
    signed === undefined ? "text-ink" : signed >= 0 ? "text-pos" : "text-neg";
  return (
    <div className="rounded-sm border border-hairline bg-panel p-3">
      <div className="text-[10px] tracking-[0.14em] uppercase text-ink-faint">{label}</div>
      <div className={`font-data mt-0.5 text-[17px] font-semibold ${color}`}>{value}</div>
    </div>
  );
}

/* ---------- Lattice: correlation graph (force-directed) + matrix ---------- */
type LatticeWindow = "30d" | "90d" | "252d";

interface GNode {
  id: string;
  kind: string;
  value: number;
  deltaDollars: number;
  weight: number;
  vol90: number | null;
  betaSpy90: number | null;
}
interface GEdge {
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
interface GCluster {
  label: string;
  symbols: string[];
  value: number;
  share: number;
  avgCorr: number;
}

function maybeNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function corrForWindow(edge: GEdge, window: LatticeWindow): number {
  const value =
    window === "30d" ? edge.corr30 : window === "252d" ? edge.corr252 : edge.corr90;
  return Math.max(-1, Math.min(1, value ?? edge.corr));
}

function normalizeLatticeNodes(rawNodes: any[]): GNode[] {
  const byId = new Map<string, GNode>();
  for (const raw of rawNodes) {
    const id = cleanSymbol(raw?.symbol ?? raw?.id);
    if (!id) continue;
    const value = Number(raw?.value) || 0;
    const deltaDollars = Number(raw?.deltaDollars) || value;
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
    (a, b) => Math.abs(b.deltaDollars || b.value) - Math.abs(a.deltaDollars || a.value),
  );
  const totalWeight = rows.reduce((sum, n) => sum + n.weight, 0);
  const gross = rows.reduce((sum, n) => sum + Math.abs(n.deltaDollars || n.value), 0) || 1;
  return rows
    .map((n) => ({ ...n, weight: totalWeight > 0 ? n.weight : Math.abs(n.deltaDollars || n.value) / gross }))
    .slice(0, 14);
}

function LatticeSurface({ data }: { data: any }) {
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
  const maxVal = Math.max(1, ...nodes.map((n) => Math.abs(n.deltaDollars || n.value) || 0));
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
        r: radiusOf(n.deltaDollars || n.value),
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
          const r = radiusOf(n.deltaDollars || n.value);
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
            vol {hoverNode.vol90 !== null ? `${Math.round(hoverNode.vol90 * 100)}%` : "—"} · beta{" "}
            {hoverNode.betaSpy90 !== null ? hoverNode.betaSpy90.toFixed(2) : "—"}
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
                    title={c !== null ? `${a}/${b} ${window}: ${c.toFixed(2)}` : `${a}/${b}: —`}
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

/* ---------- Trade: plan markdown (proposals show in the right rail) ---------- */
function TradeSurface({ markdown }: { markdown: string }) {
  if (!markdown)
    return (
      <Empty>
        No plan yet. Write your intent, @-reference other tabs, and the agent drafts
        proposals into your approval queue.
      </Empty>
    );
  return (
    <div className="findings min-h-0 flex-1 overflow-y-auto px-6 py-4" onClick={onCashtagClick}>
      <div dangerouslySetInnerHTML={{ __html: marked.parse(markdown) as string }} />
    </div>
  );
}
