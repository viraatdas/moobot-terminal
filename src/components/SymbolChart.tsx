import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertTriangle, BarChart3, CandlestickChart, Loader2, Search } from "lucide-react";
import { client, fmtMoney, type Position } from "../lib/client";
import { fmtSigned } from "../lib/format";
import { finiteNumber, isRecord } from "../lib/guards";
import { areaFor, indexFromClientX, scale } from "../lib/charts";

type RangeKey = "1D" | "5D" | "1M" | "3M" | "1Y";

const RANGE_CONFIG: Record<RangeKey, { range: string; interval: string }> = {
  "1D": { range: "1d", interval: "5m" },
  "5D": { range: "5d", interval: "15m" },
  "1M": { range: "1mo", interval: "1d" },
  "3M": { range: "3mo", interval: "1d" },
  "1Y": { range: "1y", interval: "1d" },
};

interface Props {
  symbol: string;
  positions?: Position[];
  onSymbolChange?: (symbol: string) => void;
}

interface ChartCandle {
  time: string;
  open: number | null;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

interface ChartHistory {
  symbol: string;
  range: string;
  interval: string;
  source: string | null;
  stale: boolean;
  warning: string | null;
  candles: ChartCandle[];
}

function cleanSymbol(value: string): string {
  return value.replace(/^\$/, "").trim().toUpperCase();
}

function niceTime(value: string | undefined, range: RangeKey): string {
  if (!value) return "";
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return value;
  if (range === "1D") return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (range === "1Y") return d.toLocaleDateString([], { month: "short", year: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function cursorTime(value: string | undefined, range: RangeKey): string {
  if (!value) return "";
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return value;
  if (range === "1D" || range === "5D") {
    return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${d.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    })}`;
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "2-digit" });
}

function spanLabel(fromMs: number, toMs: number): string {
  const mins = Math.max(0, Math.round((toMs - fromMs) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = mins / 60;
  if (hours < 24) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
  const days = hours / 24;
  if (days < 31) return `${days.toFixed(days < 10 ? 1 : 0)}d`;
  const months = days / 30.44;
  if (months < 12) return `${months.toFixed(months < 10 ? 1 : 0)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

function normalizeCandle(raw: unknown): ChartCandle | null {
  if (!isRecord(raw)) return null;
  const close = finiteNumber(raw.close ?? raw.c ?? raw.price ?? raw.last);
  if (close === null) return null;
  const rawTime = raw.time ?? raw.timestamp ?? raw.date ?? raw.begins_at ?? raw.t;
  const time =
    typeof rawTime === "number"
      ? new Date(rawTime < 10_000_000_000 ? rawTime * 1000 : rawTime).toISOString()
      : String(rawTime ?? "");
  const parsed = Date.parse(time);
  if (!Number.isFinite(parsed)) return null;

  const high = finiteNumber(raw.high ?? raw.h) ?? close;
  const low = finiteNumber(raw.low ?? raw.l) ?? close;
  return {
    time: new Date(parsed).toISOString(),
    open: finiteNumber(raw.open ?? raw.o),
    high,
    low,
    close,
    volume: finiteNumber(raw.volume ?? raw.vol ?? raw.v),
  };
}

function normalizeHistory(payload: unknown, fallbackSymbol: string): ChartHistory {
  const root = isRecord(payload) ? payload : {};
  const rawCandles =
    (Array.isArray(root.candles) && root.candles) ||
    (Array.isArray(root.points) && root.points) ||
    (Array.isArray(root.history) && root.history) ||
    (Array.isArray(root.results) && root.results) ||
    [];
  const candles = rawCandles
    .map(normalizeCandle)
    .filter((candle): candle is ChartCandle => candle !== null)
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));

  return {
    symbol: typeof root.symbol === "string" ? root.symbol : fallbackSymbol,
    range: typeof root.range === "string" ? root.range : "",
    interval: typeof root.interval === "string" ? root.interval : "",
    source: typeof root.source === "string" ? root.source : null,
    stale: Boolean(root.stale),
    warning: typeof root.warning === "string" ? root.warning : null,
    candles,
  };
}

function pathFor(candles: ChartCandle[], width: number, height: number, min: number, max: number): string {
  if (candles.length === 0) return "";
  const step = candles.length > 1 ? width / (candles.length - 1) : width;
  return candles
    .map((c, i) => {
      const x = i * step;
      const y = scale(c.close, min, max, height);
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function chartStats(candles: ChartCandle[]) {
  const first = candles[0]?.close ?? 0;
  const last = candles[candles.length - 1]?.close ?? 0;
  const change = last - first;
  const changePct = first > 0 ? (change / first) * 100 : 0;
  const high = Math.max(...candles.map((c) => c.high));
  const low = Math.min(...candles.map((c) => c.low));
  return { first, last, change, changePct, high, low };
}

export function SymbolChart({ symbol, positions = [], onSymbolChange }: Props) {
  const [range, setRange] = useState<RangeKey>("1M");
  const [activeSymbol, setActiveSymbol] = useState(() => cleanSymbol(symbol));
  const [input, setInput] = useState(() => cleanSymbol(symbol));
  const [history, setHistory] = useState<ChartHistory | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const dragRef = useRef<{ start: number; moved: boolean } | null>(null);
  const areaId = `chartArea-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  useEffect(() => {
    const next = cleanSymbol(symbol);
    setActiveSymbol(next);
    setInput(next);
  }, [symbol]);

  useEffect(() => {
    if (!activeSymbol) {
      setHistory(null);
      setError(null);
      return;
    }
    let alive = true;
    const config = RANGE_CONFIG[range];
    setBusy(true);
    setError(null);
    setHoverIndex(null);
    setSelection(null);
    dragRef.current = null;
    client
      .request("market.history", {
        symbol: activeSymbol,
        range: config.range,
        interval: config.interval,
      })
      .then((res) => {
        if (alive) setHistory(normalizeHistory(res, activeSymbol));
      })
      .catch((err) => {
        if (alive) {
          setError(String(err?.message ?? err));
          setHistory(null);
        }
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [activeSymbol, range]);

  const candles = useMemo(() => history?.candles.filter((c) => Number.isFinite(c.close)) ?? [], [history]);
  const stats = candles.length > 0 ? chartStats(candles) : null;
  const held = positions.find((p) => cleanSymbol(p.symbol) === activeSymbol);
  const w = 820;
  const h = 285;
  // Price domain (min-of-lows / max-of-highs) computed ONCE and fed to both the
  // line path and the hover/selection dot placement, so they can never drift.
  // Raw low/high domain with no padding — keep it that way (see lib/charts).
  const priceBounds = useMemo(() => {
    if (candles.length === 0) return { min: 0, max: 1 };
    return {
      min: Math.min(...candles.map((c) => c.low)),
      max: Math.max(...candles.map((c) => c.high)),
    };
  }, [candles]);
  const line = pathFor(candles, w, h, priceBounds.min, priceBounds.max);
  const area = areaFor(line, w, h);
  const positive = (stats?.change ?? 0) >= 0;
  const maxVolume = Math.max(1, ...candles.map((c) => c.volume || 0));

  const xForIndex = (i: number) => (candles.length > 1 ? (i / (candles.length - 1)) * w : w);
  const yForClose = (close: number) => scale(close, priceBounds.min, priceBounds.max, h);

  const hoverCandle = hoverIndex !== null ? candles[hoverIndex] ?? null : null;
  const hoverDelta =
    hoverCandle && stats ? { abs: hoverCandle.close - stats.first, pct: stats.first > 0 ? ((hoverCandle.close - stats.first) / stats.first) * 100 : 0 } : null;
  const sel = useMemo(() => {
    if (!selection) return null;
    const a = Math.min(selection.start, selection.end);
    const b = Math.max(selection.start, selection.end);
    const ca = candles[a];
    const cb = candles[b];
    if (!ca || !cb || a === b) return null;
    const diff = cb.close - ca.close;
    const pct = ca.close > 0 ? (diff / ca.close) * 100 : 0;
    const slice = candles.slice(a, b + 1);
    return {
      a,
      b,
      ca,
      cb,
      diff,
      pct,
      high: Math.max(...slice.map((c) => c.high)),
      low: Math.min(...slice.map((c) => c.low)),
      up: diff >= 0,
    };
  }, [selection, candles]);
  const submitSymbol = () => {
    const next = cleanSymbol(input);
    if (!next) return;
    setActiveSymbol(next);
    setInput(next);
    onSymbolChange?.(next);
  };

  return (
    <section className="flex min-h-[390px] flex-col overflow-hidden rounded-md border border-hairline bg-panel">
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-hairline px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <CandlestickChart className="h-4 w-4 text-amber" />
            <span className="font-data text-[15px] font-semibold text-ink">{activeSymbol || "SPY"}</span>
            {history?.source && (
              <span className="rounded-sm border border-hairline px-1.5 py-0.5 text-[9px] tracking-[0.12em] text-ink-faint uppercase">
                {history.source}
                {history.stale ? " stale" : ""}
              </span>
            )}
          </div>
          {sel ? (
            <div className="font-data mt-1 flex items-baseline gap-2 text-[11px]">
              <span className="rounded-sm bg-amber-dim px-1 text-[9px] tracking-[0.1em] text-amber uppercase">
                selection
              </span>
              <span className="text-ink-dim">
                {fmtMoney(sel.ca.close)} <span className="text-ink-faint">→</span> {fmtMoney(sel.cb.close)}
              </span>
              <span className={sel.up ? "text-pos" : "text-neg"}>
                {fmtSigned(sel.diff)} ({sel.up ? "+" : ""}
                {sel.pct.toFixed(2)}%)
              </span>
              <span className="text-ink-faint">
                {spanLabel(Date.parse(sel.ca.time), Date.parse(sel.cb.time))} · high {fmtMoney(sel.high)} · low{" "}
                {fmtMoney(sel.low)}
              </span>
            </div>
          ) : hoverCandle && hoverDelta ? (
            <div className="font-data mt-1 flex items-baseline gap-2 text-[11px]">
              <span className="text-ink">{fmtMoney(hoverCandle.close)}</span>
              <span className={hoverDelta.abs >= 0 ? "text-pos" : "text-neg"}>
                {fmtSigned(hoverDelta.abs)} ({hoverDelta.abs >= 0 ? "+" : ""}
                {hoverDelta.pct.toFixed(2)}%)
              </span>
              <span className="text-ink-faint">{cursorTime(hoverCandle.time, range)}</span>
            </div>
          ) : stats ? (
            <div className="font-data mt-1 flex items-baseline gap-2 text-[11px]">
              <span className="text-ink">{fmtMoney(stats.last)}</span>
              <span className={positive ? "text-pos" : "text-neg"}>
                {fmtSigned(stats.change)} ({positive ? "+" : ""}
                {stats.changePct.toFixed(2)}%)
              </span>
              <span className="text-ink-faint">
                high {fmtMoney(stats.high)} · low {fmtMoney(stats.low)}
              </span>
            </div>
          ) : (
            <div className="mt-1 text-[11px] text-ink-faint">Waiting for chart data</div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <div className="flex overflow-hidden rounded-sm border border-hairline bg-bg">
            {(Object.keys(RANGE_CONFIG) as RangeKey[]).map((key) => (
              <button
                key={key}
                onClick={() => setRange(key)}
                className={`h-7 px-2.5 text-[10px] font-semibold ${
                  key === range ? "bg-amber-dim text-amber" : "text-ink-faint hover:text-ink"
                }`}
              >
                {key}
              </button>
            ))}
          </div>
          <div className="flex h-7 w-32 items-center gap-1.5 rounded-sm border border-hairline bg-bg px-2">
            <Search className="h-3.5 w-3.5 text-ink-faint" />
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitSymbol();
              }}
              onBlur={submitSymbol}
              className="font-data min-w-0 flex-1 bg-transparent text-[11px] text-ink outline-none"
            />
          </div>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 bg-bg px-4 py-3">
        {busy && (
          <div className="absolute inset-0 z-10 grid place-items-center bg-bg/50 backdrop-blur-[1px]">
            <div className="flex items-center gap-2 rounded-sm border border-hairline bg-panel px-3 py-2 text-[12px] text-ink-dim">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-amber" />
              Loading {activeSymbol}
            </div>
          </div>
        )}
        {error && !busy && (
          <div className="grid h-full place-items-center">
            <div className="max-w-sm rounded-sm border border-amber/25 bg-amber-dim/30 px-3 py-2 text-[12px] leading-snug text-amber">
              <div className="mb-1 flex items-center gap-2 font-semibold">
                <AlertTriangle className="h-3.5 w-3.5" />
                Chart unavailable
              </div>
              {error}
            </div>
          </div>
        )}
        {!error && candles.length === 0 && !busy && (
          <div className="grid h-full place-items-center text-[12px] text-ink-faint">
            No price history yet.
          </div>
        )}
        {!error && candles.length > 0 && (
          <svg viewBox={`0 0 ${w} ${h + 62}`} className="h-full w-full overflow-visible">
            <defs>
              <linearGradient id={areaId} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={positive ? "var(--color-pos)" : "var(--color-neg)"} stopOpacity="0.28" />
                <stop offset="100%" stopColor={positive ? "var(--color-pos)" : "var(--color-neg)"} stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0.2, 0.4, 0.6, 0.8].map((p) => (
              <line
                key={p}
                x1="0"
                x2={w}
                y1={h * p}
                y2={h * p}
                stroke="var(--color-hairline)"
                strokeDasharray="3 6"
              />
            ))}
            <path d={area} fill={`url(#${areaId})`} />
            <path
              d={line}
              fill="none"
              stroke={positive ? "var(--color-pos)" : "var(--color-neg)"}
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {sel && (
              <g pointerEvents="none">
                <rect
                  x={xForIndex(sel.a)}
                  y={0}
                  width={Math.max(1, xForIndex(sel.b) - xForIndex(sel.a))}
                  height={h}
                  fill="var(--color-amber)"
                  opacity="0.08"
                />
                <line x1={xForIndex(sel.a)} x2={xForIndex(sel.a)} y1={0} y2={h} stroke="var(--color-amber)" strokeOpacity="0.5" strokeDasharray="4 5" />
                <line x1={xForIndex(sel.b)} x2={xForIndex(sel.b)} y1={0} y2={h} stroke="var(--color-amber)" strokeOpacity="0.5" strokeDasharray="4 5" />
                <circle cx={xForIndex(sel.a)} cy={yForClose(sel.ca.close)} r="4" fill="var(--color-amber)" stroke="var(--color-bg)" strokeWidth="2.5" />
                <circle
                  cx={xForIndex(sel.b)}
                  cy={yForClose(sel.cb.close)}
                  r="4"
                  fill={sel.up ? "var(--color-pos)" : "var(--color-neg)"}
                  stroke="var(--color-bg)"
                  strokeWidth="2.5"
                />
              </g>
            )}
            {hoverCandle && hoverIndex !== null && (
              <g pointerEvents="none">
                <line
                  x1={xForIndex(hoverIndex)}
                  x2={xForIndex(hoverIndex)}
                  y1={0}
                  y2={h}
                  stroke="var(--color-ink-faint)"
                  strokeOpacity="0.45"
                  strokeDasharray="4 6"
                />
                <circle
                  cx={xForIndex(hoverIndex)}
                  cy={yForClose(hoverCandle.close)}
                  r="4"
                  fill={positive ? "var(--color-pos)" : "var(--color-neg)"}
                  stroke="var(--color-bg)"
                  strokeWidth="2.5"
                />
              </g>
            )}
            {held && stats && (
              <g transform={`translate(${w - 166}, 14)`}>
                <rect width="154" height="56" rx="4" fill="var(--color-panel)" stroke="var(--color-hairline-2)" />
                <text x="10" y="18" fill="var(--color-ink-faint)" fontSize="9" className="font-data">
                  POSITION
                </text>
                <text x="10" y="35" fill="var(--color-ink)" fontSize="13" className="font-data">
                  {fmtMoney(held.value)}
                </text>
                <text
                  x="10"
                  y="49"
                  fill={held.unrealizedPnl >= 0 ? "var(--color-pos)" : "var(--color-neg)"}
                  fontSize="10"
                  className="font-data"
                >
                  {held.unrealizedPnl >= 0 ? "+" : ""}
                  {fmtMoney(held.unrealizedPnl)}
                </text>
              </g>
            )}
            <g transform={`translate(0, ${h + 12})`}>
              {candles.map((c, i) => {
                if (i % Math.ceil(candles.length / 120) !== 0) return null;
                const barW = Math.max(1.5, w / candles.length - 1);
                const x = (i / Math.max(1, candles.length - 1)) * w;
                const barH = ((c.volume || 0) / maxVolume) * 44;
                return (
                  <rect
                    key={`${c.time}-${i}`}
                    x={x}
                    y={44 - barH}
                    width={barW}
                    height={barH}
                    fill="var(--color-ink-faint)"
                    opacity="0.25"
                  />
                );
              })}
              <text x="0" y="60" fill="var(--color-ink-faint)" fontSize="9" className="font-data">
                {niceTime(candles[0]?.time, range)}
              </text>
              <text
                x={w}
                y="60"
                fill="var(--color-ink-faint)"
                fontSize="9"
                textAnchor="end"
                className="font-data"
              >
                {niceTime(candles[candles.length - 1]?.time, range)}
              </text>
            </g>
            <rect
              x="0"
              y="0"
              width={w}
              height={h}
              fill="transparent"
              style={{ cursor: "crosshair" }}
              onMouseDown={(event) => {
                const i = indexFromClientX(event.clientX, event.currentTarget.getBoundingClientRect(), candles.length);
                dragRef.current = { start: i, moved: false };
                setSelection(null);
                setHoverIndex(i);
              }}
              onMouseMove={(event) => {
                const i = indexFromClientX(event.clientX, event.currentTarget.getBoundingClientRect(), candles.length);
                setHoverIndex(i);
                const drag = dragRef.current;
                if (drag) {
                  if (i !== drag.start) drag.moved = true;
                  if (drag.moved) setSelection({ start: drag.start, end: i });
                }
              }}
              onMouseUp={() => {
                const drag = dragRef.current;
                if (drag && !drag.moved) setSelection(null);
                dragRef.current = null;
              }}
              onMouseLeave={() => {
                const drag = dragRef.current;
                if (drag && !drag.moved) setSelection(null);
                dragRef.current = null;
                setHoverIndex(null);
              }}
            />
          </svg>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between border-t border-hairline px-4 py-2 text-[10px] text-ink-faint">
        <span className="flex items-center gap-1.5">
          <BarChart3 className="h-3.5 w-3.5" />
          {history?.warning ?? "Yahoo market history, cached locally"}
        </span>
        <span className="font-data">
          {sel ? "click chart to clear selection" : "drag across the chart to compare"} · {candles.length} bars
        </span>
      </div>
    </section>
  );
}
