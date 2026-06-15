import { fmtMoney } from "../../lib/client";
import { Cashtags } from "../../lib/cashtags";
import { Empty, SectionLabel, Ticker, sourceLabel } from "./_shared";

/* ---------- Thesis: belief vs. book + sourced ideas ---------- */
function fitTone(fit: string): { text: string; border: string } {
  const f = fit.toLowerCase();
  if (f === "supports") return { text: "text-pos", border: "var(--color-pos)" };
  if (f === "contradicts") return { text: "text-neg", border: "var(--color-neg)" };
  return { text: "text-ink-dim", border: "var(--color-ink-faint)" };
}

function AlignmentRing({ value }: { value: number }) {
  const v = Math.max(0, Math.min(100, value));
  const R = 33;
  const C = 2 * Math.PI * R;
  const off = C * (1 - v / 100);
  const color =
    v >= 66 ? "var(--color-pos)" : v >= 33 ? "var(--color-amber)" : "var(--color-neg)";
  return (
    <svg width="82" height="82" viewBox="0 0 82 82">
      <circle cx="41" cy="41" r={R} fill="none" stroke="var(--color-hairline-2)" strokeWidth="6" />
      <circle
        cx="41"
        cy="41"
        r={R}
        fill="none"
        stroke={color}
        strokeWidth="6"
        strokeLinecap="round"
        strokeDasharray={C}
        strokeDashoffset={off}
        transform="rotate(-90 41 41)"
        style={{ transition: "stroke-dashoffset 0.6s cubic-bezier(0.16,1,0.3,1)" }}
      />
      <text
        x="41"
        y="39"
        textAnchor="middle"
        className="font-data"
        fill="var(--color-ink)"
        fontSize="19"
        fontWeight="600"
      >
        {Math.round(v)}
      </text>
      <text x="41" y="54" textAnchor="middle" fill="var(--color-ink-faint)" fontSize="9">
        / 100
      </text>
    </svg>
  );
}

export function ThesisSurface({ data }: { data: any }) {
  if (!data)
    return (
      <Empty>
        No thesis yet. State a belief - the agent scores your book against it, sources evidence
        online, and finds tickers that fit.
      </Empty>
    );
  const align = Math.max(0, Math.min(100, Number(data?.verdict?.alignment) || 0));
  const holdings: any[] = (Array.isArray(data.holdings) ? [...data.holdings] : []).sort(
    (a, b) => (Number(b.value) || 0) - (Number(a.value) || 0),
  );
  const ideas: any[] = Array.isArray(data.ideas) ? data.ideas : [];
  const evidence: any[] = Array.isArray(data.evidence) ? data.evidence : [];

  return (
    <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5 select-text">
      {/* header: thesis + alignment ring */}
      <div className="flex items-start gap-5">
        <div className="min-w-0 flex-1">
          <SectionLabel>The thesis</SectionLabel>
          <div className="text-[15px] leading-snug text-ink">
            <Cashtags text={data.thesis} />
          </div>
          {data.stance && (
            <div className="mt-2 inline-flex items-center gap-1.5 rounded-sm border border-amber/25 bg-amber-dim px-2 py-1 text-[11px] text-amber">
              <span className="text-[9px] tracking-[0.12em] uppercase text-amber/70">The bet</span>
              <Cashtags text={data.stance} />
            </div>
          )}
          {data?.verdict?.summary && (
            <div className="mt-3 text-[12px] leading-snug text-ink-dim">
              <Cashtags text={data.verdict.summary} />
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-center">
          <AlignmentRing value={align} />
          <div className="mt-1 text-[9.5px] tracking-[0.14em] uppercase text-ink-faint">
            book alignment
          </div>
        </div>
      </div>

      {/* book vs. thesis */}
      <section>
        <SectionLabel>Your book vs. this thesis</SectionLabel>
        {holdings.length === 0 ? (
          <div className="text-[11.5px] text-ink-faint">
            No positions read - connect your full account to score the book.
          </div>
        ) : (
          <div className="space-y-1">
            {holdings.map((h, i) => {
              const tone = fitTone(String(h.fit));
              const fit = String(h.fit ?? "neutral").toLowerCase();
              return (
                <div
                  key={i}
                  className="flex items-center gap-3 rounded-sm border-l-2 bg-panel py-1.5 pr-3 pl-2.5"
                  style={{ borderLeftColor: tone.border }}
                >
                  <Ticker sym={h.symbol} />
                  <span className={`shrink-0 text-[9px] uppercase tracking-wide ${tone.text}`}>
                    {fit}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-dim">
                    {h.reason}
                  </span>
                  <span className="font-data shrink-0 text-[10px] text-ink-faint">
                    {fmtMoney(h.value)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* new tickers that fit */}
      <section>
        <SectionLabel>Ideas that fit{ideas.length ? ` · ${ideas.length}` : ""}</SectionLabel>
        {ideas.length === 0 ? (
          <div className="text-[11.5px] text-ink-faint">No new tickers surfaced yet.</div>
        ) : (
          <div className="grid gap-3 xl:grid-cols-2">
            {ideas.map((it, i) => (
              <div key={i} className="rounded-sm border border-hairline bg-panel p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <Ticker sym={it.symbol} />
                  <span
                    className={`text-[10px] font-semibold uppercase ${
                      it.direction === "short" ? "text-neg" : "text-pos"
                    }`}
                  >
                    {it.direction ?? "long"} · {it.confidence ?? "?"}/10
                  </span>
                </div>
                {it.name && <div className="mt-0.5 text-[10px] text-ink-faint">{it.name}</div>}
                <div className="mt-1 text-[11.5px] leading-snug text-ink-dim">
                  <Cashtags text={it.rationale} />
                </div>
                {Array.isArray(it.sources) && it.sources.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                    {it.sources.slice(0, 3).map((s: any, j: number) =>
                      s?.url ? (
                        <a
                          key={j}
                          href={s.url}
                          target="_blank"
                          rel="noreferrer"
                          title={s?.title}
                          className="truncate text-[10px] text-amber hover:underline"
                        >
                          {sourceLabel(s)} ↗
                        </a>
                      ) : null,
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* sourced evidence both ways */}
      <section>
        <SectionLabel>Evidence</SectionLabel>
        {evidence.length === 0 ? (
          <div className="text-[11.5px] text-ink-faint">No sourced evidence yet.</div>
        ) : (
          <div className="space-y-1.5">
            {evidence.map((e, i) => {
              const against = String(e.stance).toLowerCase() === "contradicts";
              return (
                <div
                  key={i}
                  className="flex gap-2.5 rounded-sm border-l-2 bg-panel py-1.5 pr-3 pl-2.5"
                  style={{ borderLeftColor: against ? "var(--color-neg)" : "var(--color-pos)" }}
                >
                  <span
                    className={`shrink-0 text-[14px] leading-tight ${against ? "text-neg" : "text-pos"}`}
                  >
                    {against ? "−" : "+"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[11.5px] leading-snug text-ink-dim">
                      <Cashtags text={e.claim} />
                    </div>
                    {e.source?.url && (
                      <a
                        href={e.source.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[10px] text-amber hover:underline"
                      >
                        {sourceLabel(e.source)} ↗
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {data.gaps && (
        <div className="rounded-sm border border-hairline bg-panel-2 px-3 py-2 text-[11.5px] leading-snug text-ink-dim">
          <span className="mr-1.5 text-[9px] tracking-[0.14em] uppercase text-ink-faint">
            What would break this
          </span>
          <Cashtags text={data.gaps} />
        </div>
      )}
    </div>
  );
}
