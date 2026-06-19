import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { AlertTriangle, Bell, Sparkles, Zap } from "lucide-react";
import {
  client,
  type AccountSnapshot,
  type FeedLine,
  type MarketEvent,
  type RiskSummary,
  type ResearchTab,
  type TradeProposal,
} from "../lib/client";
import { SymbolChart } from "./SymbolChart";
import {
  allPositions,
  deriveEvents,
  deriveRisk,
  normalizeEventsPayload,
  normalizeRisk,
  type FocusSection,
} from "./cockpit/derive";
import { CorrelationPanel, EventsPanel, RiskPanel, ScannerPanel } from "./cockpit/panels";
import { AutoTraderPanel } from "./AutoTraderPanel";

interface Props {
  snapshot: AccountSnapshot | null;
  robinhoodConnected: boolean;
  agenticBuyingPower: number | null;
  tabs: ResearchTab[];
  feed: FeedLine[];
  proposals: TradeProposal[];
  activeSymbol: string;
  focusSection: FocusSection | null;
  watchlist: string[];
  onSymbolChange: (symbol: string) => void;
  onWatchlistChange: (symbols: string[]) => void;
  onConnect: () => void;
  onOpenAlerts: () => void;
  onOpenChain: (symbol: string) => void;
  onOpenPortfolioHistory: () => void;
}

export function Cockpit({
  snapshot,
  robinhoodConnected,
  feed,
  proposals,
  activeSymbol,
  focusSection,
  watchlist,
  onSymbolChange,
  onWatchlistChange,
  onConnect,
  onOpenAlerts,
  onOpenChain,
}: Props) {
  const positions = useMemo(() => allPositions(snapshot), [snapshot]);
  const localRisk = useMemo(() => deriveRisk(snapshot), [snapshot]);
  const [risk, setRisk] = useState<RiskSummary | null>(() => localRisk);
  const [events, setEvents] = useState<MarketEvent[]>([]);
  const [lattice, setLattice] = useState<any>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const riskRef = useRef<HTMLDivElement>(null);
  const eventsRef = useRef<HTMLDivElement>(null);
  const scannerRef = useRef<HTMLDivElement>(null);
  const correlationRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!robinhoodConnected) setRisk(localRisk);
    else setRisk((current) => current ?? localRisk);
  }, [localRisk, robinhoodConnected]);

  useEffect(() => {
    if (!robinhoodConnected) return;
    let alive = true;
    client
      .request<unknown>("account.risk", { accountNumber: snapshot?.accountNumber })
      .then((res) => {
        if (alive) setRisk(normalizeRisk(res, localRisk));
      })
      .catch(() => {
        if (alive) setRisk(localRisk);
      });
    client
      .request<any>("account.lattice", { accountNumber: snapshot?.accountNumber })
      .then((res) => {
        if (alive) setLattice(res);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [localRisk, robinhoodConnected, snapshot?.accountNumber, snapshot?.portfolio.asOf]);

  useEffect(() => {
    const localEvents = deriveEvents(snapshot, feed, proposals, risk ?? localRisk);
    setEvents(localEvents);
    if (!robinhoodConnected) return;
    let alive = true;
    const symbols = [...new Set([...positions.map((p) => p.symbol), ...watchlist])].slice(0, 50);
    client
      .request<unknown>("market.events", { symbols, accountNumber: snapshot?.accountNumber })
      .then((res) => {
        if (alive) setEvents(normalizeEventsPayload(res, localEvents));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [feed, localRisk, positions, proposals, risk, robinhoodConnected, snapshot, watchlist]);

  useEffect(() => {
    if (!focusSection) return;
    const map: Record<FocusSection, RefObject<HTMLDivElement | null>> = {
      chart: chartRef,
      risk: riskRef,
      events: eventsRef,
      scanner: scannerRef,
      correlation: correlationRef,
    };
    map[focusSection].current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focusSection]);

  return (
    <div className="cockpit-root min-h-0 flex-1 overflow-y-auto bg-bg" data-cockpit>
      <div className="cockpit-hero border-b border-hairline px-5 py-4">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2 text-[10px] tracking-[0.18em] text-amber uppercase">
              <Sparkles className="h-3.5 w-3.5" />
              cockpit
            </div>
            <h1 className="font-wordmark text-[32px] leading-none italic text-ink">
              trading desk<span className="text-amber">.</span>
            </h1>
            <div className="mt-2 max-w-2xl text-[12px] leading-snug text-ink-faint">
              Charts, risk, events, correlation clusters, scanners, and agent proposals in one workspace.
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={onOpenAlerts}
              className="flex h-8 items-center gap-1.5 rounded-sm border border-hairline bg-panel px-2.5 text-[11px] text-ink-dim hover:border-amber/40 hover:text-amber"
            >
              <Bell className="h-3.5 w-3.5" />
              Alerts
            </button>
            <button
              onClick={() => onOpenChain(activeSymbol)}
              className="flex h-8 items-center gap-1.5 rounded-sm border border-amber/40 bg-amber-dim px-2.5 text-[11px] font-semibold text-amber hover:bg-amber/25"
            >
              <Zap className="h-3.5 w-3.5" />
              Chain
            </button>
          </div>
        </div>
        {!robinhoodConnected && (
          <div className="mt-3 flex items-center gap-3 rounded-sm border border-amber/25 bg-amber-dim/30 px-3 py-2 text-[12px] text-amber">
            <AlertTriangle className="h-4 w-4" />
            <span className="min-w-0 flex-1">Connect Robinhood MCP to unlock live positions, chains, risk, and chart enrichment.</span>
            <button
              onClick={onConnect}
              className="shrink-0 rounded-sm border border-amber/40 bg-amber-dim px-3 py-1 text-[11px] font-semibold hover:bg-amber/25"
            >
              Connect
            </button>
          </div>
        )}
      </div>

      <div className="space-y-4 p-4">
        <AutoTraderPanel />

        <div ref={chartRef} data-cockpit-section="chart">
          <SymbolChart symbol={activeSymbol} positions={positions} onSymbolChange={onSymbolChange} />
        </div>

        <div className="grid gap-4 2xl:grid-cols-[1.1fr_0.9fr]">
          <div ref={riskRef}>
            <RiskPanel risk={risk} onSymbolChange={onSymbolChange} />
          </div>
          <div ref={correlationRef}>
            <CorrelationPanel lattice={lattice} onSymbolChange={onSymbolChange} />
          </div>
        </div>

        <div className="grid gap-4 2xl:grid-cols-[1fr_1fr]">
          <div ref={eventsRef}>
            <EventsPanel events={events} onSymbolChange={onSymbolChange} />
          </div>
          <div ref={scannerRef}>
            <ScannerPanel
              positions={positions}
              watchlist={watchlist}
              onWatchlistChange={onWatchlistChange}
              onSymbolChange={onSymbolChange}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
