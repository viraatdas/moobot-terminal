import { fmtMoney } from "../../lib/client";
import { Cashtags } from "../../lib/cashtags";
import { Empty } from "./_shared";

/* ---------- Exposure: risk dashboard ---------- */
export function ExposureSurface({ data }: { data: any }) {
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
