import { useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  Bell,
  CalendarClock,
  FileText,
  Gauge,
  Network,
  Plus,
  Radar,
  Search,
} from "lucide-react";
import {
  client,
  fmtMoney,
  fmtPct,
  type MarketEvent,
  type Position,
  type RiskSummary,
} from "../../lib/client";
import { deAiText } from "../../lib/text";
import {
  cleanSymbol,
  exposureAmount,
  normalizeSymbolRows,
  pct,
  severityClass,
  type LatticeCluster,
} from "./derive";

export function PanelTitle({
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

export function Kpi({
  label,
  value,
  tone = "ink",
  detail,
  onClick,
  title,
}: {
  label: string;
  value: string;
  tone?: "ink" | "pos" | "neg" | "amber";
  detail?: string;
  onClick?: () => void;
  title?: string;
}) {
  const toneClass =
    tone === "pos" ? "text-pos" : tone === "neg" ? "text-neg" : tone === "amber" ? "text-amber" : "text-ink";
  const interactive = Boolean(onClick);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={`cockpit-kpi text-left ${interactive ? "cursor-pointer hover:border-amber/55 hover:bg-amber-dim/25" : "cursor-default"}`}
      title={title}
    >
      <div className="text-[9px] tracking-[0.14em] text-ink-faint uppercase">{label}</div>
      <div className={`font-data mt-1 truncate text-[15px] font-semibold ${toneClass}`}>{value}</div>
      {detail && <div className="mt-1 truncate text-[10px] text-ink-faint">{deAiText(detail)}</div>}
    </button>
  );
}

export function RiskPanel({
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
                <div className="font-semibold">{deAiText(w.title)}</div>
                <div className="mt-0.5 leading-snug opacity-80">{deAiText(w.detail)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

export function CorrelationPanel({
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
                {deAiText(lattice.insight)}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

export function EventsPanel({ events, onSymbolChange }: { events: MarketEvent[]; onSymbolChange: (symbol: string) => void }) {
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
                  <div className="truncate text-[12px] font-semibold">
                    {event.url ? (
                      <a
                        href={event.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5 truncate !text-inherit !no-underline hover:!underline"
                      >
                        {deAiText(event.title)}
                        <ArrowUpRight className="h-3 w-3" />
                      </a>
                    ) : (
                      deAiText(event.title)
                    )}
                  </div>
                  <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug opacity-80">{deAiText(event.detail)}</div>
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

export function ScannerPanel({
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

export function EmptyPanel({ text }: { text: string }) {
  return (
    <div className="grid min-h-28 place-items-center rounded-sm border border-dashed border-hairline bg-bg/60 px-4 py-6 text-center text-[12px] text-ink-faint">
      {deAiText(text)}
    </div>
  );
}
