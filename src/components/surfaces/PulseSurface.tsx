import { Cashtags } from "../../lib/cashtags";
import { Empty } from "./_shared";

/* ---------- Pulse: impact-ranked timeline ---------- */
export function PulseSurface({ items }: { items: any[] }) {
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
                  <span className={`text-[13px] font-semibold ${dirColor}`}>
                    <Cashtags text={it.headline} />
                  </span>
                  <span className="font-data shrink-0 text-[9.5px] text-ink-faint">
                    {(it.symbols ?? []).slice(0, 4).join(" ")}
                  </span>
                </div>
                <div className="mt-0.5 text-[12px] leading-snug text-ink-dim select-text">
                  <Cashtags text={it.detail} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
