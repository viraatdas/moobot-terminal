import { marked } from "marked";
import type { LensType } from "../lib/client";
import { fmtMoney } from "../lib/client";

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
                  <span className={`text-[13px] font-semibold ${dirColor}`}>{it.headline}</span>
                  <span className="font-data shrink-0 text-[9.5px] text-ink-faint">
                    {(it.symbols ?? []).slice(0, 4).join(" ")}
                  </span>
                </div>
                <div className="mt-0.5 text-[12px] leading-snug text-ink-dim select-text">
                  {it.detail}
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
              {it.thesis}
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

/* ---------- Exposure: risk dashboard ---------- */
function ExposureSurface({ data }: { data: any }) {
  if (!data) return <Empty>No exposure computed yet. The agent reads your book's risk.</Empty>;
  const scenarios: any[] = data.scenarios ?? [];
  const byU: any[] = data.byUnderlying ?? [];
  const maxAbsPnl = Math.max(1, ...scenarios.map((s) => Math.abs(Number(s.pnl) || 0)));
  const maxShare = Math.max(0.0001, ...byU.map((u) => Math.abs(Number(u.share) || 0)));
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <div className="grid grid-cols-2 gap-3">
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
          {data.concentration}
        </div>
      )}
      {data.notes && (
        <div className="mt-2 text-[11px] text-ink-faint select-text">{data.notes}</div>
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

/* ---------- Lattice: correlation heatmap ---------- */
function LatticeSurface({ data }: { data: any }) {
  if (!data || !Array.isArray(data.nodes) || data.nodes.length === 0)
    return <Empty>No correlation map yet. The agent maps how your holdings move together.</Empty>;
  const nodes: any[] = [...data.nodes].sort((a, b) => (b.value ?? 0) - (a.value ?? 0)).slice(0, 14);
  const syms = nodes.map((n) => n.symbol ?? n.id);
  const edges: any[] = data.edges ?? [];
  const corr = (a: string, b: string): number | null => {
    if (a === b) return 1;
    const e = edges.find(
      (e) => (e.a === a && e.b === b) || (e.a === b && e.b === a),
    );
    return e ? Number(e.corr) : null;
  };
  const cellColor = (c: number | null) => {
    if (c === null) return "transparent";
    const intensity = Math.min(1, Math.abs(c));
    return c >= 0
      ? `rgba(63,220,151,${intensity * 0.7})`
      : `rgba(255,93,93,${intensity * 0.7})`;
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto p-5">
      {data.insight && (
        <div className="mb-4 rounded-sm border border-amber/25 bg-amber-dim/40 p-3 text-[12.5px] leading-snug text-amber select-text">
          {data.insight}
        </div>
      )}
      <table className="border-collapse">
        <thead>
          <tr>
            <th className="sticky left-0 bg-bg" />
            {syms.map((s) => (
              <th
                key={s}
                className="font-data h-16 w-7 px-0 align-bottom text-[9px] text-ink-faint"
              >
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
                    title={c !== null ? `${a}/${b}: ${c.toFixed(2)}` : `${a}/${b}: —`}
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
      <div className="mt-3 flex gap-3 text-[9.5px] text-ink-faint">
        <span><span className="inline-block h-2 w-2 align-middle" style={{ background: "rgba(63,220,151,0.7)" }} /> moves together</span>
        <span><span className="inline-block h-2 w-2 align-middle" style={{ background: "rgba(255,93,93,0.7)" }} /> moves opposite</span>
        <span className="text-ink-faint">node size = $ exposure · top 14 holdings</span>
      </div>
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
    <div className="findings min-h-0 flex-1 overflow-y-auto px-6 py-4">
      <div dangerouslySetInnerHTML={{ __html: marked.parse(markdown) as string }} />
    </div>
  );
}
