import { useEffect, useId, useMemo, useState } from "react";
import { AlertTriangle, BarChart3, CandlestickChart, Loader2, X } from "lucide-react";
import {
  client,
  fmtMoney,
  type PortfolioHistory,
  type PortfolioHistoryPoint,
} from "../lib/client";
import { finiteNumber, isRecord } from "../lib/guards";
import { fmtDateTime } from "../lib/format";
import { areaFor, scale } from "../lib/charts";
import { useRangeSelection } from "./portfolio/useRangeSelection";
import { PortfolioStatGrid } from "./portfolio/PortfolioStatGrid";

type RangeKey = "1D" | "5D" | "1M" | "3M" | "YTD" | "1Y" | "MAX";

const RANGE_CONFIG: Record<RangeKey, { range: string; label: string }> = {
  "1D": { range: "1d", label: "1D" },
  "5D": { range: "5d", label: "5D" },
  "1M": { range: "1mo", label: "1M" },
  "3M": { range: "3mo", label: "3M" },
  YTD: { range: "ytd", label: "YTD" },
  "1Y": { range: "1y", label: "1Y" },
  MAX: { range: "max", label: "MAX" },
};

interface Props {
  accountNumber: string | null;
  onClose: () => void;
}

interface PortfolioStats {
  first: number;
  last: number;
  change: number;
  changePct: number;
  high: number;
  low: number;
}

function timestampMs(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed =
    typeof value === "number" ? value : new Date(String(value)).getTime();
  if (!Number.isFinite(parsed)) return null;
  return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
}

function parsePoint(raw: unknown): PortfolioHistoryPoint | null {
  if (!isRecord(raw)) return null;
  const timeRaw = raw.time ?? raw.date ?? raw.timestamp;
  const time = timestampMs(timeRaw);
  const equity = finiteNumber(raw.equity);
  if (time === null || equity === null) return null;
  return {
    time,
    equity,
    cash: finiteNumber(raw.cash) ?? 0,
    invested: finiteNumber(raw.invested) ?? 0,
    asOf: timestampMs(raw.asOf) ?? time,
  };
}

function normalizeHistory(payload: unknown, accountNumber: string | null): PortfolioHistory {
  const root = isRecord(payload) ? payload : {};
  const rawPoints = Array.isArray(root.points) ? root.points : [];
  const points = rawPoints
    .map(parsePoint)
    .filter((point): point is PortfolioHistoryPoint => point !== null)
    .sort((a, b) => a.time - b.time);
  return {
    accountNumber: String(root?.accountNumber ?? accountNumber ?? ""),
    range: String(root?.range ?? ""),
    source: String(root?.source ?? "local") as "local",
    stale: Boolean(root?.stale),
    asOf: timestampMs(root?.asOf) ?? Date.now(),
    warning: typeof root?.warning === "string" ? root.warning : null,
    points,
  };
}

function toneClass(tone: "pos" | "neg" | "ink" | "amber" = "ink") {
  if (tone === "pos") return "text-pos";
  if (tone === "neg") return "text-neg";
  if (tone === "amber") return "text-amber";
  return "text-ink";
}

function equityBounds(points: PortfolioHistoryPoint[]): { min: number; max: number } {
  const values = points.map((point) => point.equity);
  if (values.length === 0) return { min: 0, max: 1 }; // empty: avoid ±Infinity from Math.min/max
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max(1, (max - min) * 0.08); // pad also separates a flat line (min === max)
  return { min: min - pad, max: max + pad };
}

function pathFor(points: PortfolioHistoryPoint[], width: number, height: number): string {
  if (points.length === 0) return "";
  const { min, max } = equityBounds(points);
  if (points.length === 1) {
    const y = scale(points[0].equity, min, max, height);
    return `M0 ${y.toFixed(2)} L${width} ${y.toFixed(2)}`;
  }
  const step = points.length > 1 ? width / (points.length - 1) : width;
  return points
    .map((point, i) => {
      const x = i * step;
      const y = scale(point.equity, min, max, height);
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function chartStats(points: PortfolioHistoryPoint[]): PortfolioStats {
  const first = points[0]?.equity ?? 0;
  const last = points[points.length - 1]?.equity ?? 0;
  const change = last - first;
  const changePct = first > 0 ? (change / first) * 100 : 0;
  const high = Math.max(...points.map((point) => point.equity));
  const low = Math.min(...points.map((point) => point.equity));
  return { first, last, change, changePct, high, low };
}

function labelForRange(range: string): string {
  if (range === "1d") return "1d";
  if (range === "5d") return "5d";
  if (range === "1mo") return "1mo";
  if (range === "3mo") return "3mo";
  if (range === "ytd") return "ytd";
  if (range === "1y") return "1y";
  if (range === "max") return "max";
  return String(range || "1d");
}

export function PortfolioPerformanceModal({ accountNumber, onClose }: Props) {
  const [range, setRange] = useState<RangeKey>("1M");
  const [history, setHistory] = useState<PortfolioHistory | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const points = useMemo(() => history?.points ?? [], [history]);
  const { hoverIndex, selection, reset: resetSelection, handlers } = useRangeSelection(points.length);
  const svgId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const areaId = `portfolioRange-${svgId}`;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!accountNumber) {
      setHistory(null);
      setError("Select an account first.");
      return;
    }
    const config = RANGE_CONFIG[range];
    let alive = true;
    resetSelection();
    setBusy(true);
    setError(null);
    void client
      .request<PortfolioHistory>("account.history", {
        accountNumber,
        range: config.range,
      })
      .then((payload) => {
        if (alive) setHistory(normalizeHistory(payload, accountNumber));
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
  }, [accountNumber, range]);

  const stats = useMemo(() => (points.length ? chartStats(points) : null), [points]);
  const w = 1024;
  const h = 300;
  const path = pathFor(points, w, h);
  const area = areaFor(path, w, h);
  const positive = (stats?.change ?? 0) >= 0;
  const headerTone = toneClass((stats?.change ?? 0) >= 0 ? "pos" : "neg");
  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  const selectedIndex = hoverIndex ?? Math.max(0, points.length - 1);
  const selectedPoint = points[selectedIndex];
  const bounds = points.length ? equityBounds(points) : { min: 0, max: 0 };
  const selectedX = points.length > 1 ? (selectedIndex / (points.length - 1)) * w : w;
  const selectedY = selectedPoint ? scale(selectedPoint.equity, bounds.min, bounds.max, h) : 0;
  const xForIndex = (i: number) => (points.length > 1 ? (i / (points.length - 1)) * w : w);
  const sel = useMemo(() => {
    if (!selection) return null;
    const a = Math.min(selection.start, selection.end);
    const b = Math.max(selection.start, selection.end);
    const pa = points[a];
    const pb = points[b];
    if (!pa || !pb || a === b) return null;
    const diff = pb.equity - pa.equity;
    const pct = pa.equity > 0 ? (diff / pa.equity) * 100 : 0;
    return { a, b, pa, pb, diff, pct, up: diff >= 0 };
  }, [selection, points]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="relative flex w-full max-w-[1100px] flex-col overflow-hidden rounded-md border border-hairline-2 bg-panel">
        <div className="flex items-center justify-between gap-3 border-b border-hairline px-4 py-3">
          <div className="min-w-0">
            <div className="font-data text-[9px] tracking-[0.16em] text-ink-faint uppercase">Portfolio performance</div>
            <div className="font-wordmark text-[18px] leading-none italic text-ink">
              account {accountNumber ?? "n/a"}<span className="text-amber">.</span>
            </div>
          </div>
          <button onClick={onClose} className="text-[16px] text-ink-faint hover:text-ink">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline px-4 py-2">
          <div className="flex items-center gap-2">
            <CandlestickChart className="h-3.5 w-3.5 text-amber" />
            <span className="font-data text-[11px] text-ink-dim">equity history</span>
            {sel ? (
              <span className="font-data flex items-center gap-1.5 text-[11px]">
                <span className="rounded-sm bg-amber-dim px-1 text-[9px] tracking-[0.1em] text-amber uppercase">selection</span>
                <span className={sel.up ? "text-pos" : "text-neg"}>
                  {sel.up ? "+" : ""}
                  {fmtMoney(sel.diff)} ({sel.up ? "+" : ""}
                  {sel.pct.toFixed(2)}%)
                </span>
                <span className="text-ink-faint">
                  {fmtDateTime(sel.pa.time)} → {fmtDateTime(sel.pb.time)}
                </span>
              </span>
            ) : stats ? (
              <span className={`font-data text-[11px] ${headerTone}`}>
                {positive ? "+" : ""}
                {fmtMoney(stats.change)} ({stats.changePct.toFixed(2)}%)
              </span>
            ) : (
              <span className="font-data text-[11px] text-ink-faint">No chart data yet</span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <BarChart3 className="h-3.5 w-3.5 text-ink-dim" />
            <span className="mr-1 text-[10px] text-ink-faint">range</span>
            {Object.keys(RANGE_CONFIG).map((key) => (
              <button
                key={key}
                onClick={() => setRange(key as RangeKey)}
                className={`h-7 rounded-sm px-2.5 text-[10px] ${
                  key === range
                    ? "bg-amber-dim text-amber"
                    : "text-ink-faint hover:text-ink-dim"
                }`}
              >
                {RANGE_CONFIG[key as RangeKey].label}
              </button>
            ))}
          </div>
        </div>

        <div className="relative min-h-0 flex-1 bg-bg p-4">
          {busy && (
            <div className="absolute inset-0 z-10 grid place-items-center bg-bg/50 backdrop-blur-[1px]">
              <div className="flex items-center gap-2 rounded-sm border border-hairline bg-panel px-3 py-2 text-[12px] text-ink-dim">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-amber" />
                Loading portfolio history
              </div>
            </div>
          )}
          {error && !busy && (
            <div className="flex min-h-[360px] flex-col items-center justify-center text-center">
              <div className="max-w-sm rounded-sm border border-amber/25 bg-amber-dim/30 px-3 py-2 text-[12px] leading-snug text-amber">
                <div className="mb-1 flex items-center gap-2 font-semibold">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Portfolio history unavailable
                </div>
                {error}
              </div>
            </div>
          )}
          {!error && !busy && points.length === 0 && (
            <div className="grid min-h-[360px] place-items-center text-[12px] text-ink-faint">
              {history?.warning ?? "No history yet. Refresh later."}
            </div>
          )}
          {!error && points.length > 0 && (
            <div>
              <PortfolioStatGrid
                startEquity={firstPoint?.equity ?? 0}
                endEquity={lastPoint?.equity ?? 0}
                high={stats?.high ?? 0}
                low={stats?.low ?? 0}
                rangeLabel={labelForRange(history?.range ?? "")}
              />
              <svg
                viewBox={`0 0 ${w} ${h + 70}`}
                className="h-[360px] w-full"
                onMouseLeave={handlers.onMouseLeave}
              >
                <defs>
                  <linearGradient id={areaId} x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor={positive ? "var(--color-pos)" : "var(--color-neg)"} stopOpacity="0.22" />
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
                  d={path}
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
                    <circle cx={xForIndex(sel.a)} cy={scale(sel.pa.equity, bounds.min, bounds.max, h)} r="4.5" fill="var(--color-amber)" stroke="var(--color-bg)" strokeWidth="2.5" />
                    <circle
                      cx={xForIndex(sel.b)}
                      cy={scale(sel.pb.equity, bounds.min, bounds.max, h)}
                      r="4.5"
                      fill={sel.up ? "var(--color-pos)" : "var(--color-neg)"}
                      stroke="var(--color-bg)"
                      strokeWidth="2.5"
                    />
                    <g transform={`translate(${Math.min(xForIndex(sel.a) + 8, w - 200)}, 8)`}>
                      <rect width="192" height="40" rx="4" fill="var(--color-panel)" stroke="var(--color-hairline-2)" />
                      <text x="10" y="17" fontSize="12" className="font-data" fill={sel.up ? "var(--color-pos)" : "var(--color-neg)"}>
                        {sel.up ? "+" : ""}
                        {fmtMoney(sel.diff)} ({sel.up ? "+" : ""}
                        {sel.pct.toFixed(2)}%)
                      </text>
                      <text x="10" y="32" fontSize="9" className="font-data" fill="var(--color-ink-faint)">
                        {fmtMoney(sel.pa.equity)} → {fmtMoney(sel.pb.equity)}
                      </text>
                    </g>
                  </g>
                )}
                {selectedPoint && (
                  <g>
                    <line
                      x1={selectedX}
                      x2={selectedX}
                      y1="0"
                      y2={h}
                      stroke="var(--color-ink-faint)"
                      strokeOpacity="0.45"
                      strokeDasharray="4 6"
                    />
                    <circle
                      cx={selectedX}
                      cy={selectedY}
                      r="5"
                      fill={positive ? "var(--color-pos)" : "var(--color-neg)"}
                      stroke="var(--color-bg)"
                      strokeWidth="3"
                    />
                    <g transform={`translate(${selectedX > w - 230 ? selectedX - 220 : selectedX + 14}, ${Math.max(8, selectedY - 34)})`}>
                      <rect width="206" height="54" rx="4" fill="var(--color-panel)" stroke="var(--color-hairline-2)" />
                      <text x="10" y="19" fill="var(--color-ink)" fontSize="13" className="font-data">
                        {fmtMoney(selectedPoint.equity)}
                      </text>
                      <text x="10" y="39" fill="var(--color-ink-faint)" fontSize="9" className="font-data">
                        {fmtDateTime(selectedPoint.time)}
                      </text>
                    </g>
                  </g>
                )}
                <rect
                  x="0"
                  y="0"
                  width={w}
                  height={h}
                  fill="transparent"
                  style={{ cursor: "crosshair" }}
                  onMouseDown={handlers.onMouseDown}
                  onMouseMove={handlers.onMouseMove}
                  onMouseUp={handlers.onMouseUp}
                />
                {firstPoint && (
                  <g transform={`translate(12, 16)`}>
                    <rect width="178" height="60" rx="4" fill="var(--color-panel)" stroke="var(--color-hairline-2)" />
                    <text x="10" y="18" fill="var(--color-ink-faint)" fontSize="9" className="font-data">
                      start
                    </text>
                    <text x="10" y="35" fill="var(--color-ink)" fontSize="13" className="font-data">
                      {fmtMoney(firstPoint.equity)}
                    </text>
                    <text x="10" y="52" fill="var(--color-ink-faint)" fontSize="9" className="font-data">
                      {fmtDateTime(firstPoint.time)}
                    </text>
                  </g>
                )}
                {lastPoint && (
                  <g transform={`translate(${w - 182}, 16)`}>
                    <rect width="178" height="60" rx="4" fill="var(--color-panel)" stroke="var(--color-hairline-2)" />
                    <text x="10" y="18" fill="var(--color-ink-faint)" fontSize="9" className="font-data">
                      end
                    </text>
                    <text x="10" y="35" fill="var(--color-ink)" fontSize="13" className="font-data">
                      {fmtMoney(lastPoint.equity)}
                    </text>
                    <text x="10" y="52" fill="var(--color-ink-faint)" fontSize="9" className="font-data">
                      {fmtDateTime(lastPoint.time)}
                    </text>
                  </g>
                )}
                <g transform={`translate(0, ${h + 12})`}>
                  {points.map((point, i) => {
                    if (i % Math.ceil(points.length / 120) !== 0) return null;
                    const x = (i / Math.max(1, points.length - 1)) * w;
                    return (
                      <text
                        key={`${point.time}-${i}`}
                        x={x}
                        y="19"
                        fill="var(--color-ink-faint)"
                        fontSize="9"
                        className="font-data"
                        textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}
                      >
                        {fmtDateTime(point.time)}
                      </text>
                    );
                  })}
                </g>
              </svg>
            </div>
          )}
        </div>
        <div className="flex border-t border-hairline px-4 py-2 text-[10px] text-ink-faint">
          <span className="flex items-center gap-1.5">
            <BarChart3 className="h-3.5 w-3.5" />
            {history?.warning ?? "Local equity history backed by snapshot cache"}
          </span>
          <span className="ml-auto">points: {points.length}</span>
          <span className="ml-3">
            updated: {new Date(history?.asOf ?? Date.now()).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          </span>
        </div>
      </div>
    </div>
  );
}
