import { useCallback, useEffect, useState } from "react";
import { Bot, ChevronRight, Power, Play, ShieldCheck, ShieldAlert, Zap, Loader2 } from "lucide-react";
import { client, fmtMoney, autoTradeStatusMeta, type AutoTradeStatus as StatusWord } from "../lib/client";

interface AutoTradeConfig {
  enabled: boolean;
  autoApprove?: boolean;
  allowReal: boolean;
  account: string;
  maxPerTrade: number;
  maxPerDay: number;
  dailyLossKill: number;
  strategyTabId: string | null;
  approveScope?: "strategy" | "all";
  acceptUnverifiedReal?: boolean;
}

interface Fill {
  id: string;
  symbol: string;
  side: string;
  quantity: number;
  status: string;
  whyNow?: string;
  execution?: { quantity: number; fillPrice: number | null; placedAt: string; paper: boolean } | null;
}

interface AutoTradeStatus {
  /** THE single posture word from the backend — never re-derived here. */
  status?: StatusWord;
  config: AutoTradeConfig;
  paper: boolean;
  /** True only when the runtime would actually OPEN new real positions right now. */
  realEntriesArmed?: boolean;
  /** Whether the auto-trader strategy tab is currently flagged live. */
  strategyLive?: boolean;
  /** Account-setup block (e.g. investor profile incomplete) that halted auto-trade. */
  block?: { reason: string; link: string | null; at: number } | null;
  todayCount: number;
  dayPnl: number | null;
  universe?: string[];
  fills: Fill[];
}

const UNIVERSE_HINT = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "AMD", "JPM"];

function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "pos" | "neg" | "amber" | "dim" }) {
  const color =
    tone === "pos" ? "text-pos" : tone === "neg" ? "text-neg" : tone === "amber" ? "text-amber" : "text-ink";
  return (
    <div className="rounded-sm border border-hairline bg-bg px-3 py-2">
      <div className="text-[9px] font-semibold tracking-[0.14em] text-ink-faint uppercase">{label}</div>
      <div className={`font-data mt-0.5 text-[15px] leading-none ${color}`}>{value}</div>
    </div>
  );
}

export function AutoTraderPanel() {
  const [status, setStatus] = useState<AutoTradeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(() => {
    client
      .request<AutoTradeStatus>("autotrade.status")
      .then((s) => {
        setStatus(s);
        setErr(null);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    // Calm cadence (was 4s): actions refresh explicitly, this just catches passive
    // updates (fills, day P&L). The old per-event refetch was the main on-screen churn.
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, [refresh]);

  const cfg = status?.config;
  const configured = !!cfg?.strategyTabId;
  const enabled = !!cfg?.enabled;
  const paper = status?.paper !== false;
  const dayPnlKnown = typeof status?.dayPnl === "number";
  const dayPnl = dayPnlKnown ? (status!.dayPnl as number) : 0;

  // ONE posture word from the backend → label + tone. No re-derivation, so this can
  // never disagree with the proposals rail or the title bar.
  const meta = autoTradeStatusMeta(status?.status);
  const realArmed = meta.real; // real money in play — gates confirms + go-live/stand-down
  const autoApprove = cfg?.autoApprove !== false; // false = Manual (proposals wait for approve)
  const scopeAll = cfg?.approveScope === "all";

  const setup = () => {
    setBusy(true);
    setErr(null);
    client
      .request("autotrade.setup", { universe: UNIVERSE_HINT })
      .then(() => refresh())
      .catch((e) => setErr(String(e?.message ?? e)))
      .finally(() => setBusy(false));
  };

  // ONE confirm gate for anything that could place REAL orders. A no-op (returns true)
  // in paper or when not real-armed — paper short-circuits at the broker regardless.
  const confirmRealMoney = (action: string): boolean =>
    !realArmed ||
    window.confirm(
      `${action}\n\nThis can place REAL orders on agentic account ${cfg?.account}, bounded only by your hard caps:\n` +
        `  • $${cfg?.maxPerTrade} max per trade\n` +
        `  • ${cfg?.maxPerDay} trades per day\n` +
        `  • auto-halt at −$${cfg?.dailyLossKill} on the day.`,
    );

  const applyPatch = (patch: Record<string, unknown>) => {
    setBusy(true);
    setErr(null);
    client
      .request<AutoTradeConfig>("autotrade.set", { patch })
      .then(() => setTimeout(refresh, 400))
      .catch((e) => setErr(String(e?.message ?? e)))
      .finally(() => setBusy(false));
  };

  // Mode = Manual (each trade waits for your approve) vs Auto-approve (auto-fills within caps).
  const setMode = (mode: "manual" | "auto") => {
    if (!cfg) return;
    if (mode === "auto" && !confirmRealMoney("Auto-approve this strategy's trades with REAL money?")) return;
    applyPatch(
      mode === "manual"
        ? { autoApprove: false }
        : { autoApprove: true, approveScope: cfg.approveScope ?? "strategy" },
    );
  };

  // Auto-approve scope (Advanced): just this strategy, or every pending proposal.
  const setScope = (scope: "strategy" | "all") => {
    if (!cfg) return;
    if (scope === "all" && !confirmRealMoney("Auto-approve EVERY pending proposal — research briefs AND manual tickets?")) return;
    applyPatch({ approveScope: scope });
  };

  const toggle = () => {
    if (!cfg) return;
    if (!enabled && !confirmRealMoney("Turn the auto-trader ON with REAL money?")) return;
    setBusy(true);
    client
      .request<AutoTradeConfig>("autotrade.set", { patch: { enabled: !enabled } })
      .then((c) => setStatus((s) => (s ? { ...s, config: c } : s)))
      .catch((e) => setErr(String(e?.message ?? e)))
      .finally(() => setBusy(false));
  };

  const runNow = () => {
    if (!confirmRealMoney("Evaluate the strategy now?")) return;
    setBusy(true);
    client
      .request("autotrade.runNow")
      .then(() => setTimeout(refresh, 1800))
      .catch((e) => setErr(String(e?.message ?? e)))
      .finally(() => setBusy(false));
  };

  // GO LIVE — the one deliberate flip to real money. Strong, explicit confirm.
  const goLive = () => {
    if (!cfg) return;
    const ok = window.confirm(
      `GO LIVE WITH REAL MONEY?\n\n` +
        `This places REAL orders on agentic account ${cfg.account} the moment a pullback trips.\n\n` +
        `The strategy is UNVERIFIED — you've accepted it's likely -EV. Your only protection is the hard caps:\n` +
        `  • $${cfg.maxPerTrade} max per trade\n` +
        `  • ${cfg.maxPerDay} trades max per day\n` +
        `  • auto-halts if the account is down $${cfg.dailyLossKill} on the day\n\n` +
        `Continue?`,
    );
    if (!ok) return;
    setBusy(true);
    setErr(null);
    client
      .request<AutoTradeConfig>("autotrade.arm")
      .then(() => setTimeout(refresh, 1800))
      .catch((e) => setErr(String(e?.message ?? e)))
      .finally(() => setBusy(false));
  };

  // RESUME — clear an account-setup block after the user has resolved it.
  const resumeBlock = () => {
    setBusy(true);
    setErr(null);
    client
      .request("autotrade.clearBlock")
      .then(() => setTimeout(refresh, 1500))
      .catch((e) => setErr(String(e?.message ?? e)))
      .finally(() => setBusy(false));
  };

  // STAND DOWN — back to safe paper mode.
  const standDown = () => {
    setBusy(true);
    setErr(null);
    client
      .request<AutoTradeConfig>("autotrade.disarm")
      .then(() => setTimeout(refresh, 600))
      .catch((e) => setErr(String(e?.message ?? e)))
      .finally(() => setBusy(false));
  };

  // Kill-switch meter. It only gates REAL money (paper trades never hit the account),
  // and is only meaningful when the account snapshot is known.
  const kill = cfg?.dailyLossKill ?? 80;
  const killActive = !paper;
  const lossSoFar = Math.max(0, -dayPnl);
  const lossUsed = killActive && dayPnlKnown ? Math.min(1, lossSoFar / kill) : 0;
  const tripped = killActive && dayPnlKnown && lossSoFar >= kill;

  return (
    <section className="overflow-hidden rounded-sm border border-hairline bg-panel">
      <div className="flex items-center justify-between border-b border-hairline px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <div className="grid h-7 w-7 place-items-center rounded-sm border border-amber/40 bg-amber-dim">
            <Bot className="h-4 w-4 text-amber" />
          </div>
          <div className="leading-tight">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold tracking-[0.16em] text-ink uppercase">Auto-Trader</span>
              <span
                className={`flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[9px] font-semibold tracking-[0.1em] uppercase ${
                  meta.tone === "neg"
                    ? "border-neg/50 bg-neg-dim text-neg"
                    : meta.tone === "amber"
                      ? "border-amber/40 bg-amber-dim text-amber"
                      : "border-hairline text-ink-faint"
                }`}
              >
                {enabled && configured && meta.tone !== "dim" && (
                  <span className={`h-1.5 w-1.5 rounded-full ${meta.tone === "neg" ? "bg-neg" : "bg-amber"} pulse-dot`} />
                )}
                {meta.label}
              </span>
            </div>
            <div className="text-[10px] text-ink-faint">
              {configured ? "Buy-the-dip mean-reversion · agentic $1k" : "no strategy wired yet"}
            </div>
          </div>
        </div>
        {configured && (
          <div className="flex items-center gap-1.5">
            {realArmed ? (
              <button
                onClick={standDown}
                disabled={busy}
                title="Disarm real-money trading and return to paper mode"
                className="flex h-7 items-center gap-1.5 rounded-sm border border-neg/50 bg-neg-dim px-2.5 text-[10px] font-semibold tracking-[0.08em] text-neg uppercase hover:bg-neg/25 disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldAlert className="h-3 w-3" />}
                Stand down
              </button>
            ) : (
              <button
                onClick={goLive}
                disabled={busy}
                title="Flip to REAL money on the agentic account (unverified, -EV — caps are the only guardrail)"
                className="flex h-7 items-center gap-1.5 rounded-sm border border-neg/50 bg-neg-dim px-2.5 text-[10px] font-semibold tracking-[0.08em] text-neg uppercase hover:bg-neg/25 disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
                Go live · real $
              </button>
            )}
            <button
              onClick={toggle}
              disabled={busy}
              title={enabled ? "Auto-trader is ON — click to pause" : "Auto-trader is OFF — click to power on"}
              className={`flex h-7 items-center gap-1.5 rounded-sm border px-3 text-[10px] font-semibold tracking-[0.08em] uppercase disabled:opacity-50 ${
                enabled
                  ? "border-amber/40 bg-amber-dim text-amber hover:bg-amber/25"
                  : "border-hairline text-ink-dim hover:border-amber/40 hover:text-amber"
              }`}
            >
              <Power className="h-3 w-3" />
              {enabled ? "On" : "Off"}
            </button>
          </div>
        )}
      </div>

      {!configured ? (
        <div className="flex flex-col items-start gap-3 px-4 py-4">
          <p className="max-w-md text-[12px] leading-snug text-ink-faint">
            Spin up an autonomous mean-reversion trader on the agentic $1k. It runs in{" "}
            <span className="text-amber">paper</span> first — fires every few minutes within hard caps, auto-fills,
            and pings you — so the rails are proven before any real order.
          </p>
          <button
            onClick={setup}
            disabled={busy}
            className="flex h-8 items-center gap-1.5 rounded-sm border border-amber/40 bg-amber-dim px-3 text-[11px] font-semibold text-amber hover:bg-amber/25 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
            Set up auto-trader
          </button>
          {err && <div className="text-[10px] text-neg">{err}</div>}
        </div>
      ) : (
        <div className="space-y-3 px-4 py-3">
          {status?.block && (
            <div className="rounded-sm border border-amber/50 bg-amber-dim px-3 py-2.5">
              <div className="flex items-center gap-1.5">
                <ShieldAlert className="h-3.5 w-3.5 text-amber" />
                <span className="text-[10px] font-semibold tracking-[0.12em] text-amber uppercase">
                  Action needed — auto-trade paused
                </span>
              </div>
              <div className="mt-1 text-[11px] leading-snug text-ink-dim">{status.block.reason}.</div>
              <div className="mt-2 flex items-center gap-2">
                {status.block.link && (
                  <a
                    href={status.block.link}
                    target="_blank"
                    rel="noreferrer"
                    className="flex h-7 items-center rounded-sm border border-amber/40 bg-amber-dim px-2.5 text-[10px] font-semibold tracking-[0.08em] text-amber uppercase hover:bg-amber/25"
                  >
                    Complete on Robinhood ↗
                  </a>
                )}
                <button
                  onClick={resumeBlock}
                  disabled={busy}
                  className="flex h-7 items-center gap-1.5 rounded-sm border border-hairline px-2.5 text-[10px] font-semibold tracking-[0.08em] text-ink-dim uppercase hover:border-amber/40 hover:text-amber disabled:opacity-50"
                >
                  {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                  I've done it — resume
                </button>
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Trades today" value={`${status?.todayCount ?? 0} / ${cfg.maxPerDay}`} tone="amber" />
            <Stat
              label={paper ? "Acct day P&L" : "Day P&L"}
              value={dayPnlKnown ? fmtMoney(dayPnl) : "n/a"}
              tone={!dayPnlKnown ? "dim" : dayPnl > 0 ? "pos" : dayPnl < 0 ? "neg" : "dim"}
            />
          </div>

          {/* ONE mode control: Manual (you approve each) vs Auto-approve (within caps). */}
          <div className="flex items-center justify-between gap-3 rounded-sm border border-hairline bg-bg px-3 py-2">
            <div className="min-w-0">
              <div className="text-[9px] font-semibold tracking-[0.14em] text-ink-faint uppercase">Mode</div>
              <div className="mt-0.5 text-[10px] leading-snug text-ink-faint">
                {!autoApprove
                  ? "Files proposals — you approve each trade."
                  : scopeAll
                    ? "Auto-approves every pending proposal, within caps."
                    : "Auto-approves this strategy's proposals, within caps."}
              </div>
            </div>
            <select
              value={autoApprove ? "auto" : "manual"}
              onChange={(e) => setMode(e.target.value === "auto" ? "auto" : "manual")}
              disabled={busy}
              className="font-data shrink-0 rounded-sm border border-hairline bg-panel-2 px-2 py-1.5 text-[11px] font-semibold text-ink outline-none disabled:opacity-50"
            >
              <option value="manual">Manual</option>
              <option value="auto">Auto-approve</option>
            </select>
          </div>

          {/* kill-switch meter — only gates real money; inactive in paper */}
          <div className="rounded-sm border border-hairline bg-bg px-3 py-2">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[9px] font-semibold tracking-[0.14em] uppercase">
                {tripped ? (
                  <ShieldAlert className="h-3 w-3 text-neg" />
                ) : (
                  <ShieldCheck className={`h-3 w-3 ${killActive && dayPnlKnown ? "text-pos" : "text-ink-faint"}`} />
                )}
                <span className={tripped ? "text-neg" : "text-ink-faint"}>
                  Kill-switch{" "}
                  {!killActive
                    ? "· inactive (paper)"
                    : !dayPnlKnown
                      ? "· account unknown"
                      : tripped
                        ? "tripped"
                        : "armed"}
                </span>
              </span>
              <span className="font-data text-[10px] text-ink-faint">
                {killActive && dayPnlKnown ? `$${lossSoFar.toFixed(2)} / $${kill} loss` : `limit $${kill}`}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-hairline">
              <div
                className={`h-full rounded-full ${
                  tripped ? "bg-neg" : lossUsed > 0.6 ? "bg-amber" : killActive && dayPnlKnown ? "bg-pos" : "bg-hairline"
                }`}
                style={{ width: `${Math.max(2, lossUsed * 100)}%` }}
              />
            </div>
          </div>

          {/* Advanced: the strategy rule, auto-approve scope, per-trade cap, manual run */}
          <details className="group rounded-sm border border-hairline bg-bg">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-[9px] font-semibold tracking-[0.14em] text-ink-faint uppercase">
              <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
              Advanced
            </summary>
            <div className="space-y-2.5 px-3 pb-3">
              <div>
                <div className="text-[9px] font-semibold tracking-[0.14em] text-ink-faint uppercase">Rule</div>
                <div className="mt-0.5 text-[11px] leading-snug text-ink-dim">
                  Buy uptrend pullbacks — price above its 200-day trend but dipped below the 5-day average; exit on the
                  bounce back or an 8% trailing stop.
                </div>
                {status && status.universe && status.universe.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {status.universe.map((s) => (
                      <span
                        key={s}
                        className="font-data rounded-sm border border-hairline bg-panel px-1.5 py-0.5 text-[9px] text-ink-dim"
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {autoApprove && (
                <div>
                  <div className="mb-1 text-[9px] font-semibold tracking-[0.14em] text-ink-faint uppercase">
                    Auto-approve scope
                  </div>
                  <div className="grid grid-cols-2 overflow-hidden rounded-sm border border-hairline">
                    {([
                      { key: "strategy", label: "This strategy", on: !scopeAll, tone: "amber" },
                      { key: "all", label: "Every proposal", on: scopeAll, tone: "neg" },
                    ] as const).map((m, i) => (
                      <button
                        key={m.key}
                        onClick={() => setScope(m.key)}
                        disabled={busy}
                        className={`h-7 text-[10px] font-semibold tracking-[0.06em] uppercase disabled:opacity-50 ${i > 0 ? "border-l border-hairline" : ""} ${
                          m.on
                            ? m.tone === "neg"
                              ? "bg-neg-dim text-neg"
                              : "bg-amber-dim text-amber"
                            : "text-ink-faint hover:text-ink-dim"
                        }`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-ink-faint">Per-trade cap ≈ ${cfg.maxPerTrade}</span>
                <button
                  onClick={runNow}
                  disabled={busy || !enabled}
                  title={realArmed ? "Evaluate now — may place REAL orders" : "Evaluate the strategy right now"}
                  className="flex h-7 items-center gap-1.5 rounded-sm border border-hairline px-2.5 text-[10px] font-semibold tracking-[0.08em] text-ink-dim uppercase hover:border-amber/40 hover:text-amber disabled:opacity-40"
                >
                  {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                  Run now
                </button>
              </div>
            </div>
          </details>

          {/* recent fills */}
          <div>
            <div className="mb-1.5 text-[9px] font-semibold tracking-[0.14em] text-ink-faint uppercase">
              Recent fills
            </div>
            {status && status.fills.length > 0 ? (
              <div className="space-y-1">
                {status.fills.slice(0, 6).map((f) => {
                  const buy = f.side?.toLowerCase() === "buy";
                  const ex = f.execution;
                  return (
                    <div
                      key={f.id}
                      className="flex items-center gap-2 rounded-sm border border-hairline bg-bg px-2.5 py-1.5 text-[11px]"
                    >
                      <span
                        className={`rounded-sm px-1.5 py-0.5 text-[9px] font-semibold tracking-[0.08em] uppercase ${
                          buy ? "bg-pos/15 text-pos" : "bg-neg/15 text-neg"
                        }`}
                      >
                        {f.side}
                      </span>
                      <span className="font-data font-semibold text-ink">{f.symbol}</span>
                      <span className="font-data text-ink-dim">
                        {ex?.quantity ?? f.quantity} @ ${ex?.fillPrice ?? "—"}
                      </span>
                      <span className="ml-auto flex items-center gap-2 text-ink-faint">
                        {ex ? (
                          ex.paper ? (
                            <span className="text-[9px] tracking-[0.1em] text-amber uppercase">paper</span>
                          ) : (
                            <span className="rounded-sm bg-neg/15 px-1 py-0.5 text-[9px] font-semibold tracking-[0.1em] text-neg uppercase">
                              real $
                            </span>
                          )
                        ) : (
                          <span className="text-[9px] tracking-[0.1em] uppercase">pending</span>
                        )}
                        <span className="text-[10px]">{ex?.placedAt ? timeAgo(ex.placedAt) : f.status}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-sm border border-dashed border-hairline bg-bg px-2.5 py-3 text-center text-[11px] text-ink-faint">
                {!enabled ? "Paused." : paper ? "Paper — waiting for the next pullback…" : "Armed — waiting for the next pullback…"}
              </div>
            )}
          </div>

          {err && <div className="text-[10px] text-neg">{err}</div>}
        </div>
      )}
    </section>
  );
}
