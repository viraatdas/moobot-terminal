import { useEffect, useRef, useState } from "react";
import { marked } from "marked";
import {
  client,
  LENS_META,
  type LensType,
  type ResearchState,
  type ResearchTab,
} from "../lib/client";
import type { FeedLine } from "../App";
import { LensSurface } from "./LensSurface";
import { onCashtagClick } from "../lib/cashtags";

interface PanelItem {
  label?: string;
  value?: string;
  detail?: string;
  url?: string;
  tone?: "pos" | "neg" | "neutral";
}

interface Panel {
  plugin: string;
  title: string;
  items: PanelItem[];
}

interface Props {
  tabs: ResearchTab[];
  feed: FeedLine[];
  onTabsChanged: () => void;
}

const SENTIMENT_STYLE: Record<string, string> = {
  bullish: "bg-pos-dim text-pos",
  bearish: "bg-neg-dim text-neg",
  neutral: "bg-panel-2 text-ink-dim",
};

export function ResearchBoard({ tabs, feed, onTabsChanged }: Props) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [findings, setFindings] = useState<{
    markdown: string;
    state: ResearchState | null;
    panels: Panel[];
    lens: Record<string, any>;
  }>({ markdown: "", state: null, panels: [], lens: {} });
  const [creating, setCreating] = useState(false);

  const [autoBusy, setAutoBusy] = useState(false);
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0] ?? null;

  // "Auto" — spin up a curated starter cockpit of three book-wide lenses.
  async function autoSetup() {
    if (autoBusy) return;
    setAutoBusy(true);
    const curated: Array<{ type: LensType; topic: string; intervalMinutes: number }> = [
      { type: "pulse", topic: "Market + my book", intervalMinutes: 30 },
      { type: "exposure", topic: "My risk", intervalMinutes: 60 },
      { type: "lattice", topic: "Correlation", intervalMinutes: 60 },
    ];
    let firstId: string | null = null;
    for (const c of curated) {
      try {
        const tab = await client.request("research.create", c);
        firstId = firstId ?? tab.id;
      } catch {}
    }
    setAutoBusy(false);
    onTabsChanged();
    if (firstId) setActiveId(firstId);
  }

  useEffect(() => {
    if (!activeId && tabs.length > 0) setActiveId(tabs[0].id);
  }, [tabs, activeId]);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const load = async () => {
      try {
        const f = await client.request("research.findings", { id: active.id });
        if (alive) setFindings(f);
      } catch {}
    };
    void load();
    const off = client.onEvent((event, payload) => {
      if (event === "research" && payload.tabId === active.id && payload.kind === "findings-updated")
        void load();
    });
    return () => {
      alive = false;
      off();
    };
  }, [active?.id]);

  // Most recent agent action for the active tab (feed is newest-first) — shown
  // as a slim live line in the header while a run is in progress.
  const latestActivity = active ? (feed.find((f) => f.tabId === active.id)?.text ?? null) : null;

  return (
    <div className="flex min-h-0 flex-col bg-bg">
      {/* tab strip */}
      <div className="flex h-10 shrink-0 items-stretch gap-px overflow-x-auto border-b border-hairline bg-panel">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveId(t.id)}
            className={`group flex shrink-0 items-center gap-2 border-b-2 px-4 text-[12px] font-medium transition-colors ${
              active?.id === t.id
                ? "border-amber bg-bg text-ink"
                : "border-transparent text-ink-faint hover:text-ink-dim"
            }`}
          >
            {t.lastRunStatus === "running" ? (
              <span className="h-1.5 w-1.5 rounded-full bg-amber pulse-dot" />
            ) : t.lastRunStatus === "error" ? (
              <span className="h-1.5 w-1.5 rounded-full bg-neg" />
            ) : (
              <span className="text-[11px] text-ink-faint">{LENS_META[t.type]?.glyph}</span>
            )}
            <span className="max-w-44 truncate">{t.topic || LENS_META[t.type]?.label}</span>
          </button>
        ))}
        <button
          onClick={() => setCreating(true)}
          className="shrink-0 px-4 text-[16px] text-ink-faint hover:text-amber"
          title="New lens tab"
        >
          +
        </button>
        <button
          onClick={() => void autoSetup()}
          disabled={autoBusy}
          className="shrink-0 px-3 text-[11px] font-medium text-ink-faint hover:text-amber disabled:opacity-50"
          title="Auto-create a starter cockpit: Pulse + Exposure + Lattice"
        >
          {autoBusy ? "…" : "✦ Auto"}
        </button>
        <div className="flex-1" />
        {tabs.length > 0 && (
          <button
            onClick={() => void client.request("research.runAll")}
            className="shrink-0 px-3 text-[10px] tracking-wide text-ink-faint uppercase hover:text-amber"
            title="Run every unpaused research tab now"
          >
            Run all
          </button>
        )}
      </div>

      {creating && (
        <NewTabForm
          tabs={tabs}
          onDone={(created) => {
            setCreating(false);
            if (created) {
              onTabsChanged();
              setActiveId(created);
            }
          }}
        />
      )}

      {!active && !creating && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <div className="font-wordmark text-[26px] italic text-ink-faint">moobot lenses</div>
          <p className="max-w-100 text-center text-[13px] leading-relaxed text-ink-faint">
            Open a lens onto your book and the market. Each tab is an agent that works
            continuously: <span className="text-ink-dim">Research</span> a topic,{" "}
            <span className="text-ink-dim">Pulse</span> what's moving,{" "}
            <span className="text-ink-dim">Exposure</span> &{" "}
            <span className="text-ink-dim">Lattice</span> for risk and correlation,{" "}
            <span className="text-ink-dim">Scout</span> for new ideas,{" "}
            <span className="text-ink-dim">Thesis</span> to test a belief, and{" "}
            <span className="text-ink-dim">Trade</span> to turn it all into proposals.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => void autoSetup()}
              disabled={autoBusy}
              className="rounded-sm border border-amber/40 bg-amber-dim px-4 py-1.5 text-[12px] font-semibold text-amber hover:bg-amber/25 disabled:opacity-50"
            >
              {autoBusy ? "Setting up…" : "✦ Auto-setup my cockpit"}
            </button>
            <button
              onClick={() => setCreating(true)}
              className="rounded-sm border border-hairline px-4 py-1.5 text-[12px] font-medium text-ink-dim hover:border-hairline-2 hover:text-ink"
            >
              New lens
            </button>
          </div>
          <p className="text-[10.5px] text-ink-faint">
            Auto spins up Pulse · Exposure · Lattice on your book.
          </p>
        </div>
      )}

      {active && (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* tab header */}
          <div className="flex shrink-0 items-center gap-3 border-b border-hairline px-5 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="shrink-0 text-[12px] text-ink-faint" title={LENS_META[active.type]?.label}>
                  {LENS_META[active.type]?.glyph}
                </span>
                <TabTitle tab={active} onChanged={onTabsChanged} />
              </div>
              {active.lastRunStatus === "error" && active.lastError ? (
                <div className="mt-0.5 truncate text-[12px] text-neg" title={active.lastError}>
                  ⚠ {active.lastError}
                </div>
              ) : active.lastRunStatus === "running" && latestActivity ? (
                <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-ink-faint">
                  <span className="h-1 w-1 shrink-0 rounded-full bg-amber pulse-dot" />
                  <span className="truncate">{latestActivity}</span>
                </div>
              ) : findings.state?.headline ? (
                <div className="mt-0.5 truncate text-[12px] text-ink-dim">
                  {findings.state.headline}
                </div>
              ) : null}
            </div>
            {active.type === "research" && findings.state?.sentiment && (
              <span
                className={`rounded-sm px-2 py-1 text-[10px] font-semibold tracking-[0.12em] uppercase ${
                  SENTIMENT_STYLE[findings.state.sentiment] ?? SENTIMENT_STYLE.neutral
                }`}
              >
                {findings.state.sentiment}
                {findings.state.conviction ? ` · ${findings.state.conviction}/10` : ""}
              </span>
            )}
            <RunControls tab={active} onChanged={onTabsChanged} />
          </div>

          {/* body: full-width lens surface */}
          <div className="flex min-h-0 flex-1 flex-col">
            {active.type === "research" ? (
              <div
                className="findings min-h-0 flex-1 overflow-y-auto px-6 py-4"
                onClick={onCashtagClick}
              >
                {findings.panels.length > 0 && (
                  <div className="mb-4 grid grid-cols-2 gap-2.5">
                    {findings.panels.map((panel) => (
                      <PluginPanel key={panel.plugin} panel={panel} />
                    ))}
                  </div>
                )}
                {findings.markdown ? (
                  <div dangerouslySetInnerHTML={{ __html: marked.parse(findings.markdown) as string }} />
                ) : (
                  <div className="py-10 text-center text-[12px] text-ink-faint">
                    {active.lastRunStatus === "running"
                      ? "First research pass running…"
                      : "No findings yet. Run the agent."}
                  </div>
                )}
              </div>
            ) : (
              <LensSurface type={active.type} lens={findings.lens} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TabTitle({ tab, onChanged }: { tab: ResearchTab; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(tab.topic);
  if (editing) {
    return (
      <input
        autoFocus
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={async () => {
          setEditing(false);
          if (val.trim() && val !== tab.topic) {
            await client.request("research.update", { id: tab.id, topic: val.trim() });
            onChanged();
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setVal(tab.topic);
            setEditing(false);
          }
        }}
        className="min-w-0 flex-1 rounded-sm border border-amber/40 bg-bg px-1.5 text-[15px] font-semibold text-ink focus:outline-none"
      />
    );
  }
  return (
    <span
      onDoubleClick={() => {
        setVal(tab.topic);
        setEditing(true);
      }}
      title="Double-click to rename"
      className="truncate text-[15px] font-semibold text-ink"
    >
      {tab.topic || LENS_META[tab.type]?.label}
    </span>
  );
}

const TONE_CLS: Record<string, string> = {
  pos: "text-pos",
  neg: "text-neg",
  neutral: "text-ink-dim",
};

function PluginPanel({ panel }: { panel: Panel }) {
  return (
    <div className="rounded-sm border border-hairline bg-panel p-3">
      <div className="mb-2 text-[9.5px] tracking-[0.16em] uppercase text-ink-faint">
        {panel.title}
      </div>
      <div className="space-y-1.5">
        {panel.items.map((item, i) => (
          <div key={i} className="text-[11px] leading-snug">
            <div className="flex items-baseline justify-between gap-2">
              {item.label && (
                <span className="font-data shrink-0 text-[9.5px] text-ink-faint">
                  {item.label}
                </span>
              )}
              <span className={`min-w-0 flex-1 truncate text-right ${TONE_CLS[item.tone ?? "neutral"] ?? "text-ink-dim"}`}>
                {item.url ? (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    className="!text-inherit !no-underline hover:!underline"
                  >
                    {item.value}
                  </a>
                ) : (
                  item.value
                )}
              </span>
            </div>
            {item.detail && (
              <div className="truncate text-[10px] text-ink-faint">{item.detail}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function RunControls({ tab, onChanged }: { tab: ResearchTab; onChanged: () => void }) {
  const running = tab.lastRunStatus === "running";
  return (
    <div className="flex items-center gap-1.5">
      <span className="font-data mr-1 text-[10px] text-ink-faint">
        {tab.intervalMinutes > 0 ? `every ${tab.intervalMinutes}m` : "manual"} · run{" "}
        {tab.runCount}
      </span>
      <button
        disabled={running}
        onClick={async () => {
          await client.request("research.run", { id: tab.id });
          onChanged();
        }}
        className="rounded-sm border border-hairline px-2.5 py-1 text-[11px] font-medium text-ink-dim hover:border-amber/50 hover:text-amber disabled:opacity-40"
      >
        {running ? "Running…" : "Run now"}
      </button>
      <button
        onClick={async () => {
          await client.request("research.update", { id: tab.id, paused: !tab.paused });
          onChanged();
        }}
        className="rounded-sm border border-hairline px-2.5 py-1 text-[11px] font-medium text-ink-dim hover:border-hairline-2 hover:text-ink"
      >
        {tab.paused ? "Resume" : "Pause"}
      </button>
      <button
        onClick={async () => {
          if (!confirm(`Close and delete research tab “${tab.topic}”?`)) return;
          await client.request("research.remove", { id: tab.id });
          onChanged();
        }}
        className="rounded-sm border border-hairline px-2 py-1 text-[11px] text-ink-faint hover:border-neg/50 hover:text-neg"
      >
        ✕
      </button>
    </div>
  );
}

const LENS_ORDER: LensType[] = ["research", "pulse", "scout", "thesis", "exposure", "lattice", "trade"];

function NewTabForm({
  tabs,
  onDone,
}: {
  tabs: ResearchTab[];
  onDone: (createdId: string | null) => void;
}) {
  const [type, setType] = useState<LensType>("research");
  const [topic, setTopic] = useState("");
  const [notes, setNotes] = useState("");
  const [interval, setIntervalMin] = useState(30);
  const [refs, setRefs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, [type]);

  const meta = LENS_META[type];
  const topicLabel =
    type === "trade"
      ? "What do you want to do? — e.g. hedge my tech concentration, add to NVDA on dips"
      : type === "pulse"
        ? "Focus (optional) — blank = your whole book + market"
        : type === "scout"
          ? "Mandate (optional) — e.g. high-IV options setups, small-cap momentum"
          : type === "thesis"
            ? "Your belief — e.g. AI power demand outruns the grid; rate cuts come slower than priced"
            : "Topic — e.g. NVDA earnings setup, uranium miners, AI capex cycle";

  async function create() {
    if (meta.hasTopic && type !== "pulse" && type !== "scout" && !topic.trim()) return;
    if (busy) return;
    setBusy(true);
    try {
      const tab = await client.request("research.create", {
        type,
        topic: topic.trim() || meta.label,
        notes: notes.trim(),
        intervalMinutes: interval,
        refs,
      });
      onDone(tab.id);
    } catch (err) {
      alert(String(err));
      setBusy(false);
    }
  }

  return (
    <div className="border-b border-hairline bg-panel px-5 py-4">
      {/* lens type picker */}
      <div className="mb-3 grid grid-cols-[repeat(auto-fit,minmax(78px,1fr))] gap-1.5">
        {LENS_ORDER.map((t) => {
          const m = LENS_META[t];
          return (
            <button
              key={t}
              onClick={() => setType(t)}
              className={`flex flex-col items-center gap-1 rounded-sm border px-1 py-2 transition-colors ${
                type === t
                  ? "border-amber/50 bg-amber-dim text-amber"
                  : "border-hairline text-ink-faint hover:text-ink-dim"
              }`}
            >
              <span className="text-[15px]">{m.glyph}</span>
              <span className="text-[10px] font-medium">{m.label}</span>
            </button>
          );
        })}
      </div>
      <p className="mb-2 text-[11px] text-ink-faint">{meta.blurb}</p>

      <div className="grid grid-cols-[1fr_auto] gap-3">
        <input
          ref={ref}
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void create();
            if (e.key === "Escape") onDone(null);
          }}
          placeholder={topicLabel}
          className="rounded-sm border border-hairline bg-bg px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:border-amber/50 focus:outline-none"
        />
        <select
          value={interval}
          onChange={(e) => setIntervalMin(Number(e.target.value))}
          className="font-data rounded-sm border border-hairline bg-bg px-2 text-[11px] text-ink-dim outline-none"
        >
          <option value={0}>manual</option>
          <option value={5}>every 5m</option>
          <option value={15}>every 15m</option>
          <option value={30}>every 30m</option>
          <option value={60}>hourly</option>
          <option value={240}>every 4h</option>
        </select>
      </div>

      {/* trade lens: @-reference other tabs */}
      {type === "trade" && tabs.length > 0 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[9.5px] tracking-[0.16em] uppercase text-ink-faint">
            @ reference
          </span>
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() =>
                setRefs((r) => (r.includes(t.id) ? r.filter((x) => x !== t.id) : [...r, t.id]))
              }
              className={`rounded-sm border px-2 py-0.5 text-[10px] font-medium ${
                refs.includes(t.id)
                  ? "border-amber/35 bg-amber-dim text-amber"
                  : "border-hairline text-ink-faint hover:text-ink-dim"
              }`}
            >
              {LENS_META[t.type]?.glyph} {t.topic}
            </button>
          ))}
        </div>
      )}

      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Optional notes for the agent: angle, constraints, position context…"
        rows={2}
        className="mt-2 w-full resize-none rounded-sm border border-hairline bg-bg px-3 py-2 text-[12px] text-ink placeholder:text-ink-faint focus:border-amber/50 focus:outline-none"
      />

      <div className="mt-2 flex justify-end gap-2">
        <button
          onClick={() => onDone(null)}
          className="rounded-sm px-3 py-1.5 text-[12px] text-ink-faint hover:text-ink"
        >
          Cancel
        </button>
        <button
          onClick={() => void create()}
          disabled={busy || (meta.hasTopic && type !== "pulse" && type !== "scout" && !topic.trim())}
          className="rounded-sm border border-amber/40 bg-amber-dim px-4 py-1.5 text-[12px] font-semibold text-amber hover:bg-amber/25 disabled:opacity-40"
        >
          {busy ? "Starting…" : `Start ${meta.label}`}
        </button>
      </div>
    </div>
  );
}
