import { useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, FlaskConical, Loader2, MinusCircle, Radio, ShieldAlert, ShieldCheck, ShieldQuestion, XCircle } from "lucide-react";
import {
  client,
  fmtMoney,
  type BacktestResult,
  type BacktestError,
  type EquityPoint,
  type Grade,
  type LiveConsistency,
  type SegmentMetrics,
  type StrategyGetResponse,
  type StrategySpec,
  type VerificationCheck,
  type VerificationReport,
} from "../lib/client";
import { signTone } from "../lib/format";

interface Props {
  tabId: string;
  // Initial data from the lens output (kept in sync by the board on re-authoring).
  spec: StrategySpec | null;
  markdown: string | null;
}

const OP_SYMBOL: Record<string, string> = {
  ">": ">",
  "<": "<",
  ">=": "≥",
  "<=": "≤",
  crossesAbove: "crosses above",
  crossesBelow: "crosses below",
};

function operandText(op: any): string {
  if (op === null || op === undefined) return "?";
  if (typeof op === "number") return String(op);
  if ("const" in op) return String(op.const);
  if ("price" in op) return op.price;
  if ("sma" in op) return `SMA(${op.sma})`;
  if ("ema" in op) return `EMA(${op.ema})`;
  if ("rsi" in op) return `RSI(${op.rsi})`;
  if ("atr" in op) return `ATR(${op.atr})`;
  if ("returns" in op) return `${op.returns}-bar return%`;
  if ("pctFromHigh" in op) return `% from ${op.pctFromHigh}-bar high`;
  if ("pctFromLow" in op) return `% from ${op.pctFromLow}-bar low`;
  if ("volume" in op) return "volume";
  return JSON.stringify(op);
}

function condText(c: any, depth = 0): string {
  if (!c || typeof c !== "object") return "?";
  if ("all" in c) {
    const inner = (c.all as any[]).map((x) => condText(x, depth + 1)).join(" AND ");
    return depth > 0 ? `(${inner})` : inner;
  }
  if ("any" in c) {
    const inner = (c.any as any[]).map((x) => condText(x, depth + 1)).join(" OR ");
    return depth > 0 ? `(${inner})` : inner;
  }
  if ("not" in c) return `NOT (${condText(c.not, depth + 1)})`;
  if ("trailingStop" in c) return `trailing stop ${c.trailingStop}%`;
  if ("stopLoss" in c) return `stop loss ${c.stopLoss}%`;
  if ("takeProfit" in c) return `take profit ${c.takeProfit}%`;
  if ("maxHoldBars" in c) return `held ≥ ${c.maxHoldBars} bars`;
  return `${operandText(c.lhs)} ${OP_SYMBOL[c.op] ?? c.op} ${operandText(c.rhs)}`;
}

function pct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function EquityChart({ curve, splitDate }: { curve: EquityPoint[]; splitDate: string | null }) {
  const [hover, setHover] = useState<number | null>(null);
  const w = 900;
  const h = 240;
  // Guard the empty curve: Math.min/max of [] are ±Infinity and the y-scale below
  // collapses to NaN, silently rendering nothing. Show an explicit empty state.
  if (curve.length === 0) {
    return <div className="text-[12px] text-ink-faint py-10 text-center">No equity curve — the strategy executed no trades over this window.</div>;
  }
  const equities = curve.map((p) => p.equity);
  const min = Math.min(...equities);
  const max = Math.max(...equities);
  const pad = Math.max(1, (max - min) * 0.08);
  const lo = min - pad;
  const hi = max + pad;
  const x = (i: number) => (curve.length > 1 ? (i / (curve.length - 1)) * w : w);
  const y = (v: number) => h - ((v - lo) / (hi - lo)) * h;
  const splitIndex = splitDate ? curve.findIndex((p) => p.date >= splitDate) : -1;
  const line = curve.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(p.equity).toFixed(1)}`).join(" ");
  const start = curve[0]?.equity ?? 0;
  const hoverP = hover !== null ? curve[hover] : null;
  const hoverRet = hoverP && start > 0 ? ((hoverP.equity - start) / start) * 100 : null;

  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[10px] text-ink-faint">
        <span>
          {hoverP ? (
            <span className="font-data">
              {hoverP.date} · {fmtMoney(hoverP.equity)}{" "}
              <span className={signTone(hoverRet)}>({pct(hoverRet)})</span>
            </span>
          ) : (
            <span className="font-data">equity curve · {fmtMoney(start)} start</span>
          )}
        </span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-3 rounded-sm bg-amber/15" /> out-of-sample
          </span>
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-[240px] w-full" onMouseLeave={() => setHover(null)}>
        {splitIndex > 0 && (
          <rect x={x(splitIndex)} y={0} width={w - x(splitIndex)} height={h} fill="var(--color-amber)" opacity="0.06" />
        )}
        {[0.25, 0.5, 0.75].map((p) => (
          <line key={p} x1={0} x2={w} y1={h * p} y2={h * p} stroke="var(--color-hairline)" strokeDasharray="3 6" />
        ))}
        {splitIndex > 0 && (
          <line x1={x(splitIndex)} x2={x(splitIndex)} y1={0} y2={h} stroke="var(--color-amber)" strokeOpacity="0.5" strokeDasharray="4 4" />
        )}
        <path d={line} fill="none" stroke="var(--color-ink)" strokeWidth="1.8" strokeLinejoin="round" />
        {hoverP && (
          <g pointerEvents="none">
            <line x1={x(hover!)} x2={x(hover!)} y1={0} y2={h} stroke="var(--color-ink-faint)" strokeOpacity="0.45" strokeDasharray="4 5" />
            <circle cx={x(hover!)} cy={y(hoverP.equity)} r="3.5" fill="var(--color-amber)" stroke="var(--color-bg)" strokeWidth="2" />
          </g>
        )}
        <rect
          x={0}
          y={0}
          width={w}
          height={h}
          fill="transparent"
          style={{ cursor: "crosshair" }}
          onMouseMove={(e) => {
            if (curve.length <= 1) return;
            const box = e.currentTarget.getBoundingClientRect();
            const r = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
            setHover(Math.round(r * (curve.length - 1)));
          }}
        />
      </svg>
    </div>
  );
}

function MetricCol({ m, accent }: { m: SegmentMetrics; accent?: boolean }) {
  return (
    <div className={`rounded-sm border px-3 py-2 ${accent ? "border-amber/40 bg-amber-dim/20" : "border-hairline bg-panel-2"}`}>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] tracking-[0.12em] text-ink-faint uppercase">{m.label}</span>
        <span className="font-data text-[9px] text-ink-faint">{m.trades} trades</span>
      </div>
      <div className={`font-data text-[18px] ${signTone(m.totalReturnPct)}`}>{pct(m.totalReturnPct)}</div>
      <div className="mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5 font-data text-[10px] text-ink-dim">
        <span className="text-ink-faint">CAGR</span>
        <span className={`text-right ${signTone(m.cagrPct)}`}>{pct(m.cagrPct)}</span>
        <span className="text-ink-faint">max DD</span>
        <span className="text-right text-neg">-{m.maxDrawdownPct.toFixed(1)}%</span>
        <span className="text-ink-faint">win rate</span>
        <span className="text-right">{m.winRatePct === null ? "n/a" : `${m.winRatePct.toFixed(0)}%`}</span>
        <span className="text-ink-faint">Sharpe</span>
        <span className="text-right">{m.sharpe === null ? "n/a" : m.sharpe.toFixed(2)}</span>
        <span className="text-ink-faint">exposure</span>
        <span className="text-right">{m.exposurePct.toFixed(0)}%</span>
      </div>
    </div>
  );
}

export function StrategySurface({ tabId, spec, markdown }: Props) {
  const [live, setLive] = useState(false);
  const [liveBusy, setLiveBusy] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [btBusy, setBtBusy] = useState(false);
  const [btError, setBtError] = useState<string | null>(null);
  const [serverSpec, setServerSpec] = useState<StrategySpec | null>(null);
  const [verification, setVerification] = useState<VerificationReport | null>(null);
  const [stale, setStale] = useState(true);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [liveConsistency, setLiveConsistency] = useState<LiveConsistency | null>(null);

  useEffect(() => {
    let alive = true;
    setResult(null);
    setBtError(null);
    setVerifyError(null);
    setLiveConsistency(null);
    client
      .request<StrategyGetResponse>("strategy.get", { tabId })
      .then((r) => {
        if (!alive) return;
        setLive(r.live === true);
        setServerSpec(r.spec);
        setVerification(r.verification ?? null);
        setStale(r.stale !== false);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [tabId]);

  const refreshLiveConsistency = async () => {
    try {
      setLiveConsistency(await client.request<LiveConsistency>("strategy.liveConsistency", { tabId }));
    } catch {
      /* no live data yet */
    }
  };
  useEffect(() => {
    if (live) void refreshLiveConsistency();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, tabId]);

  const effectiveSpec = spec ?? serverSpec;

  const runBacktest = async () => {
    if (btBusy) return;
    setBtBusy(true);
    setBtError(null);
    setResult(null);
    try {
      const r = await client.request<BacktestResult | BacktestError>("strategy.backtest", { tabId });
      if (r.ok) setResult(r);
      else setBtError(r.error);
    } catch (err) {
      setBtError(String((err as any)?.message ?? err));
    }
    setBtBusy(false);
  };

  const runVerify = async () => {
    if (verifyBusy) return;
    setVerifyBusy(true);
    setVerifyError(null);
    try {
      const r = await client.request<VerificationReport | { ok: false; error: string }>("strategy.verify", { tabId });
      if (r.ok) {
        setVerification(r);
        setStale(false);
      } else {
        setVerifyError(r.error);
      }
    } catch (err) {
      setVerifyError(String((err as Error)?.message ?? err));
    }
    setVerifyBusy(false);
  };

  const toggleLive = async () => {
    if (liveBusy) return;
    const next = !live;
    if (next && !confirm("Take this strategy LIVE?\n\nIts rules will start filing trade proposals into your approval queue when they trigger. You still approve every order (or simulate in paper mode). Real-money go-live requires a current 'holds-up' verification.")) {
      return;
    }
    setLiveBusy(true);
    setVerifyError(null);
    try {
      // Only reflect "live" AFTER the server gate confirms — never optimistically
      // show a money-path state the TRUST_GATE may have rejected.
      await client.request("strategy.setLive", { tabId, live: next });
      setLive(next);
      if (next) void refreshLiveConsistency();
    } catch (err) {
      setVerifyError(String((err as Error)?.message ?? err).replace(/^Error:\s*/, ""));
    }
    setLiveBusy(false);
  };

  const inOut = useMemo(() => {
    if (!result) return null;
    const drop = result.inSample.totalReturnPct - result.outOfSample.totalReturnPct;
    return { drop };
  }, [result]);

  if (!effectiveSpec) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-[13px] text-ink-faint">
        <div className="max-w-md">
          No compiled rules yet. Describe your strategy in the topic/notes and run the agent — it will translate your
          intent into mechanical, backtestable rules here.
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-4">
      {/* Honesty banner */}
      <div className="mb-3 flex gap-2 rounded-sm border border-amber/25 bg-amber-dim/30 px-3 py-2 text-[11px] leading-snug text-amber">
        <ShieldQuestion className="mt-px h-4 w-4 shrink-0" />
        <span>
          A backtest replays these mechanical rules on past prices. It <strong>cannot</strong> undo the hindsight baked
          into the thesis itself — the model that wrote these rules already knew how the past played out. Treat the{" "}
          <strong>out-of-sample</strong> column as the real test; a big in→out drop-off means overfitting. The live LLM
          gate never runs in the backtest.
        </span>
      </div>

      {/* Verification verdict — certifies the RULES, not the idea */}
      <TrustBadge grade={verification?.grade ?? "untested"} stale={stale} report={verification} />

      {/* Rules */}
      <div className="mb-3 rounded-sm border border-hairline bg-panel">
        <div className="flex items-center justify-between border-b border-hairline px-3 py-2">
          <span className="text-[10px] tracking-[0.14em] text-ink-faint uppercase">Compiled rules</span>
          <span className="font-data text-[10px] text-ink-faint">
            {effectiveSpec.direction} · {effectiveSpec.universe.join(", ")}
          </span>
        </div>
        <div className="space-y-1.5 px-3 py-2.5 text-[12px]">
          <RuleRow label="Enter" text={condText(effectiveSpec.entry)} toneCls="text-pos" />
          <RuleRow label="Exit" text={condText(effectiveSpec.exit)} toneCls="text-neg" />
          <RuleRow
            label="Size"
            text={
              effectiveSpec.sizing.type === "equityPct"
                ? `${effectiveSpec.sizing.value}% of equity per position`
                : effectiveSpec.sizing.type === "fixedNotional"
                  ? `${fmtMoney(effectiveSpec.sizing.value)} per position`
                  : `${effectiveSpec.sizing.value} shares per position`
            }
            toneCls="text-ink-dim"
          />
          <RuleRow
            label="Limits"
            text={`max ${effectiveSpec.maxPositions} open · ${effectiveSpec.cooldownBars}-bar cooldown after exit`}
            toneCls="text-ink-dim"
          />
          {effectiveSpec.llmGate && (
            <RuleRow label="LLM gate" text={effectiveSpec.llmGate.prompt || "(live-only confirmation)"} toneCls="text-amber" />
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="mb-1 flex items-center gap-2">
        <button
          onClick={runBacktest}
          disabled={btBusy}
          className="flex items-center gap-1.5 rounded-sm border border-hairline bg-panel-2 px-3 py-1.5 text-[11px] font-semibold text-ink-dim hover:border-amber/40 hover:text-ink disabled:opacity-40"
        >
          {btBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />}
          {btBusy ? "Backtesting…" : "Backtest"}
        </button>
        <button
          onClick={runVerify}
          disabled={verifyBusy}
          className="flex items-center gap-1.5 rounded-sm border border-hairline bg-panel-2 px-3 py-1.5 text-[11px] font-semibold text-ink-dim hover:border-amber/40 hover:text-ink disabled:opacity-40"
        >
          {verifyBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
          {verifyBusy ? "Verifying…" : stale && verification ? "Re-verify" : "Verify"}
        </button>
        <button
          onClick={toggleLive}
          disabled={liveBusy}
          className={`flex items-center gap-1.5 rounded-sm border px-3 py-1.5 text-[11px] font-semibold disabled:opacity-40 ${
            live ? "border-pos/50 bg-pos-dim text-pos" : "border-hairline text-ink-faint hover:border-amber/40 hover:text-ink-dim"
          }`}
        >
          <Radio className="h-3.5 w-3.5" />
          {live ? "Live — filing proposals" : "Go live"}
        </button>
      </div>
      <div className="mb-3 text-[10px] text-ink-faint">
        {verifyBusy
          ? "running the robustness battery — walk-forward, parameter nudges, cost stress, luck test…"
          : verification
            ? `last verified ${new Date(verification.verifiedAt).toLocaleString()}${stale ? " · rules changed since — re-verify before going live" : ""}`
            : "not verified — real-money go-live is blocked until a strategy holds up out-of-sample (paper mode is always allowed)"}
      </div>

      {(btError || verifyError) && (
        <div className="mb-3 flex items-start gap-2 rounded-sm border border-amber/25 bg-amber-dim/30 px-3 py-2 text-[11px] text-amber">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" /> <span>{btError ?? verifyError}</span>
        </div>
      )}

      {verification && <ReportCard report={verification} />}

      {live && liveConsistency && <LiveStrip lc={liveConsistency} />}

      {result && (
        <div className="mb-3">
          <div className="mb-2 grid grid-cols-3 gap-2">
            <MetricCol m={result.inSample} />
            <MetricCol m={result.outOfSample} accent />
            <MetricCol m={result.overall} />
          </div>
          {inOut && (
            <div className="mb-2 text-[10px] text-ink-faint">
              in→out return drop-off:{" "}
              <span className={inOut.drop > 20 ? "text-neg" : "text-ink-dim"}>{inOut.drop.toFixed(1)} pts</span>
              {inOut.drop > 20 ? " — likely overfit" : " — holds up out-of-sample"} · split {result.splitDate ?? "n/a"} ·{" "}
              {result.bars} bars · {result.symbols.join(", ")}
            </div>
          )}
          <div className="rounded-sm border border-hairline bg-panel p-3">
            <EquityChart curve={result.equityCurve} splitDate={result.splitDate} />
          </div>
        </div>
      )}

      {markdown && (
        <details className="mb-2 rounded-sm border border-hairline bg-panel px-3 py-2 text-[11px] text-ink-dim">
          <summary className="cursor-pointer text-[10px] tracking-[0.14em] text-ink-faint uppercase">Plain-English plan</summary>
          <div className="mt-2 whitespace-pre-wrap select-text">{markdown}</div>
        </details>
      )}
    </div>
  );
}

function RuleRow({ label, text, toneCls }: { label: string; text: string; toneCls: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-16 shrink-0 text-[9px] tracking-[0.12em] text-ink-faint uppercase">{label}</span>
      <span className={`font-data leading-snug select-text ${toneCls}`}>{text}</span>
    </div>
  );
}

const GRADE_META: Record<Grade, { label: string; sub: string; cls: string; Icon: typeof ShieldCheck }> = {
  untested: { label: "Untested", sub: "Run verification to grade these rules", cls: "border-hairline bg-panel-2 text-ink-faint", Icon: ShieldQuestion },
  fragile: { label: "Fragile", sub: "Did not clear the bar — trial in paper only, do not risk real capital", cls: "border-amber/40 bg-amber-dim/30 text-amber", Icon: ShieldAlert },
  "holds-up": { label: "Holds up out-of-sample", sub: "Past-data robustness only — verifies the rules, NOT the idea. Not a profit promise.", cls: "border-pos/50 bg-pos-dim text-pos", Icon: ShieldCheck },
  diverged: { label: "Diverged", sub: "Live results broke from the backtest — real capital re-gated", cls: "border-neg/50 bg-neg-dim text-neg", Icon: ShieldAlert },
};

function TrustBadge({ grade, stale, report }: { grade: Grade; stale: boolean; report: VerificationReport | null }) {
  const m = GRADE_META[grade];
  const { Icon } = m;
  return (
    <div className={`mb-3 rounded-sm border px-3 py-2 ${m.cls}`}>
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 shrink-0" />
        <span className="text-[12px] font-semibold">{m.label}</span>
        {stale && report && <span className="ml-1 rounded-sm border border-current/40 px-1.5 py-px text-[9px] tracking-[0.1em] uppercase opacity-80">stale · re-verify</span>}
        {report && (
          <span className="ml-auto font-data text-[9px] opacity-70">
            {report.tradeCount} trades · {report.exposurePct.toFixed(0)}% exposure
            {report.trials.counted > 1 ? ` · ${report.trials.counted} variants tried` : ""}
          </span>
        )}
      </div>
      <div className="mt-0.5 pl-6 text-[10px] leading-snug opacity-80">{stale && report ? "Rules changed since this verdict — re-verify before relying on it." : m.sub}</div>
    </div>
  );
}

function CheckGlyph({ status }: { status: VerificationCheck["status"] }) {
  if (status === "pass") return <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0 text-pos" />;
  if (status === "fail") return <XCircle className="mt-px h-3.5 w-3.5 shrink-0 text-neg" />;
  if (status === "warn") return <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-amber" />;
  return <MinusCircle className="mt-px h-3.5 w-3.5 shrink-0 text-ink-faint" />;
}

function ReportCard({ report }: { report: VerificationReport }) {
  return (
    <div className="mb-3 rounded-sm border border-hairline bg-panel">
      <div className="flex items-center justify-between border-b border-hairline px-3 py-2">
        <span className="text-[10px] tracking-[0.14em] text-ink-faint uppercase">Verification report</span>
        <span className="font-data text-[9px] text-ink-faint">engine {report.engineHash.slice(0, 8)} · spec {report.specHash.slice(0, 8)}</span>
      </div>
      <div className="divide-y divide-hairline">
        {(report.checks ?? []).map((c) => (
          <details key={c.id} className="group px-3 py-1.5">
            <summary className="flex cursor-pointer list-none items-start gap-2 text-[11px] leading-snug">
              <CheckGlyph status={c.status} />
              <span className="text-ink-dim">{c.headline}</span>
            </summary>
            <div className="mt-1 pl-[22px] font-data text-[10px] text-ink-faint select-text">{c.detail}</div>
          </details>
        ))}
      </div>
    </div>
  );
}

function LiveStrip({ lc }: { lc: LiveConsistency }) {
  const cls =
    lc.verdict === "consistent" ? "border-pos/50 bg-pos-dim text-pos" : lc.verdict === "diverged" ? "border-neg/50 bg-neg-dim text-neg" : "border-hairline bg-panel-2 text-ink-faint";
  const label = lc.verdict === "consistent" ? "Live matches the backtest" : lc.verdict === "diverged" ? "Live has diverged from the backtest" : "Not enough live data yet";
  return (
    <div className={`mb-3 rounded-sm border px-3 py-2 ${cls}`}>
      <div className="flex items-center gap-2">
        <Activity className="h-4 w-4 shrink-0" />
        <span className="text-[12px] font-semibold">{label}</span>
        <span className="ml-auto font-data text-[9px] opacity-70">{lc.n} settled live trades</span>
      </div>
      <div className="mt-0.5 pl-6 text-[10px] leading-snug opacity-80">{lc.detail}</div>
    </div>
  );
}
