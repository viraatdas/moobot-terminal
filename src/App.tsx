import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  client,
  LENS_META,
  type AgentEngine,
  type AccountSnapshot,
  type LensType,
  type ResearchEvent,
  type ResearchTab,
  type TradeProposal,
  type WatchlistItem,
} from "./lib/client";
import { TitleBar } from "./components/TitleBar";
import { PortfolioRail } from "./components/PortfolioRail";
import { ResearchBoard } from "./components/ResearchBoard";
import { ProposalsRail } from "./components/ProposalsRail";
import { AlertsModal } from "./components/AlertsModal";
import { ConnectionModal } from "./components/ConnectionModal";
import { Toaster } from "./components/Toaster";
import { ChainViewer } from "./components/ChainViewer";
import { Cockpit } from "./components/Cockpit";
import { PortfolioPerformanceModal } from "./components/PortfolioPerformanceModal";
import { TrackRecordModal } from "./components/TrackRecordModal";
import { CommandPalette } from "./components/CommandPalette";
import { LensTabStrip } from "./components/LensTabStrip";
import type { CommandPaletteSectionTarget } from "./components/commandPaletteModel";

export interface FeedLine {
  id: number;
  tabId: string;
  text: string;
  at: number;
}

type AppShortcutCommand =
  | "close-tab"
  | "new-tab"
  | "run-active"
  | "run-all"
  | "next-tab"
  | "previous-tab"
  | "tab-last"
  | `tab-${number}`;

let feedSeq = 0;

function normalizeWatchlistRows(rows: unknown): string[] {
  if (!Array.isArray(rows)) return [];
  return [
    ...new Set(
      rows
        .map((row) =>
          typeof row === "string" ? row : String((row as Partial<WatchlistItem>)?.symbol ?? ""),
        )
        .map((symbol) => symbol.replace(/^\$/, "").trim().toUpperCase())
        .filter(Boolean),
    ),
  ].sort();
}

function normalizeTicker(value: string | null | undefined): string | null {
  const clean = String(value ?? "")
    .replace(/^\$/, "")
    .trim()
    .toUpperCase();
  return clean || null;
}

function shortcutDigit(event: KeyboardEvent): number | null {
  if (/^Digit[1-9]$/.test(event.code)) return Number(event.code.slice("Digit".length));
  if (/^[1-9]$/.test(event.key)) return Number(event.key);
  return null;
}

export default function App() {
  const [sidecarUp, setSidecarUp] = useState(false);
  const [rhAuthed, setRhAuthed] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [accountNumber, setAccountNumber] = useState<string | null>(
    () => localStorage.getItem("moobot.account.v2") || null,
  );
  const [agenticBuyingPower, setAgenticBuyingPower] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<AccountSnapshot | null>(null);
  const [tabs, setTabs] = useState<ResearchTab[]>([]);
  const [proposals, setProposals] = useState<TradeProposal[]>([]);
  const [feed, setFeed] = useState<FeedLine[]>([]);
  const [showAlerts, setShowAlerts] = useState(false);
  const [alertSymbol, setAlertSymbol] = useState<string | null>(null);
  const [showConnection, setShowConnection] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [cloud, setCloud] = useState(false);
  const [chainSymbol, setChainSymbol] = useState<string | null>(null);
  const [centerMode, setCenterMode] = useState<"cockpit" | "lens">("cockpit");
  const [showPortfolioHistory, setShowPortfolioHistory] = useState(false);
  const [showTrackRecord, setShowTrackRecord] = useState(false);
  const [paperMode, setPaperMode] = useState(false);
  const [eventTriggers, setEventTriggers] = useState(true);
  const [activeSymbol, setActiveSymbol] = useState(
    () => localStorage.getItem("moobot.activeSymbol.v1") || "SPY",
  );
  const [watchlist, setWatchlist] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("moobot.watchlist.v1") ?? "[]");
      return Array.isArray(saved) ? saved.map((s) => String(s).toUpperCase()).filter(Boolean) : [];
    } catch {
      return [];
    }
  });
  const [activeLensId, setActiveLensId] = useState<string | null>(null);
  const [draftLensTab, setDraftLensTab] = useState<{ id: number; type: LensType } | null>(null);
  const closingLensIdRef = useRef<string | null>(null);
  const [createLensRequest, setCreateLensRequest] = useState<{
    id: number;
    type?: LensType;
  } | null>(null);
  const [selectLensRequest, setSelectLensRequest] = useState<{
    id: number;
    tabId: string;
  } | null>(null);
  const [focusSection, setFocusSection] = useState<
    "chart" | "risk" | "events" | "scanner" | "correlation" | null
  >(null);
  const [agentEngine, setAgentEngine] = useState<AgentEngine>(() => {
    const saved = localStorage.getItem("moobot.agentEngine.v1");
    return saved === "codex" ? "codex" : "claude";
  });

  // Global cashtag clicks ($SPY anywhere) open the options chain.
  useEffect(() => {
    const onTicker = (e: Event) => {
      const symbol = String((e as CustomEvent).detail ?? "").toUpperCase();
      if (symbol) {
        setActiveSymbol(symbol);
        localStorage.setItem("moobot.activeSymbol.v1", symbol);
      }
      setChainSymbol(symbol);
    };
    window.addEventListener("moobot:ticker", onTicker);
    return () => window.removeEventListener("moobot:ticker", onTicker);
  }, []);

  useEffect(() => {
    localStorage.setItem("moobot.activeSymbol.v1", activeSymbol);
  }, [activeSymbol]);

  useEffect(() => {
    localStorage.setItem("moobot.watchlist.v1", JSON.stringify(watchlist));
  }, [watchlist]);

  const refreshResearch = useCallback(async () => {
    try {
      setTabs(await client.request("research.list"));
    } catch {}
  }, []);

  const refreshProposals = useCallback(async () => {
    try {
      setProposals(await client.request("proposals.list"));
    } catch {}
  }, []);

  const refreshWatchlist = useCallback(async () => {
    try {
      setWatchlist(normalizeWatchlistRows(await client.request("watchlist.list")));
    } catch {}
  }, []);

  // Decode the settings wire shape (presence/absence -> booleans) in one place,
  // shared by the initial fetch and the live settings.changed event.
  const applySettings = useCallback((s: { paperMode?: boolean; eventTriggers?: boolean } | null | undefined) => {
    setPaperMode(s?.paperMode === true);
    setEventTriggers(s?.eventTriggers !== false);
  }, []);

  const refreshSettings = useCallback(async () => {
    try {
      applySettings(await client.request<{ paperMode?: boolean; eventTriggers?: boolean }>("settings.get"));
    } catch {}
  }, [applySettings]);

  // Optimistically flip one boolean setting, rolling back if the write fails.
  const toggleSetting = useCallback(
    async (key: "paperMode" | "eventTriggers") => {
      const setter = key === "paperMode" ? setPaperMode : setEventTriggers;
      const next = !(key === "paperMode" ? paperMode : eventTriggers);
      setter(next);
      try {
        await client.request("settings.set", { patch: { [key]: next } });
      } catch {
        setter(!next);
      }
    },
    [paperMode, eventTriggers],
  );
  const togglePaper = useCallback(() => toggleSetting("paperMode"), [toggleSetting]);
  const toggleEventTriggers = useCallback(() => toggleSetting("eventTriggers"), [toggleSetting]);

  // Full-account snapshot via the Robinhood MCP read tools.
  const refreshSnapshot = useCallback(async () => {
    try {
      const snap: AccountSnapshot = await client.request("account.snapshot", {
        accountNumber: accountNumber ?? undefined,
      });
      setSnapshot(snap);
    } catch (err) {
      console.error("snapshot refresh failed", err);
    }
  }, [accountNumber]);

  // Buying power on the agentic (tradeable) account, via the MCP.
  const refreshAgenticBp = useCallback(async (acct: string) => {
    try {
      const pf: any = await client.request("rh.call", {
        tool: "get_portfolio",
        args: { account_number: acct },
      });
      const bp = Number(pf?.buying_power?.buying_power ?? pf?.buying_power);
      setAgenticBuyingPower(Number.isFinite(bp) ? bp : null);
    } catch {
      setAgenticBuyingPower(null);
    }
  }, []);

  const bootRobinhood = useCallback(async () => {
    try {
      const status = await client.request("rh.status");
      if (!status.hasStoredTokens && !status.authenticated) return;
      await client.request("rh.connect");
      setRhAuthed(true);
      setAuthUrl(null);
    } catch (err) {
      console.error("rh boot failed", err);
    }
  }, []);

  // sidecar connection lifecycle
  useEffect(() => {
    client.start();
    const offConn = client.onConnection((up) => {
      setSidecarUp(up);
      setCloud(client.cloud);
      if (up) {
        void bootRobinhood();
        void refreshResearch();
        void refreshProposals();
        void refreshWatchlist();
        void refreshSettings();
      }
    });
    const offEvent = client.onEvent((event, payload) => {
      if (event === "rh.auth-url") setAuthUrl(payload.url);
      if (event === "proposals.changed") setProposals(payload.proposals);
      if (event === "settings.changed") {
        applySettings(payload?.settings);
      }
      if (event === "research") {
        const ev = payload as ResearchEvent;
        if (ev.kind === "activity" && ev.text) {
          setFeed((f) =>
            [{ id: feedSeq++, tabId: ev.tabId, text: ev.text!, at: Date.now() }, ...f].slice(
              0,
              120,
            ),
          );
        }
        if (ev.kind !== "activity") void refreshResearch();
      }
    });
    return () => {
      offConn();
      offEvent();
    };
  }, [bootRobinhood, refreshProposals, refreshResearch, refreshWatchlist, refreshSettings, applySettings]);

  // poll the full-account snapshot once the Robinhood MCP is connected
  useEffect(() => {
    if (!sidecarUp || !rhAuthed) return;
    const t = setInterval(() => void refreshSnapshot(), 30_000);
    return () => clearInterval(t);
  }, [sidecarUp, rhAuthed, refreshSnapshot]);

  useEffect(() => {
    if (!sidecarUp || !rhAuthed) return;
    void refreshSnapshot();
  }, [sidecarUp, rhAuthed, accountNumber, refreshSnapshot]);

  // once authed, load accounts
  useEffect(() => {
    if (!rhAuthed) return;
    (async () => {
      try {
        const res = await client.request("rh.call", { tool: "get_accounts" });
        const list = Array.isArray(res) ? res : (res?.accounts ?? res?.results ?? []);
        setAccounts(list);
        if (!accountNumber && list.length > 0) {
          // Default the VIEW to Robinhood's default account (your real holdings),
          // not the agentic trading account - that one is usually empty and would
          // show a wall of $0. Trading is routed separately (see tradeAccount).
          const preferred =
            list.find((a: any) => a?.is_default) ??
            list.find((a: any) => Number(a?.total_value) > 0) ??
            list[0];
          const num =
            preferred?.account_number ?? preferred?.accountNumber ?? preferred?.number ?? null;
          if (num) {
            setAccountNumber(String(num));
            localStorage.setItem("moobot.account.v2", String(num));
          }
        }
      } catch (err) {
        console.error("accounts load failed", err);
      }
    })();
  }, [rhAuthed]);

  // Robinhood only permits agent order placement on agentic_allowed accounts, so
  // trades always route there regardless of which account is being viewed.
  const tradeAccount = useMemo(() => {
    const agentic = accounts.find((a: any) => a?.agentic_allowed);
    const num = agentic?.account_number ?? agentic?.accountNumber ?? agentic?.number;
    return num ? String(num) : accountNumber;
  }, [accounts, accountNumber]);

  // poll agentic buying power (the tradeable balance)
  useEffect(() => {
    if (!rhAuthed || !tradeAccount) return;
    void refreshAgenticBp(tradeAccount);
    const t = setInterval(() => void refreshAgenticBp(tradeAccount), 30_000);
    return () => clearInterval(t);
  }, [rhAuthed, tradeAccount, refreshAgenticBp]);

  const connectRobinhood = useCallback(async () => {
    try {
      await client.request("rh.connect");
      setRhAuthed(true);
      setAuthUrl(null);
    } catch (err) {
      console.error("rh connect failed", err);
    }
  }, []);

  const selectAccount = useCallback((num: string) => {
    setAccountNumber(num);
    localStorage.setItem("moobot.account.v2", num);
  }, []);

  const selectAgentEngine = useCallback((engine: AgentEngine) => {
    setAgentEngine(engine);
    localStorage.setItem("moobot.agentEngine.v1", engine);
  }, []);

  const selectSymbol = useCallback((symbol: string) => {
    const clean = symbol.replace(/^\$/, "").trim().toUpperCase();
    if (!clean) return;
    setActiveSymbol(clean);
    localStorage.setItem("moobot.activeSymbol.v1", clean);
  }, []);

  const updateWatchlist = useCallback((symbols: string[]) => {
    setWatchlist(normalizeWatchlistRows(symbols));
  }, []);

  const openAlerts = useCallback(
    (symbol?: string | null) => {
      const clean = normalizeTicker(symbol) ?? activeSymbol;
      if (clean) setAlertSymbol(clean);
      if (symbol && clean) selectSymbol(clean);
      setShowAlerts(true);
    },
    [activeSymbol, selectSymbol],
  );

  const requestNewLens = useCallback((type: LensType = "research") => {
    const id = Date.now();
    setCenterMode("lens");
    setDraftLensTab({ id, type });
    setCreateLensRequest({ id, type });
  }, []);

  const cockpitSections = useMemo<CommandPaletteSectionTarget[]>(
    () => [
      {
        id: "chart",
        label: "Cockpit chart",
        detail: "Symbol chart, volume, and position marker",
        keywords: ["chart", "candles", "price", "symbol"],
      },
      {
        id: "risk",
        label: "Risk desk",
        detail: "Exposure, scenarios, and warnings",
        keywords: ["risk", "exposure", "scenario", "delta"],
      },
      {
        id: "events",
        label: "Event inbox",
        detail: "Filings, news placeholders, expiries, and agent events",
        keywords: ["events", "filings", "news", "expiry"],
      },
      {
        id: "scanner",
        label: "Scanner",
        detail: "Watchlist and book movers",
        keywords: ["scanner", "watchlist", "movers"],
      },
      {
        id: "correlation",
        label: "Correlation clusters",
        detail: "Cluster map and one-bet risk",
        keywords: ["correlation", "lattice", "clusters"],
      },
      {
        id: "research",
        label: "Research lenses",
        detail: "Agent tabs, findings, and lens composer",
        keywords: ["research", "lenses", "agents"],
      },
    ],
    [],
  );

  const focusCommandSection = useCallback((target: CommandPaletteSectionTarget) => {
    if (target.id === "research") {
      setCenterMode("lens");
      return;
    }
    const cockpitTarget =
      target.id === "chart" ||
      target.id === "risk" ||
      target.id === "events" ||
      target.id === "scanner" ||
      target.id === "correlation"
        ? target.id
        : null;
    if (cockpitTarget) {
      setCenterMode("cockpit");
      setFocusSection(cockpitTarget);
      window.setTimeout(() => setFocusSection(null), 700);
    }
  }, []);

  const pendingCount = useMemo(
    () => proposals.filter((p) => p.status === "pending").length,
    [proposals],
  );

  useEffect(() => {
    if (activeLensId && !tabs.some((tab) => tab.id === activeLensId)) {
      setActiveLensId(null);
    }
  }, [activeLensId, tabs]);

  const currentActiveLens = useMemo(() => {
    if (centerMode === "lens" && draftLensTab) return null;
    if (activeLensId) {
      const synced = tabs.find((tab) => tab.id === activeLensId);
      return synced ?? null;
    }
    return centerMode === "lens" ? (tabs[0] ?? null) : null;
  }, [activeLensId, centerMode, draftLensTab, tabs]);

  const selectLensTab = useCallback((tab: ResearchTab) => {
    setDraftLensTab(null);
    setCreateLensRequest(null);
    setActiveLensId(tab.id);
    setCenterMode("lens");
    setSelectLensRequest({ id: Date.now(), tabId: tab.id });
  }, []);

  const closeDraftLensTab = useCallback((): boolean => {
    setDraftLensTab(null);
    setCreateLensRequest(null);
    if (activeLensId && tabs.some((tab) => tab.id === activeLensId)) {
      setCenterMode("lens");
      setSelectLensRequest({ id: Date.now(), tabId: activeLensId });
    } else if (tabs.length > 0) {
      setActiveLensId(tabs[0].id);
      setCenterMode("lens");
      setSelectLensRequest({ id: Date.now(), tabId: tabs[0].id });
    } else {
      setActiveLensId(null);
      setCenterMode("cockpit");
    }
    return true;
  }, [activeLensId, tabs]);

  const closeLensTab = useCallback(
    (tab: ResearchTab): boolean => {
      if (closingLensIdRef.current === tab.id) return true;
      const label = tab.topic || LENS_META[tab.type]?.label || "lens";
      if (!confirm(`Close and delete research tab "${label}"?`)) return true;
      const closingIndex = tabs.findIndex((candidate) => candidate.id === tab.id);
      const next = tabs[closingIndex + 1] ?? tabs[closingIndex - 1] ?? null;
      const closingActive = activeLensId === tab.id || currentActiveLens?.id === tab.id;
      closingLensIdRef.current = tab.id;
      void client
        .request("research.remove", { id: tab.id })
        .then(() => {
          if (closingActive) {
            setActiveLensId(next?.id ?? null);
            if (next) {
              setSelectLensRequest({ id: Date.now(), tabId: next.id });
            } else {
              setCenterMode("cockpit");
            }
          }
          return refreshResearch();
        })
        .catch((err) => console.error("close lens failed", err))
        .finally(() => {
          if (closingLensIdRef.current === tab.id) closingLensIdRef.current = null;
        });
      return true;
    },
    [activeLensId, currentActiveLens?.id, refreshResearch, tabs],
  );

  const finishDraftLensTab = useCallback(
    (createdId: string | null) => {
      setDraftLensTab(null);
      setCreateLensRequest(null);
      if (createdId) {
        setActiveLensId(createdId);
        setCenterMode("lens");
        setSelectLensRequest({ id: Date.now(), tabId: createdId });
        return;
      }
      closeDraftLensTab();
    },
    [closeDraftLensTab],
  );

  const runAppShortcut = useCallback(
    (command: AppShortcutCommand): boolean => {
      if (command === "new-tab") {
        requestNewLens("research");
        return true;
      }

      if (command === "close-tab") {
        if (centerMode !== "lens") return false;
        if (draftLensTab) return closeDraftLensTab();
        if (!currentActiveLens) return false;
        return closeLensTab(currentActiveLens);
      }

      if (command === "run-all") {
        void client
          .request("research.runAll")
          .then(() => refreshResearch())
          .catch((err) => console.error("run all failed", err));
        return tabs.length > 0;
      }

      if (command === "run-active") {
        if (!currentActiveLens || currentActiveLens.lastRunStatus === "running") return false;
        void client
          .request("research.run", { id: currentActiveLens.id })
          .then(() => refreshResearch())
          .catch((err) => console.error("run lens failed", err));
        return true;
      }

      // One ordered "deck" of center-pane destinations: cockpit first, then each
      // lens tab. tab-N, tab-last, and next/previous all index into this single
      // list so the three navigation commands can never drift apart.
      type DeckEntry = { kind: "cockpit" } | { kind: "lens"; tab: ResearchTab };
      const deck: DeckEntry[] = [{ kind: "cockpit" }, ...tabs.map((tab) => ({ kind: "lens" as const, tab }))];
      const goTo = (entry: DeckEntry | undefined): boolean => {
        if (!entry) return false;
        if (entry.kind === "cockpit") {
          setCenterMode("cockpit");
          return true;
        }
        selectLensTab(entry.tab);
        return true;
      };

      if (command === "tab-last") {
        // Original tab-last targeted tabs[last] and returned false with no lenses
        // (a no-op rather than a jump to cockpit); preserve that empty-deck false.
        if (deck.length <= 1) return false;
        return goTo(deck[deck.length - 1]);
      }
      if (command.startsWith("tab-")) {
        // tab-N maps to deck[N-1] (tab-1 -> cockpit, tab-2 -> first lens, …).
        // Out-of-range N yields undefined -> goTo returns false, as before.
        return goTo(deck[Number(command.slice(4)) - 1]);
      }

      // next/previous wrap modularly through the deck. With no lens tabs the deck
      // is just [cockpit] (length 1); the original code returned false (a no-op
      // that lets the keypress through) in that case rather than re-focusing the
      // cockpit, so guard the same way.
      if (deck.length <= 1) return false;
      const currentIndex =
        centerMode === "cockpit"
          ? 0
          : Math.max(1, tabs.findIndex((tab) => tab.id === currentActiveLens?.id) + 1);
      const delta = command === "next-tab" ? 1 : -1;
      const nextIndex = (currentIndex + delta + deck.length) % deck.length;
      return goTo(deck[nextIndex]);
    },
    [
      centerMode,
      closeDraftLensTab,
      closeLensTab,
      currentActiveLens,
      draftLensTab,
      requestNewLens,
      selectLensTab,
      tabs,
    ],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      let command: AppShortcutCommand | null = null;

      if (event.metaKey && !event.ctrlKey && !event.altKey && key === "w") command = "close-tab";
      else if (event.metaKey && !event.ctrlKey && !event.altKey && key === "t") command = "new-tab";
      else if (event.metaKey && !event.ctrlKey && !event.altKey && key === "r" && event.shiftKey)
        command = "run-all";
      else if (event.metaKey && !event.ctrlKey && !event.altKey && key === "r") command = "run-active";
      else {
        const digit = event.metaKey && !event.ctrlKey && !event.altKey ? shortcutDigit(event) : null;
        if (digit !== null) command = digit === 9 ? "tab-last" : (`tab-${digit}` as AppShortcutCommand);
      }

      const bracketRight = event.code === "BracketRight" || event.key === "]";
      const bracketLeft = event.code === "BracketLeft" || event.key === "[";
      const forward =
        (event.ctrlKey && key === "tab" && !event.shiftKey) ||
        (event.metaKey && !event.ctrlKey && !event.altKey && (bracketRight || (key === "tab" && !event.shiftKey)));
      const back =
        (event.ctrlKey && key === "tab" && event.shiftKey) ||
        (event.metaKey && !event.ctrlKey && !event.altKey && (bracketLeft || (key === "tab" && event.shiftKey)));
      if (!command && forward) {
        command = "next-tab";
      }
      if (!command && back) {
        command = "previous-tab";
      }

      if (command) {
        if (commandPaletteOpen && command !== "close-tab") return;
        const handled = runAppShortcut(command);
        if (handled || command === "close-tab") event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [commandPaletteOpen, runAppShortcut]);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let dispose: (() => void) | null = null;
    let cancelled = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<AppShortcutCommand>("moobot://shortcut", (event) => {
          if (commandPaletteOpen && event.payload !== "close-tab") return;
          runAppShortcut(event.payload);
        }),
      )
      .then((unlisten) => {
        if (cancelled) void unlisten();
        else dispose = unlisten;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (dispose) void dispose();
    };
  }, [commandPaletteOpen, runAppShortcut]);

  useEffect(() => {
    if (localStorage.getItem("moobot.activeSymbol.v1")) return;
    const first =
      snapshot?.equities[0]?.symbol ??
      snapshot?.options[0]?.symbol ??
      snapshot?.crypto[0]?.symbol;
    if (first) selectSymbol(first);
  }, [selectSymbol, snapshot]);

  return (
    <div className="flex h-full flex-col">
      <TitleBar
        sidecarUp={sidecarUp}
        rhAuthed={rhAuthed}
        accounts={accounts}
        accountNumber={accountNumber}
        onSelectAccount={selectAccount}
        onConnect={connectRobinhood}
        authUrl={authUrl}
        pendingCount={pendingCount}
        onOpenAlerts={() => openAlerts(activeSymbol)}
        onOpenConnection={() => setShowConnection(true)}
        cloud={cloud}
        agentEngine={agentEngine}
        onAgentEngineChange={selectAgentEngine}
        paperMode={paperMode}
        onTogglePaper={togglePaper}
        onOpenTrackRecord={() => setShowTrackRecord(true)}
        eventTriggers={eventTriggers}
        onToggleEventTriggers={toggleEventTriggers}
      />
      <div className="grid min-h-0 flex-1 grid-cols-[300px_1fr_340px] gap-px bg-hairline">
        <div className="col-in col-in-1 flex min-h-0 flex-col">
          <PortfolioRail
            snapshot={snapshot}
            robinhoodConnected={rhAuthed}
            agenticBuyingPower={agenticBuyingPower}
            onConnect={connectRobinhood}
            onOpenPortfolioHistory={() => setShowPortfolioHistory(true)}
          />
        </div>
        <div className="col-in col-in-2 flex min-h-0 flex-col">
          <LensTabStrip
            centerMode={centerMode}
            tabs={tabs}
            activeLens={currentActiveLens}
            draftLensTab={draftLensTab}
            onSelectCockpit={() => setCenterMode("cockpit")}
            onSelectLens={selectLensTab}
            onCloseLens={closeLensTab}
            onOpenDraft={(draft) => {
              setCenterMode("lens");
              setCreateLensRequest({ id: draft.id, type: draft.type });
            }}
            onCloseDraft={closeDraftLensTab}
            onNewLens={() => requestNewLens("research")}
            onOpenCommandPalette={() => setCommandPaletteOpen(true)}
          />
          <div className="flex min-h-0 flex-1 flex-col">
            {centerMode === "cockpit" ? (
              <Cockpit
                snapshot={snapshot}
                robinhoodConnected={rhAuthed}
                agenticBuyingPower={agenticBuyingPower}
                tabs={tabs}
                feed={feed}
                proposals={proposals}
                activeSymbol={activeSymbol}
                focusSection={focusSection}
                watchlist={watchlist}
                onSymbolChange={selectSymbol}
                onWatchlistChange={updateWatchlist}
                onConnect={connectRobinhood}
                onOpenAlerts={() => openAlerts(activeSymbol)}
                onOpenPortfolioHistory={() => setShowPortfolioHistory(true)}
                onOpenChain={(symbol) => {
                  selectSymbol(symbol);
                  setChainSymbol(symbol);
                }}
              />
            ) : (
              <ResearchBoard
                tabs={tabs}
                feed={feed}
                agentEngine={agentEngine}
                createLensRequest={createLensRequest}
                selectTabRequest={selectLensRequest}
                creatingOnly={Boolean(draftLensTab)}
                showTabStrip={false}
                onActiveTabChange={(tab) => {
                  if (!draftLensTab) setActiveLensId(tab?.id ?? null);
                }}
                onCreateLensDone={finishDraftLensTab}
                onTabsChanged={refreshResearch}
              />
            )}
          </div>
        </div>
        <div className="col-in col-in-3 flex min-h-0 flex-col">
          <ProposalsRail
            proposals={proposals}
            accountNumber={tradeAccount}
            tradeAccountAgentic={accounts.some((a: any) => a?.agentic_allowed)}
            paperMode={paperMode}
            onChanged={refreshProposals}
          />
        </div>
      </div>
      {showAlerts && (
        <AlertsModal initialSymbol={alertSymbol ?? activeSymbol} onClose={() => setShowAlerts(false)} />
      )}
      {showConnection && <ConnectionModal onClose={() => setShowConnection(false)} />}
      {showPortfolioHistory && (
        <PortfolioPerformanceModal
          accountNumber={snapshot?.accountNumber || accountNumber}
          onClose={() => setShowPortfolioHistory(false)}
        />
      )}
      {chainSymbol !== null && (
        <ChainViewer initialSymbol={chainSymbol || undefined} onClose={() => setChainSymbol(null)} />
      )}
      {showTrackRecord && <TrackRecordModal onClose={() => setShowTrackRecord(false)} />}
      <CommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        snapshot={snapshot}
        watchlist={watchlist.map((symbol) => ({ symbol }))}
        researchTabs={tabs}
        activeLens={currentActiveLens}
        sectionTargets={cockpitSections}
        onOpenOptionsChain={(symbol) => {
          if (symbol) selectSymbol(symbol);
          setChainSymbol(symbol ?? activeSymbol);
        }}
        onAddAlert={(symbol) => {
          openAlerts(symbol);
        }}
        onRunActiveLens={async (tab) => {
          const current = tabs.find((candidate) => candidate.id === tab.id);
          if (!current || current.lastRunStatus === "running") return;
          await client.request("research.run", { id: current.id });
          await refreshResearch();
        }}
        onRunAllLenses={async () => {
          await client.request("research.runAll");
          await refreshResearch();
        }}
        onCreateLens={(type) => requestNewLens(type)}
        onFocusSection={focusCommandSection}
        onSelectSymbol={(symbol) => selectSymbol(symbol)}
      />
      <Toaster />
    </div>
  );
}
