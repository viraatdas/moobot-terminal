import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  AlertTriangle,
  Bell,
  CalendarClock,
  FileText,
  Gauge,
  Network,
  Plus,
  Radar,
  Search,
  Sparkles,
  Target,
  Zap,
} from "lucide-react";
import {
  client,
  fmtMoney,
  fmtPct,
  type AccountRiskSummary,
  type AccountSnapshot,
  type FeedLine,
  type MarketEvent,
  type MarketEventsResponse,
  type Position,
  type RiskSummary,
  type ResearchTab,
  type TradeProposal,
} from "../lib/client";
import { SymbolChart } from "./SymbolChart";

type FocusSection = "chart" | "risk" | "events" | "scanner" | "correlation";

interface Props {
  snapshot: AccountSnapshot | null;
  robinhoodConnected: boolean;
  agenticBuyingPower: number | null;
  tabs: ResearchTab[];
  feed: FeedLine[];
  proposals: TradeProposal[];
  activeSymbol: string;
  focusSection: FocusSection | null;
  watchlist: string[];
  onSymbolChange: (symbol: string) => void;
  onWatchlistChange: (symbols: string[]) => void;
  onConnect: () => void;
  onOpenAlerts: () => void;
  onOpenChain: (symbol: string) => void;
}

interface LatticeCluster {
  label: string;
  symbols: string[];
  value: number;
  share: number;
  avgCorr: number;
}

function allPositions(snapshot: AccountSnapshot | null): Position[] {
  if (!snapshot) return [];
  return [...snapshot.equities, ...snapshot.options, ...snapshot.crypto];
}

function cleanSymbol(value: string): string {
  return value.replace(/^\$/, "").trim().toUpperCase();
}

function severityClass(severity: string): string {
  if (severity === "high") return "border-neg/35 bg-neg-dim text-neg";
  if (severity === "medium") return "border-amber/35 bg-amber-dim text-amber";
  return "border-hairline bg-panel-2 text-ink-dim";
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function exposureAmount(row: { deltaDollars?: number | null; value: number }): number {
  return finiteNumber(row.deltaDollars) ?? row.value;
}

function normalizeSymbolRows(rows: unknown): string[] | null {
  if (!Array.isArray(rows)) return null;
  return [
    ...new Set(
      rows
        .map((row) =>
          typeof row === "string" ? row : String((row as { symbol?: unknown })?.symbol ?? ""),
        )
        .map(cleanSymbol)
        .filter(Boolean),
    ),
  ].sort();
}

function deriveRisk(snapshot: AccountSnapshot | null): RiskSummary | null {
  if (!snapshot) return null;
  const positions = allPositions(snapshot);
  const rows = positions.map((p) => {
    const optionPrice =
      typeof p.currentPrice === "number"
        ? p.currentPrice
        : typeof p.markPrice === "number"
          ? p.markPrice
          : null;
    const optionDelta =
      p.kind === "option" && typeof p.delta === "number" && optionPrice !== null
        ? p.delta * p.quantity * 100 * optionPrice
        : null;
    const deltaDollars = optionDelta ?? p.value;
    return {
      symbol: p.symbol,
      value: Math.abs(p.value),
      deltaDollars,
      kind: p.kind,
    };
  });
  const grossExposure = rows.reduce((sum, r) => sum + Math.abs(exposureAmount(r)), 0);
  const netDeltaDollars = rows.reduce((sum, r) => sum + r.deltaDollars, 0);
  const topExposures = rows
    .sort((a, b) => Math.abs(exposureAmount(b)) - Math.abs(exposureAmount(a)))
    .slice(0, 8)
    .map((r) => ({
      ...r,
      share: grossExposure > 0 ? Math.abs(exposureAmount(r)) / grossExposure : 0,
    }));
  const findExposure = (symbol: string) =>
    rows.find((r) => r.symbol === symbol)?.deltaDollars ?? 0;
  const scenarios = [
    { label: "SPY -3%", move: -0.03, pnl: netDeltaDollars * -0.03 },
    { label: "QQQ -5%", move: -0.05, pnl: netDeltaDollars * -0.05 },
    { label: "NVDA -8%", move: -0.08, pnl: findExposure("NVDA") * -0.08 },
    { label: "BTC -10%", move: -0.1, pnl: findExposure("BTC") * -0.1 },
  ];
  const warnings: RiskSummary["warnings"] = [];
  const top = topExposures[0];
  if (top && top.share >= 0.35) {
    warnings.push({
      severity: top.share >= 0.5 ? "high" : "medium",
      title: `${top.symbol} concentration`,
      detail: `${top.symbol} is ${pct(top.share)} of directional exposure.`,
    });
  }
  const expiring = snapshot.options.filter((p) => (p.daysToExpiry ?? 99) <= 7);
  if (expiring.length > 0) {
    warnings.push({
      severity: "high",
      title: "Near expiry options",
      detail: `${expiring.length} option position${expiring.length === 1 ? "" : "s"} expire within 7 days.`,
    });
  }
  if (snapshot.portfolio.cash < snapshot.portfolio.equity * 0.03) {
    warnings.push({
      severity: "medium",
      title: "Thin cash buffer",
      detail: `Cash is ${fmtMoney(snapshot.portfolio.cash)}, under 3% of account value.`,
    });
  }
  return {
    updatedAt: new Date().toISOString(),
    grossExposure,
    netDeltaDollars,
    cash: snapshot.portfolio.cash,
    topExposures,
    scenarios,
    warnings,
  };
}

function normalizeRisk(
  raw: AccountRiskSummary | RiskSummary | unknown,
  fallback: RiskSummary | null,
): RiskSummary | null {
  if (!raw || typeof raw !== "object") return fallback;
  const value = raw as Partial<AccountRiskSummary & RiskSummary>;
  if (Array.isArray(value.topExposures) && Array.isArray(value.scenarios)) {
    return value as RiskSummary;
  }

  const grossExposure =
    finiteNumber(value.exposure?.grossDeltaDollars) ??
    finiteNumber(value.exposure?.grossPositionValue) ??
    fallback?.grossExposure ??
    0;
  const netDeltaDollars =
    finiteNumber(value.exposure?.netDeltaDollars) ?? fallback?.netDeltaDollars ?? 0;
  const topExposures =
    value.concentration?.topPositions?.map((p) => ({
      symbol: p.symbol,
      value: Math.abs(finiteNumber(p.value) ?? 0),
      deltaDollars: finiteNumber(p.value) ?? 0,
      share: finiteNumber(p.weight) ?? 0,
      kind: p.kind,
    })) ??
    fallback?.topExposures ??
    [];
  const warnings =
    value.flags?.map((flag) => ({
      title: flag.code.replace(/_/g, " "),
      detail: flag.message,
      severity: flag.level,
    })) ??
    fallback?.warnings ??
    [];

  return {
    updatedAt: String(value.updatedAt ?? fallback?.updatedAt ?? new Date().toISOString()),
    grossExposure,
    netDeltaDollars,
    cash: finiteNumber(value.portfolio?.cash) ?? fallback?.cash ?? 0,
    topExposures,
    scenarios:
      fallback?.scenarios ?? [
        { label: "SPY -3%", move: -0.03, pnl: netDeltaDollars * -0.03 },
        { label: "QQQ -5%", move: -0.05, pnl: netDeltaDollars * -0.05 },
        { label: "Book +5%", move: 0.05, pnl: netDeltaDollars * 0.05 },
        { label: "Book -10%", move: -0.1, pnl: netDeltaDollars * -0.1 },
      ],
    warnings,
  };
}

function normalizeEvent(raw: MarketEvent | any, fallbackId: string): MarketEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const rawType = String(raw.type ?? raw.source ?? "agent");
  const type: MarketEvent["type"] =
    rawType === "option_expiration" || rawType === "option_near_expiry"
      ? "expiry"
      : rawType === "filings"
        ? "filing"
        : rawType === "positions"
          ? "expiry"
          : (["filing", "news", "expiry", "agent", "risk"].includes(rawType)
              ? rawType
              : "agent") as MarketEvent["type"];
  const severity = String(raw.severity ?? "low") as MarketEvent["severity"];
  const symbols = Array.isArray(raw.symbols)
    ? raw.symbols.map((s: unknown) => cleanSymbol(String(s))).filter(Boolean)
    : raw.symbol
      ? [cleanSymbol(String(raw.symbol))]
      : [];
  const at = String(raw.at ?? raw.date ?? new Date().toISOString());
  return {
    id: String(raw.id ?? fallbackId),
    type,
    severity: ["info", "low", "medium", "high"].includes(severity) ? severity : "low",
    title: String(raw.title ?? "Market event"),
    detail: String(raw.detail ?? raw.description ?? ""),
    symbols,
    at,
    source: raw.source ? String(raw.source) : undefined,
    url: raw.url ? String(raw.url) : undefined,
  };
}

function normalizeEventsPayload(payload: unknown, localEvents: MarketEvent[]): MarketEvent[] {
  const remoteRows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as MarketEventsResponse).events)
      ? (payload as MarketEventsResponse).events
      : [];
  const remoteEvents = remoteRows
    .map((event, i) => normalizeEvent(event, `remote-${i}`))
    .filter((event): event is MarketEvent => event !== null);

  if (payload && typeof payload === "object" && Array.isArray((payload as MarketEventsResponse).placeholders)) {
    for (const placeholder of (payload as MarketEventsResponse).placeholders) {
      remoteEvents.push({
        id: `placeholder-${placeholder.source}`,
        type: placeholder.source === "filings" ? "filing" : "news",
        severity: "info",
        title: placeholder.title,
        detail: placeholder.description,
        symbols: placeholder.symbols ?? [],
        at: new Date().toISOString(),
        source: "Sidecar",
      });
    }
  }

  const byId = new Map([...remoteEvents, ...localEvents].map((event) => [event.id, event]));
  return [...byId.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50);
}

function deriveEvents(
  snapshot: AccountSnapshot | null,
  feed: FeedLine[],
  proposals: TradeProposal[],
  risk: RiskSummary | null,
): MarketEvent[] {
  const now = new Date().toISOString();
  const events: MarketEvent[] = [];
  for (const p of snapshot?.options ?? []) {
    const dte = p.daysToExpiry ?? null;
    if (dte !== null && dte <= 21) {
      events.push({
        id: `expiry-${p.symbol}-${p.expirationDate}-${p.strike}-${p.side}`,
        type: "expiry",
        severity: dte <= 7 ? "high" : "medium",
        title: `${p.symbol} ${p.side?.toUpperCase() ?? "OPT"} expires in ${dte}d`,
        detail: `${p.quantity} contract${Math.abs(p.quantity) === 1 ? "" : "s"} at ${p.strike ?? "n/a"} strike, value ${fmtMoney(p.value)}.`,
        symbols: [p.symbol],
        at: p.expirationDate ?? now,
        source: "Robinhood MCP",
      });
    }
  }
  for (const warning of risk?.warnings ?? []) {
    events.push({
      id: `risk-${warning.title}`,
      type: "risk",
      severity: warning.severity,
      title: warning.title,
      detail: warning.detail,
      symbols: [],
      at: risk?.updatedAt ?? now,
      source: "Risk engine",
    });
  }
  for (const p of proposals.filter((x) => x.status === "pending").slice(0, 4)) {
    events.push({
      id: `proposal-${p.id}`,
      type: "agent",
      severity: p.confidence >= 8 ? "high" : "medium",
      title: `${p.side.toUpperCase()} ${p.quantity} ${p.symbol} awaits review`,
      detail: `${p.tabTopic} · confidence ${p.confidence}/10 · ${p.timeHorizon}`,
      symbols: [p.symbol],
      at: p.createdAt,
      source: "Proposal queue",
    });
  }
  for (const line of feed.slice(0, 8)) {
    events.push({
      id: `feed-${line.id}`,
      type: "agent",
      severity: "low",
      title: "Agent activity",
      detail: line.text,
      symbols: [],
      at: new Date(line.at).toISOString(),
      source: "Research lens",
    });
  }
  return events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40);
}

function PanelTitle({
  icon,
  title,
  meta,
}: {
  icon: ReactNode;
  title: string;
  meta?: string;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-sm border border-hairline bg-bg text-amber">
          {icon}
        </span>
        <span className="truncate text-[12px] font-semibold tracking-[0.12em] text-ink-dim uppercase">
          {title}
        </span>
      </div>
      {meta && <span className="font-data shrink-0 text-[9.5px] text-ink-faint">{meta}</span>}
    </div>
  );
}

function Kpi({
  label,
  value,
  tone = "ink",
  detail,
}: {
  label: string;
  value: string;
  tone?: "ink" | "pos" | "neg" | "amber";
  detail?: string;
}) {
  const toneClass =
    tone === "pos" ? "text-pos" : tone === "neg" ? "text-neg" : tone === "amber" ? "text-amber" : "text-ink";
  return (
    <div className="cockpit-kpi">
      <div className="text-[9px] tracking-[0.14em] text-ink-faint uppercase">{label}</div>
      <div className={`font-data mt-1 truncate text-[15px] font-semibold ${toneClass}`}>{value}</div>
      {detail && <div className="mt-1 truncate text-[10px] text-ink-faint">{detail}</div>}
    </div>
  );
}

function RiskPanel({
  risk,
  onSymbolChange,
}: {
  risk: RiskSummary | null;
  onSymbolChange: (symbol: string) => void;
}) {
  const maxExposure = Math.max(
    1,
    ...(risk?.topExposures ?? []).map((e) => Math.abs(exposureAmount(e))),
  );
  const maxPnl = Math.max(1, ...(risk?.scenarios ?? []).map((s) => Math.abs(s.pnl)));
  return (
    <section className="cockpit-panel min-h-[390px]" data-cockpit-section="risk">
      <PanelTitle icon={<Gauge className="h-3.5 w-3.5" />} title="Risk desk" meta={risk ? "live snapshot" : "waiting"} />
      {!risk ? (
        <EmptyPanel text="Connect Robinhood MCP to compute exposure." />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[1fr_0.85fr]">
          <div>
            <div className="mb-2 grid grid-cols-2 gap-2">
              <Kpi
                label="net delta"
                value={fmtMoney(risk.netDeltaDollars)}
                tone={risk.netDeltaDollars >= 0 ? "pos" : "neg"}
              />
              <Kpi label="gross exposure" value={fmtMoney(risk.grossExposure)} />
            </div>
            <div className="space-y-2">
              {risk.topExposures.slice(0, 7).map((row, i) => (
                <button
                  key={`${row.symbol}-${i}`}
                  onClick={() => onSymbolChange(row.symbol)}
                  className="group flex w-full items-center gap-3 rounded-sm px-1 py-1 text-left hover:bg-bg"
                >
                  <span className="font-data w-14 shrink-0 text-[11px] font-semibold text-ink group-hover:text-amber">
                    {row.symbol}
                  </span>
                  <div className="h-2 flex-1 rounded-sm bg-bg">
                    <div
                      className="h-full rounded-sm bg-amber/65"
                      style={{ width: `${Math.max(2, (Math.abs(exposureAmount(row)) / maxExposure) * 100)}%` }}
                    />
                  </div>
                  <span className="font-data w-20 shrink-0 text-right text-[10px] text-ink-dim">
                    {pct(row.share)}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            {risk.scenarios.map((s) => (
              <div key={s.label} className="rounded-sm border border-hairline bg-bg px-3 py-2">
                <div className="mb-1 flex items-center justify-between">
                  <span className="font-data text-[10px] text-ink-dim">{s.label}</span>
                  <span className={`font-data text-[11px] ${s.pnl >= 0 ? "text-pos" : "text-neg"}`}>
                    {s.pnl >= 0 ? "+" : ""}
                    {fmtMoney(s.pnl)}
                  </span>
                </div>
                <div className="relative h-2 rounded-sm bg-panel-2">
                  <div className="absolute left-1/2 h-full w-px bg-hairline-2" />
                  <div
                    className={`absolute top-0 h-full rounded-sm ${s.pnl >= 0 ? "bg-pos/55" : "bg-neg/55"}`}
                    style={{
                      width: `${(Math.abs(s.pnl) / maxPnl) * 50}%`,
                      left: s.pnl >= 0 ? "50%" : undefined,
                      right: s.pnl < 0 ? "50%" : undefined,
                    }}
                  />
                </div>
              </div>
            ))}
            {risk.warnings.slice(0, 3).map((w) => (
              <div key={w.title} className={`rounded-sm border px-3 py-2 text-[11px] ${severityClass(w.severity)}`}>
                <div className="font-semibold">{w.title}</div>
                <div className="mt-0.5 leading-snug opacity-80">{w.detail}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function CorrelationPanel({
  lattice,
  onSymbolChange,
}: {
  lattice: any;
  onSymbolChange: (symbol: string) => void;
}) {
  const clusters: LatticeCluster[] = Array.isArray(lattice?.clusters)
    ? lattice.clusters
        .map((c: any) => ({
          label: String(c.label ?? "cluster"),
          symbols: Array.isArray(c.symbols) ? c.symbols.map((s: unknown) => cleanSymbol(String(s))).filter(Boolean) : [],
          value: Number(c.value) || 0,
          share: Math.max(0, Math.min(1, Number(c.share) || 0)),
          avgCorr: Number(c.avgCorr) || 0,
        }))
        .filter((c: LatticeCluster) => c.symbols.length > 1)
        .slice(0, 4)
    : [];
  const nodes = Array.isArray(lattice?.nodes) ? lattice.nodes : [];
  const fallbackSymbols = nodes.slice(0, 8).map((n: any) => cleanSymbol(String(n.symbol ?? n.id)));
  const rendered: LatticeCluster[] = clusters.length > 0 ? clusters : fallbackSymbols.length > 0
    ? [{ label: "Top exposure", symbols: fallbackSymbols, value: Number(lattice?.grossExposure) || 0, share: 1, avgCorr: Number(lattice?.avgCorrWeighted) || 0 }]
    : [];

  return (
    <section className="cockpit-panel min-h-[320px]" data-cockpit-section="correlation">
      <PanelTitle
        icon={<Network className="h-3.5 w-3.5" />}
        title="Correlation clusters"
        meta={lattice ? `${Math.round((Number(lattice.measuredPct) || 0) * 100)}% measured` : "waiting"}
      />
      {rendered.length === 0 ? (
        <EmptyPanel text="Run the correlation lens or connect Robinhood to map clusters." />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[1fr_0.9fr]">
          <div className="relative min-h-56 overflow-hidden rounded-sm border border-hairline bg-bg">
            <svg viewBox="0 0 620 260" className="h-full w-full">
              <defs>
                <radialGradient id="clusterGlow">
                  <stop offset="0%" stopColor="var(--color-amber)" stopOpacity="0.24" />
                  <stop offset="100%" stopColor="var(--color-amber)" stopOpacity="0" />
                </radialGradient>
              </defs>
              {rendered.map((cluster, i) => {
                const cx = 130 + i * 150;
                const cy = i % 2 === 0 ? 125 : 145;
                const r = 42 + 58 * Math.sqrt(cluster.share || 0.18);
                return (
                  <g key={cluster.label} className="cluster-fan-in" style={{ animationDelay: `${i * 90}ms` }}>
                    <circle cx={cx} cy={cy} r={r + 28} fill="url(#clusterGlow)" />
                    <circle cx={cx} cy={cy} r={r} fill="var(--color-panel-2)" stroke="var(--color-amber)" strokeWidth="1.4" />
                    <text x={cx} y={cy - 8} textAnchor="middle" fill="var(--color-ink)" fontSize="13" fontWeight="600">
                      {cluster.label}
                    </text>
                    <text x={cx} y={cy + 11} textAnchor="middle" fill="var(--color-ink-faint)" fontSize="10">
                      {pct(cluster.share)} · corr {cluster.avgCorr.toFixed(2)}
                    </text>
                    {cluster.symbols.slice(0, 6).map((symbol, j) => {
                      const angle = (j / Math.max(1, Math.min(6, cluster.symbols.length))) * Math.PI * 2 - Math.PI / 2;
                      const sx = cx + Math.cos(angle) * (r + 38);
                      const sy = cy + Math.sin(angle) * (r + 34);
                      return (
                        <g key={symbol} onClick={() => onSymbolChange(symbol)} className="cursor-pointer">
                          <line x1={cx} y1={cy} x2={sx} y2={sy} stroke="var(--color-pos)" strokeOpacity="0.28" />
                          <circle cx={sx} cy={sy} r="18" fill="var(--color-bg)" stroke="var(--color-hairline-2)" />
                          <text x={sx} y={sy + 4} textAnchor="middle" fill="var(--color-ink)" fontSize="9" fontWeight="600">
                            {symbol}
                          </text>
                        </g>
                      );
                    })}
                  </g>
                );
              })}
            </svg>
          </div>
          <div className="space-y-2">
            {rendered.map((cluster) => (
              <button
                key={cluster.label}
                onClick={() => cluster.symbols[0] && onSymbolChange(cluster.symbols[0])}
                className="w-full rounded-sm border border-hairline bg-bg px-3 py-2 text-left hover:border-amber/40"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[12px] font-semibold text-ink">{cluster.label}</span>
                  <span className="font-data text-[10px] text-amber">{pct(cluster.share)}</span>
                </div>
                <div className="mt-1 truncate text-[10px] text-ink-faint">{cluster.symbols.join(" · ")}</div>
              </button>
            ))}
            {lattice?.insight && (
              <div className="rounded-sm border border-amber/25 bg-amber-dim/35 px-3 py-2 text-[11px] leading-snug text-amber">
                {String(lattice.insight)}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function EventsPanel({ events, onSymbolChange }: { events: MarketEvent[]; onSymbolChange: (symbol: string) => void }) {
  const [filter, setFilter] = useState<"book" | "filing" | "news" | "expiry" | "agent">("book");
  const filtered = events.filter((event) => filter === "book" || event.type === filter);
  return (
    <section className="cockpit-panel min-h-[350px]" data-cockpit-section="events">
      <PanelTitle icon={<FileText className="h-3.5 w-3.5" />} title="Event inbox" meta={`${filtered.length} items`} />
      <div className="mb-3 flex gap-1 overflow-x-auto">
        {(["book", "filing", "news", "expiry", "agent"] as const).map((key) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`shrink-0 rounded-sm border px-2 py-1 text-[10px] font-semibold tracking-[0.1em] uppercase ${
              filter === key ? "border-amber/40 bg-amber-dim text-amber" : "border-hairline text-ink-faint hover:text-ink"
            }`}
          >
            {key}
          </button>
        ))}
      </div>
      <div className="max-h-[255px] space-y-2 overflow-y-auto pr-1">
        {filtered.length === 0 ? (
          <EmptyPanel text="No events in this lane yet." />
        ) : (
          filtered.map((event) => (
            <div key={event.id} className={`rounded-sm border px-3 py-2 ${severityClass(event.severity)}`}>
              <div className="flex items-start gap-2">
                <span className="mt-0.5">
                  {event.type === "expiry" ? <CalendarClock className="h-3.5 w-3.5" /> : <Bell className="h-3.5 w-3.5" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-semibold">{event.title}</div>
                  <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug opacity-80">{event.detail}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {event.symbols.slice(0, 4).map((symbol) => (
                      <button
                        key={symbol}
                        onClick={() => onSymbolChange(symbol)}
                        className="font-data rounded-sm border border-current/20 px-1.5 py-0.5 text-[9px]"
                      >
                        {symbol}
                      </button>
                    ))}
                    {event.source && <span className="font-data text-[9px] opacity-60">{event.source}</span>}
                  </div>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function ScannerPanel({
  positions,
  watchlist,
  onWatchlistChange,
  onSymbolChange,
}: {
  positions: Position[];
  watchlist: string[];
  onWatchlistChange: (symbols: string[]) => void;
  onSymbolChange: (symbol: string) => void;
}) {
  const [input, setInput] = useState("");
  const movers = [...positions]
    .filter((p) => Number.isFinite(p.unrealizedPnlPercent))
    .sort((a, b) => Math.abs(b.unrealizedPnlPercent) - Math.abs(a.unrealizedPnlPercent))
    .slice(0, 8);
  const add = async () => {
    const symbol = cleanSymbol(input);
    if (!symbol) return;
    const next = [...new Set([...watchlist, symbol])].sort();
    onWatchlistChange(next);
    setInput("");
    try {
      const saved = normalizeSymbolRows(await client.request("watchlist.add", { symbol }));
      if (saved) onWatchlistChange(saved);
    } catch {
      onWatchlistChange(watchlist);
    }
  };
  const remove = async (symbol: string) => {
    const previous = watchlist;
    onWatchlistChange(previous.filter((s) => s !== symbol));
    try {
      const saved = normalizeSymbolRows(await client.request("watchlist.remove", { symbol }));
      if (saved) onWatchlistChange(saved);
    } catch {
      onWatchlistChange(previous);
    }
  };
  return (
    <section className="cockpit-panel min-h-[350px]" data-cockpit-section="scanner">
      <PanelTitle icon={<Radar className="h-3.5 w-3.5" />} title="Scanner" meta="book + watchlist" />
      <div className="mb-3 flex gap-2">
        <div className="flex h-8 flex-1 items-center gap-2 rounded-sm border border-hairline bg-bg px-2">
          <Search className="h-3.5 w-3.5 text-ink-faint" />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
            }}
            placeholder="Add symbol"
            className="font-data min-w-0 flex-1 bg-transparent text-[11px] text-ink outline-none placeholder:text-ink-faint"
          />
        </div>
        <button
          onClick={() => void add()}
          className="grid h-8 w-8 place-items-center rounded-sm border border-amber/40 bg-amber-dim text-amber hover:bg-amber/25"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div>
          <div className="mb-2 text-[9px] tracking-[0.14em] text-ink-faint uppercase">movers in book</div>
          <div className="space-y-1">
            {movers.map((p) => (
              <button
                key={`${p.kind}-${p.symbol}-${p.value}`}
                onClick={() => onSymbolChange(p.symbol)}
                className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-bg"
              >
                <span className="font-data text-[11px] text-ink">{p.symbol}</span>
                <span className={p.unrealizedPnl >= 0 ? "text-pos" : "text-neg"}>
                  {fmtPct(p.unrealizedPnlPercent)}
                </span>
              </button>
            ))}
            {movers.length === 0 && <div className="text-[11px] text-ink-faint">No movers yet.</div>}
          </div>
        </div>
        <div>
          <div className="mb-2 text-[9px] tracking-[0.14em] text-ink-faint uppercase">watchlist</div>
          <div className="flex flex-wrap gap-1.5">
            {watchlist.map((symbol) => (
              <span key={symbol} className="inline-flex items-center overflow-hidden rounded-sm border border-hairline bg-bg">
                <button onClick={() => onSymbolChange(symbol)} className="font-data px-2 py-1 text-[10px] text-ink">
                  {symbol}
                </button>
                <button onClick={() => void remove(symbol)} className="border-l border-hairline px-1.5 py-1 text-[10px] text-ink-faint hover:text-neg">
                  ×
                </button>
              </span>
            ))}
            {watchlist.length === 0 && <div className="text-[11px] text-ink-faint">No watchlist symbols.</div>}
          </div>
        </div>
      </div>
    </section>
  );
}

function EmptyPanel({ text }: { text: string }) {
  return (
    <div className="grid min-h-28 place-items-center rounded-sm border border-dashed border-hairline bg-bg/60 px-4 py-6 text-center text-[12px] text-ink-faint">
      {text}
    </div>
  );
}

export function Cockpit({
  snapshot,
  robinhoodConnected,
  agenticBuyingPower,
  tabs,
  feed,
  proposals,
  activeSymbol,
  focusSection,
  watchlist,
  onSymbolChange,
  onWatchlistChange,
  onConnect,
  onOpenAlerts,
  onOpenChain,
}: Props) {
  const positions = useMemo(() => allPositions(snapshot), [snapshot]);
  const localRisk = useMemo(() => deriveRisk(snapshot), [snapshot]);
  const [risk, setRisk] = useState<RiskSummary | null>(() => localRisk);
  const [events, setEvents] = useState<MarketEvent[]>([]);
  const [lattice, setLattice] = useState<any>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const riskRef = useRef<HTMLDivElement>(null);
  const eventsRef = useRef<HTMLDivElement>(null);
  const scannerRef = useRef<HTMLDivElement>(null);
  const correlationRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!robinhoodConnected) setRisk(localRisk);
    else setRisk((current) => current ?? localRisk);
  }, [localRisk, robinhoodConnected]);

  useEffect(() => {
    if (!robinhoodConnected) return;
    let alive = true;
    client
      .request<unknown>("account.risk", { accountNumber: snapshot?.accountNumber })
      .then((res) => {
        if (alive) setRisk(normalizeRisk(res, localRisk));
      })
      .catch(() => {
        if (alive) setRisk(localRisk);
      });
    client
      .request<any>("account.lattice", { accountNumber: snapshot?.accountNumber })
      .then((res) => {
        if (alive) setLattice(res);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [localRisk, robinhoodConnected, snapshot?.accountNumber, snapshot?.portfolio.asOf]);

  useEffect(() => {
    const localEvents = deriveEvents(snapshot, feed, proposals, risk ?? localRisk);
    setEvents(localEvents);
    if (!robinhoodConnected) return;
    let alive = true;
    const symbols = [...new Set([...positions.map((p) => p.symbol), ...watchlist])].slice(0, 50);
    client
      .request<unknown>("market.events", { symbols, accountNumber: snapshot?.accountNumber })
      .then((res) => {
        if (alive) setEvents(normalizeEventsPayload(res, localEvents));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [feed, localRisk, positions, proposals, risk, robinhoodConnected, snapshot, watchlist]);

  useEffect(() => {
    if (!focusSection) return;
    const map: Record<FocusSection, RefObject<HTMLDivElement | null>> = {
      chart: chartRef,
      risk: riskRef,
      events: eventsRef,
      scanner: scannerRef,
      correlation: correlationRef,
    };
    map[focusSection].current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focusSection]);

  const pf = snapshot?.portfolio;
  const pnlTone = (pf?.pnl ?? 0) >= 0 ? "pos" : "neg";
  const activePosition = positions.find((p) => p.symbol === activeSymbol);
  const connectedDetail = robinhoodConnected ? "Robinhood MCP connected" : "Robinhood MCP disconnected";

  return (
    <div className="cockpit-root min-h-0 flex-1 overflow-y-auto bg-bg" data-cockpit>
      <div className="cockpit-hero border-b border-hairline px-5 py-4">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2 text-[10px] tracking-[0.18em] text-amber uppercase">
              <Sparkles className="h-3.5 w-3.5" />
              cockpit
            </div>
            <h1 className="font-wordmark text-[32px] leading-none italic text-ink">
              trading desk<span className="text-amber">.</span>
            </h1>
            <div className="mt-2 max-w-2xl text-[12px] leading-snug text-ink-faint">
              Charts, risk, events, correlation clusters, scanners, and agent proposals in one workspace.
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={onOpenAlerts}
              className="flex h-8 items-center gap-1.5 rounded-sm border border-hairline bg-panel px-2.5 text-[11px] text-ink-dim hover:border-amber/40 hover:text-amber"
            >
              <Bell className="h-3.5 w-3.5" />
              Alerts
            </button>
            <button
              onClick={() => onOpenChain(activeSymbol)}
              className="flex h-8 items-center gap-1.5 rounded-sm border border-amber/40 bg-amber-dim px-2.5 text-[11px] font-semibold text-amber hover:bg-amber/25"
            >
              <Zap className="h-3.5 w-3.5" />
              Chain
            </button>
          </div>
        </div>
        <div className="grid gap-2 md:grid-cols-3 xl:grid-cols-6">
          <Kpi label="account" value={pf ? fmtMoney(pf.equity) : "n/a"} detail={connectedDetail} />
          <Kpi
            label="p&l"
            value={pf ? `${pf.pnl >= 0 ? "+" : ""}${fmtMoney(pf.pnl)}` : "n/a"}
            tone={pnlTone}
            detail={pf ? fmtPct(pf.pnlPercent) : undefined}
          />
          <Kpi label="cash" value={pf ? fmtMoney(pf.cash) : "n/a"} />
          <Kpi label="tradeable" value={agenticBuyingPower !== null ? fmtMoney(agenticBuyingPower) : "n/a"} tone="amber" />
          <Kpi label="active" value={activeSymbol} detail={activePosition ? fmtMoney(activePosition.value) : "chart focus"} />
          <Kpi label="pending" value={String(proposals.filter((p) => p.status === "pending").length)} detail="proposals" />
        </div>
        {!robinhoodConnected && (
          <div className="mt-3 flex items-center gap-3 rounded-sm border border-amber/25 bg-amber-dim/30 px-3 py-2 text-[12px] text-amber">
            <AlertTriangle className="h-4 w-4" />
            <span className="min-w-0 flex-1">Connect Robinhood MCP to unlock live positions, chains, risk, and chart enrichment.</span>
            <button
              onClick={onConnect}
              className="shrink-0 rounded-sm border border-amber/40 bg-amber-dim px-3 py-1 text-[11px] font-semibold hover:bg-amber/25"
            >
              Connect
            </button>
          </div>
        )}
      </div>

      <div className="space-y-4 p-4">
        <div ref={chartRef} data-cockpit-section="chart">
          <SymbolChart symbol={activeSymbol} positions={positions} onSymbolChange={onSymbolChange} />
        </div>

        <div className="grid gap-4 2xl:grid-cols-[1.1fr_0.9fr]">
          <div ref={riskRef}>
            <RiskPanel risk={risk} onSymbolChange={onSymbolChange} />
          </div>
          <div ref={correlationRef}>
            <CorrelationPanel lattice={lattice} onSymbolChange={onSymbolChange} />
          </div>
        </div>

        <div className="grid gap-4 2xl:grid-cols-[1fr_1fr]">
          <div ref={eventsRef}>
            <EventsPanel events={events} onSymbolChange={onSymbolChange} />
          </div>
          <div ref={scannerRef}>
            <ScannerPanel
              positions={positions}
              watchlist={watchlist}
              onWatchlistChange={onWatchlistChange}
              onSymbolChange={onSymbolChange}
            />
          </div>
        </div>

        <section className="cockpit-panel">
          <PanelTitle icon={<Target className="h-3.5 w-3.5" />} title="Agent lanes" meta={`${tabs.length} lenses`} />
          <div className="grid gap-2 xl:grid-cols-3">
            {tabs.slice(0, 6).map((tab) => (
              <div key={tab.id} className="rounded-sm border border-hairline bg-bg px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[12px] font-semibold text-ink">{tab.topic}</span>
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      tab.lastRunStatus === "running" ? "bg-amber pulse-dot" : tab.lastRunStatus === "error" ? "bg-neg" : "bg-pos"
                    }`}
                  />
                </div>
                <div className="mt-1 flex items-center justify-between text-[10px] text-ink-faint">
                  <span>{tab.type}</span>
                  <span className="font-data">run {tab.runCount}</span>
                </div>
              </div>
            ))}
            {tabs.length === 0 && <EmptyPanel text="No research lenses yet. Use Auto or Cmd+K to start one." />}
          </div>
        </section>
      </div>
    </div>
  );
}
