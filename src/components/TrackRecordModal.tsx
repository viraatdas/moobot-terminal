import { useEffect, useState } from "react";
import { AlertTriangle, History, Loader2, Trophy, X } from "lucide-react";
import {
  client,
  fmtMoney,
  fmtPct,
  type DecisionEntry,
  type TrackRecord,
} from "../lib/client";
import { fmtDateTime, signTone } from "../lib/format";

interface Props {
  onClose: () => void;
}

type Tab = "record" | "log";

function StatBox({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-sm border border-hairline bg-panel-2 px-3 py-2">
      <div className="text-[10px] tracking-[0.12em] text-ink-faint uppercase">{label}</div>
      <div className={`font-data mt-0.5 text-[16px] ${tone ?? "text-ink"}`}>{value}</div>
    </div>
  );
}

export function TrackRecordModal({ onClose }: Props) {
  const [tab, setTab] = useState<Tab>("record");
  const [record, setRecord] = useState<TrackRecord | null>(null);
  const [log, setLog] = useState<DecisionEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    let alive = true;
    setBusy(true);
    setError(null);
    Promise.all([
      client.request<TrackRecord>("track.record"),
      client.request<DecisionEntry[]>("decisions.list"),
    ])
      .then(([rec, decisions]) => {
        if (!alive) return;
        setRecord(rec);
        setLog(Array.isArray(decisions) ? decisions : []);
      })
      .catch((err) => {
        if (alive) setError(String(err?.message ?? err));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const hitRate = record?.hitRate ?? null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="relative flex max-h-[88vh] w-full max-w-[1000px] flex-col overflow-hidden rounded-md border border-hairline-2 bg-panel">
        <div className="flex items-center justify-between gap-3 border-b border-hairline px-4 py-3">
          <div className="min-w-0">
            <div className="font-data text-[9px] tracking-[0.16em] text-ink-faint uppercase">Agent track record</div>
            <div className="font-wordmark text-[18px] leading-none italic text-ink">
              did the agents call it<span className="text-amber">?</span>
            </div>
          </div>
          <button onClick={onClose} className="text-ink-faint hover:text-ink">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center gap-1 border-b border-hairline px-4 py-2">
          <button
            onClick={() => setTab("record")}
            className={`flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-[11px] font-semibold ${
              tab === "record" ? "bg-amber-dim text-amber" : "text-ink-faint hover:text-ink-dim"
            }`}
          >
            <Trophy className="h-3.5 w-3.5" /> Track record
          </button>
          <button
            onClick={() => setTab("log")}
            className={`flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-[11px] font-semibold ${
              tab === "log" ? "bg-amber-dim text-amber" : "text-ink-faint hover:text-ink-dim"
            }`}
          >
            <History className="h-3.5 w-3.5" /> Decision log
          </button>
          <span className="ml-auto text-[10px] text-ink-faint">
            marks every proposal to live quotes, whether or not you acted
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto bg-bg p-4">
          {busy && (
            <div className="grid min-h-[200px] place-items-center">
              <div className="flex items-center gap-2 text-[12px] text-ink-dim">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-amber" />
                Marking proposals to market
              </div>
            </div>
          )}
          {error && !busy && (
            <div className="mx-auto max-w-sm rounded-sm border border-amber/25 bg-amber-dim/30 px-3 py-2 text-[12px] text-amber">
              <div className="mb-1 flex items-center gap-2 font-semibold">
                <AlertTriangle className="h-3.5 w-3.5" /> Couldn’t load track record
              </div>
              {error}
            </div>
          )}

          {!busy && !error && tab === "record" && record && (
            <>
              <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <StatBox
                  label="Hit rate"
                  value={hitRate === null ? "n/a" : `${Math.round(hitRate * 100)}%`}
                  tone={hitRate === null ? undefined : hitRate >= 0.5 ? "text-pos" : "text-neg"}
                />
                <StatBox label="Avg move" value={fmtPct(record.avgReturnPct)} tone={signTone(record.avgReturnPct)} />
                <StatBox
                  label="If you'd followed all"
                  value={fmtMoney(record.followedPnl)}
                  tone={signTone(record.followedPnl)}
                />
                <StatBox label="On what you approved" value={fmtMoney(record.actedPnl)} tone={signTone(record.actedPnl)} />
              </div>
              <div className="mb-2 font-data text-[10px] text-ink-faint">
                {record.scored} of {record.totalIdeas} ideas scored · {record.winners}W / {record.losers}L
              </div>

              {record.entries.length === 0 ? (
                <div className="grid min-h-[160px] place-items-center text-[12px] text-ink-faint">
                  No proposals yet. As agents file ideas, their entry price is captured and marked here.
                </div>
              ) : (
                <div className="overflow-hidden rounded-sm border border-hairline">
                  <table className="w-full border-collapse text-left">
                    <thead>
                      <tr className="bg-panel-2 text-[9px] tracking-[0.12em] text-ink-faint uppercase">
                        <th className="px-2.5 py-1.5 font-semibold">Idea</th>
                        <th className="px-2.5 py-1.5 font-semibold">Entry</th>
                        <th className="px-2.5 py-1.5 font-semibold">Now</th>
                        <th className="px-2.5 py-1.5 text-right font-semibold">Move</th>
                        <th className="px-2.5 py-1.5 text-right font-semibold">P&L</th>
                      </tr>
                    </thead>
                    <tbody>
                      {record.entries.map((e) => (
                        <tr key={e.id} className="border-t border-hairline">
                          <td className="px-2.5 py-1.5">
                            <div className="font-data text-[12px]">
                              <span className={e.side === "buy" ? "text-pos" : "text-neg"}>{e.side.toUpperCase()}</span>{" "}
                              <span className="text-ink">{e.quantity} {e.symbol}</span>
                            </div>
                            <div className="flex items-center gap-1.5 text-[9.5px] text-ink-faint">
                              <span className="truncate max-w-[180px]">{e.tabTopic}</span>
                              {e.acted ? (
                                <span className="rounded-sm border border-pos/30 px-1 text-pos">acted</span>
                              ) : (
                                <span className="rounded-sm border border-hairline px-1">idea</span>
                              )}
                              {e.paper && <span className="rounded-sm border border-amber/30 px-1 text-amber">paper</span>}
                            </div>
                          </td>
                          <td className="px-2.5 py-1.5 font-data text-[11px] text-ink-dim">{fmtMoney(e.entryPrice)}</td>
                          <td className="px-2.5 py-1.5 font-data text-[11px] text-ink-dim">{fmtMoney(e.currentPrice)}</td>
                          <td className={`px-2.5 py-1.5 text-right font-data text-[11px] ${signTone(e.returnPct)}`}>
                            {fmtPct(e.returnPct)}
                          </td>
                          <td className={`px-2.5 py-1.5 text-right font-data text-[11px] ${signTone(e.pnl)}`}>
                            {e.pnl === null ? "n/a" : `${e.pnl >= 0 ? "+" : ""}${fmtMoney(e.pnl)}`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {!busy && !error && tab === "log" && log && (
            <>
              {log.length === 0 ? (
                <div className="grid min-h-[160px] place-items-center text-[12px] text-ink-faint">
                  No decisions logged yet. Every approve/reject is appended here immutably.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {log.map((d) => (
                    <div key={d.id} className="rounded-sm border border-hairline bg-panel px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-data text-[12px]">
                          <span
                            className={
                              d.action === "approve"
                                ? d.outcome === "failed"
                                  ? "text-neg"
                                  : "text-pos"
                                : "text-ink-faint"
                            }
                          >
                            {d.action.toUpperCase()}
                            {d.action === "approve" && d.outcome === "failed" ? " (failed)" : ""}
                          </span>{" "}
                          <span className="text-ink">
                            {(d.executed?.quantity ?? d.proposed.quantity)} {d.symbol}
                          </span>
                        </span>
                        <span className="flex items-center gap-1.5">
                          {d.paper && (
                            <span className="rounded-sm border border-amber/30 px-1 text-[9px] font-semibold text-amber uppercase">
                              paper
                            </span>
                          )}
                          {d.executed?.modified && (
                            <span className="rounded-sm border border-amber/30 px-1 text-[9px] font-semibold text-amber uppercase">
                              edited
                            </span>
                          )}
                          <span className="font-data text-[9.5px] text-ink-faint">{fmtDateTime(d.at)}</span>
                        </span>
                      </div>
                      <div className="mt-1 font-data text-[10px] text-ink-faint">
                        from “{d.tabTopic}” · conf {d.proposed.confidence}/10
                        {d.executed
                          ? ` · ${d.executed.orderType}${
                              d.executed.limitPrice != null ? ` @ ${fmtMoney(d.executed.limitPrice)}` : ""
                            }`
                          : ""}
                      </div>
                      {d.proposed.whyNow && (
                        <div className="mt-1 text-[11px] leading-snug text-ink-dim select-text">{d.proposed.whyNow}</div>
                      )}
                      {d.error && <div className="mt-1 text-[10.5px] text-neg select-text">{d.error}</div>}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
