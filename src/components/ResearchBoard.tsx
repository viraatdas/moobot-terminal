import { useEffect, useRef, useState } from "react";
import { marked } from "marked";
import { client, type ResearchState, type ResearchTab } from "../lib/client";
import type { FeedLine } from "../App";

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
  }>({ markdown: "", state: null, panels: [] });
  const [creating, setCreating] = useState(false);

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0] ?? null;

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

  const tabFeed = feed.filter((f) => f.tabId === active?.id).slice(0, 30);

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
            {t.lastRunStatus === "running" && (
              <span className="h-1.5 w-1.5 rounded-full bg-amber pulse-dot" />
            )}
            {t.lastRunStatus === "error" && <span className="h-1.5 w-1.5 rounded-full bg-neg" />}
            <span className="max-w-44 truncate">{t.topic}</span>
          </button>
        ))}
        <button
          onClick={() => setCreating(true)}
          className="shrink-0 px-4 text-[16px] text-ink-faint hover:text-amber"
          title="New research tab"
        >
          +
        </button>
      </div>

      {creating && (
        <NewTabForm
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
          <div className="font-wordmark text-[26px] italic text-ink-faint">
            hyper research
          </div>
          <p className="max-w-90 text-center text-[13px] leading-relaxed text-ink-faint">
            Open a tab with a topic — “NVDA earnings setup”, “uranium miners”, “rate cut
            odds” — and an agent will research it continuously, maintaining a living thesis
            and proposing trades when the evidence is there.
          </p>
          <button
            onClick={() => setCreating(true)}
            className="mt-2 rounded-sm border border-amber/40 bg-amber-dim px-4 py-1.5 text-[12px] font-semibold text-amber hover:bg-amber/25"
          >
            New research tab
          </button>
        </div>
      )}

      {active && (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* tab header */}
          <div className="flex shrink-0 items-center gap-3 border-b border-hairline px-5 py-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] font-semibold text-ink">{active.topic}</div>
              {active.lastRunStatus === "error" && active.lastError ? (
                <div className="mt-0.5 truncate text-[12px] text-neg" title={active.lastError}>
                  ⚠ {active.lastError}
                </div>
              ) : (
                findings.state?.headline && (
                  <div className="mt-0.5 truncate text-[12px] text-ink-dim">
                    {findings.state.headline}
                  </div>
                )
              )}
            </div>
            {findings.state?.sentiment && (
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

          {/* body: findings + live feed */}
          <div className="grid min-h-0 flex-1 grid-cols-[1fr_240px]">
            <div className="findings min-h-0 overflow-y-auto px-6 py-4">
              {findings.panels.length > 0 && (
                <div className="mb-4 grid grid-cols-2 gap-2.5">
                  {findings.panels.map((panel) => (
                    <PluginPanel key={panel.plugin} panel={panel} />
                  ))}
                </div>
              )}
              {findings.markdown ? (
                <div dangerouslySetInnerHTML={{ __html: marked.parse(findings.markdown) }} />
              ) : (
                <div className="py-10 text-center text-[12px] text-ink-faint">
                  {active.lastRunStatus === "running"
                    ? "First research pass running…"
                    : "No findings yet. Run the agent."}
                </div>
              )}
            </div>
            <div className="flex min-h-0 flex-col border-l border-hairline bg-panel">
              <div className="flex items-center gap-2 px-3 pt-3 pb-1.5">
                <span className="text-[10px] tracking-[0.16em] uppercase text-ink-faint">
                  Agent activity
                </span>
                {active.lastRunStatus === "running" && (
                  <span className="h-1.5 w-1.5 rounded-full bg-amber pulse-dot" />
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
                {tabFeed.length === 0 && (
                  <div className="py-4 text-[11px] text-ink-faint">idle</div>
                )}
                {tabFeed.map((line) => (
                  <div
                    key={line.id}
                    className="feed-in border-l border-hairline-2 py-1.5 pl-2.5 text-[10.5px] leading-snug break-words text-ink-dim"
                  >
                    {line.text}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
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

function NewTabForm({ onDone }: { onDone: (createdId: string | null) => void }) {
  const [topic, setTopic] = useState("");
  const [notes, setNotes] = useState("");
  const [interval, setIntervalMin] = useState(30);
  const [busy, setBusy] = useState(false);
  const [plugins, setPlugins] = useState<
    Array<{ name: string; title: string; enabled: boolean }>
  >([]);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    client.request("plugins.list").then(setPlugins).catch(() => {});
  }, []);

  async function togglePlugin(name: string, enabled: boolean) {
    try {
      setPlugins(await client.request("plugins.setEnabled", { name, enabled }));
    } catch {}
  }

  async function create() {
    if (!topic.trim() || busy) return;
    setBusy(true);
    try {
      const tab = await client.request("research.create", {
        topic: topic.trim(),
        notes: notes.trim(),
        intervalMinutes: interval,
      });
      onDone(tab.id);
    } catch (err) {
      alert(String(err));
      setBusy(false);
    }
  }

  return (
    <div className="border-b border-hairline bg-panel px-5 py-4">
      <div className="grid grid-cols-[1fr_auto] gap-3">
        <input
          ref={ref}
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void create();
            if (e.key === "Escape") onDone(null);
          }}
          placeholder="Research topic — e.g. NVDA earnings setup, uranium miners, AI capex cycle"
          className="rounded-sm border border-hairline bg-bg px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:border-amber/50 focus:outline-none"
        />
        <select
          value={interval}
          onChange={(e) => setIntervalMin(Number(e.target.value))}
          className="font-data rounded-sm border border-hairline bg-bg px-2 text-[11px] text-ink-dim outline-none"
        >
          <option value={0}>manual</option>
          <option value={15}>every 15m</option>
          <option value={30}>every 30m</option>
          <option value={60}>hourly</option>
          <option value={240}>every 4h</option>
        </select>
      </div>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Optional notes for the agent: sources to favor, angle, position context, risk constraints…"
        rows={2}
        className="mt-2 w-full resize-none rounded-sm border border-hairline bg-bg px-3 py-2 text-[12px] text-ink placeholder:text-ink-faint focus:border-amber/50 focus:outline-none"
      />
      {plugins.length > 0 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[9.5px] tracking-[0.16em] uppercase text-ink-faint">
            Sources
          </span>
          {plugins.map((p) => (
            <button
              key={p.name}
              onClick={() => void togglePlugin(p.name, !p.enabled)}
              title={p.enabled ? "Click to disable" : "Click to enable"}
              className={`rounded-sm border px-2 py-0.5 text-[10px] font-medium transition-colors ${
                p.enabled
                  ? "border-amber/35 bg-amber-dim text-amber"
                  : "border-hairline text-ink-faint hover:text-ink-dim"
              }`}
            >
              {p.title}
            </button>
          ))}
        </div>
      )}
      <div className="mt-2 flex justify-end gap-2">
        <button
          onClick={() => onDone(null)}
          className="rounded-sm px-3 py-1.5 text-[12px] text-ink-faint hover:text-ink"
        >
          Cancel
        </button>
        <button
          onClick={() => void create()}
          disabled={!topic.trim() || busy}
          className="rounded-sm border border-amber/40 bg-amber-dim px-4 py-1.5 text-[12px] font-semibold text-amber hover:bg-amber/25 disabled:opacity-40"
        >
          {busy ? "Starting agent…" : "Start researching"}
        </button>
      </div>
    </div>
  );
}
