import { Cashtags } from "../../lib/cashtags";
import { Empty } from "./_shared";

/* ---------- Scout: discovery candidate cards ---------- */
export function ScoutSurface({ items }: { items: any[] }) {
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
