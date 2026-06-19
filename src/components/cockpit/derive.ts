import {
  fmtMoney,
  type AccountRiskSummary,
  type AccountSnapshot,
  type FeedLine,
  type MarketEvent,
  type MarketEventsResponse,
  type Position,
  type RiskSummary,
  type TradeProposal,
} from "../../lib/client";
import { finiteNumber } from "../../lib/guards";

export type FocusSection = "chart" | "risk" | "events" | "scanner" | "correlation";

export interface LatticeCluster {
  label: string;
  symbols: string[];
  value: number;
  share: number;
  avgCorr: number;
}

export function allPositions(snapshot: AccountSnapshot | null): Position[] {
  if (!snapshot) return [];
  return [...snapshot.equities, ...snapshot.options, ...snapshot.crypto];
}

export function cleanSymbol(value: string): string {
  return value.replace(/^\$/, "").trim().toUpperCase();
}

export function severityClass(severity: string): string {
  if (severity === "high") return "border-neg/35 bg-neg-dim text-neg";
  if (severity === "medium") return "border-amber/35 bg-amber-dim text-amber";
  return "border-hairline bg-panel-2 text-ink-dim";
}

export function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function exposureAmount(row: { deltaDollars?: number | null; value: number }): number {
  return finiteNumber(row.deltaDollars) ?? row.value;
}

export function normalizeSymbolRows(rows: unknown): string[] | null {
  if (!Array.isArray(rows)) return null;
  return [
    ...new Set(
      rows
        .map((row) =>
          typeof row === "string" ? row : String((row as { symbol?: unknown })?.symbol ?? ""),
        )
        .map(cleanSymbol)
        .filter(Boolean),
    ),
  ].sort();
}

export function deriveRisk(snapshot: AccountSnapshot | null): RiskSummary | null {
  if (!snapshot) return null;
  const positions = allPositions(snapshot);
  const rows = positions.map((p) => {
    const optionPrice =
      typeof p.currentPrice === "number"
        ? p.currentPrice
        : typeof p.markPrice === "number"
          ? p.markPrice
          : null;
    const optionDelta =
      p.kind === "option" && typeof p.delta === "number" && optionPrice !== null
        ? p.delta * p.quantity * 100 * optionPrice
        : null;
    const deltaDollars = optionDelta ?? p.value;
    return {
      symbol: p.symbol,
      value: Math.abs(p.value),
      deltaDollars,
      kind: p.kind,
    };
  });
  const grossExposure = rows.reduce((sum, r) => sum + Math.abs(exposureAmount(r)), 0);
  const netDeltaDollars = rows.reduce((sum, r) => sum + r.deltaDollars, 0);
  const topExposures = rows
    .sort((a, b) => Math.abs(exposureAmount(b)) - Math.abs(exposureAmount(a)))
    .slice(0, 8)
    .map((r) => ({
      ...r,
      share: grossExposure > 0 ? Math.abs(exposureAmount(r)) / grossExposure : 0,
    }));
  const findExposure = (symbol: string) =>
    rows.find((r) => r.symbol === symbol)?.deltaDollars ?? 0;
  const scenarios = [
    { label: "SPY -3%", move: -0.03, pnl: netDeltaDollars * -0.03 },
    { label: "QQQ -5%", move: -0.05, pnl: netDeltaDollars * -0.05 },
    { label: "NVDA -8%", move: -0.08, pnl: findExposure("NVDA") * -0.08 },
    { label: "BTC -10%", move: -0.1, pnl: findExposure("BTC") * -0.1 },
  ];
  const warnings: RiskSummary["warnings"] = [];
  const top = topExposures[0];
  if (top && top.share >= 0.35) {
    warnings.push({
      severity: top.share >= 0.5 ? "high" : "medium",
      title: `${top.symbol} concentration`,
      detail: `${top.symbol} is ${pct(top.share)} of directional exposure.`,
    });
  }
  const expiring = snapshot.options.filter((p) => (p.daysToExpiry ?? 99) <= 7);
  if (expiring.length > 0) {
    warnings.push({
      severity: "high",
      title: "Near expiry options",
      detail: `${expiring.length} option position${expiring.length === 1 ? "" : "s"} expire within 7 days.`,
    });
  }
  if (snapshot.portfolio.cash < snapshot.portfolio.equity * 0.03) {
    warnings.push({
      severity: "medium",
      title: "Thin cash buffer",
      detail: `Cash is ${fmtMoney(snapshot.portfolio.cash)}, under 3% of account value.`,
    });
  }
  return {
    updatedAt: new Date().toISOString(),
    grossExposure,
    netDeltaDollars,
    cash: snapshot.portfolio.cash,
    topExposures,
    scenarios,
    warnings,
  };
}

export function normalizeRisk(
  raw: AccountRiskSummary | RiskSummary | unknown,
  fallback: RiskSummary | null,
): RiskSummary | null {
  if (!raw || typeof raw !== "object") return fallback;
  const value = raw as Partial<AccountRiskSummary & RiskSummary>;
  if (Array.isArray(value.topExposures) && Array.isArray(value.scenarios)) {
    return value as RiskSummary;
  }

  const grossExposure =
    finiteNumber(value.exposure?.grossDeltaDollars) ??
    finiteNumber(value.exposure?.grossPositionValue) ??
    fallback?.grossExposure ??
    0;
  const netDeltaDollars =
    finiteNumber(value.exposure?.netDeltaDollars) ?? fallback?.netDeltaDollars ?? 0;
  const topExposures =
    value.concentration?.topPositions?.map((p) => ({
      symbol: p.symbol,
      value: Math.abs(finiteNumber(p.value) ?? 0),
      deltaDollars: finiteNumber(p.value) ?? 0,
      share: finiteNumber(p.weight) ?? 0,
      kind: p.kind,
    })) ??
    fallback?.topExposures ??
    [];
  const warnings =
    value.flags?.map((flag) => ({
      title: flag.code.replace(/_/g, " "),
      detail: flag.message,
      severity: flag.level,
    })) ??
    fallback?.warnings ??
    [];

  return {
    updatedAt: String(value.updatedAt ?? fallback?.updatedAt ?? new Date().toISOString()),
    grossExposure,
    netDeltaDollars,
    cash: finiteNumber(value.portfolio?.cash) ?? fallback?.cash ?? 0,
    topExposures,
    scenarios:
      fallback?.scenarios ?? [
        { label: "SPY -3%", move: -0.03, pnl: netDeltaDollars * -0.03 },
        { label: "QQQ -5%", move: -0.05, pnl: netDeltaDollars * -0.05 },
        { label: "Book +5%", move: 0.05, pnl: netDeltaDollars * 0.05 },
        { label: "Book -10%", move: -0.1, pnl: netDeltaDollars * -0.1 },
      ],
    warnings,
  };
}

export function normalizeEvent(raw: MarketEvent | any, fallbackId: string): MarketEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const rawType = String(raw.type ?? raw.source ?? "agent");
  const type: MarketEvent["type"] =
    rawType === "option_expiration" || rawType === "option_near_expiry"
      ? "expiry"
      : rawType === "filings"
        ? "filing"
        : rawType === "positions"
          ? "expiry"
          : (["filing", "news", "expiry", "agent", "risk"].includes(rawType)
              ? rawType
              : "agent") as MarketEvent["type"];
  const severity = String(raw.severity ?? "low") as MarketEvent["severity"];
  const symbols = Array.isArray(raw.symbols)
    ? raw.symbols.map((s: unknown) => cleanSymbol(String(s))).filter(Boolean)
    : raw.symbol
      ? [cleanSymbol(String(raw.symbol))]
      : [];
  const at = String(raw.at ?? raw.date ?? new Date().toISOString());
  return {
    id: String(raw.id ?? fallbackId),
    type,
    severity: ["info", "low", "medium", "high"].includes(severity) ? severity : "low",
    title: String(raw.title ?? "Market event"),
    detail: String(raw.detail ?? raw.description ?? ""),
    symbols,
    at,
    source: raw.source ? String(raw.source) : undefined,
    url: raw.url ? String(raw.url) : undefined,
  };
}

export function normalizeEventsPayload(payload: unknown, localEvents: MarketEvent[]): MarketEvent[] {
  const remoteRows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as MarketEventsResponse).events)
      ? (payload as MarketEventsResponse).events
      : [];
  const remoteEvents = remoteRows
    .map((event, i) => normalizeEvent(event, `remote-${i}`))
    .filter((event): event is MarketEvent => event !== null);

  if (payload && typeof payload === "object" && Array.isArray((payload as MarketEventsResponse).placeholders)) {
    for (const placeholder of (payload as MarketEventsResponse).placeholders) {
      remoteEvents.push({
        id: `placeholder-${placeholder.source}`,
        type: placeholder.source === "filings" ? "filing" : "news",
        severity: "info",
        title: placeholder.title,
        detail: placeholder.description,
        symbols: placeholder.symbols ?? [],
        at: new Date().toISOString(),
        source: "Sidecar",
      });
    }
  }

  const byId = new Map([...remoteEvents, ...localEvents].map((event) => [event.id, event]));
  return [...byId.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50);
}

export function deriveEvents(
  snapshot: AccountSnapshot | null,
  feed: FeedLine[],
  proposals: TradeProposal[],
  risk: RiskSummary | null,
): MarketEvent[] {
  const now = new Date().toISOString();
  const events: MarketEvent[] = [];
  for (const p of snapshot?.options ?? []) {
    const dte = p.daysToExpiry ?? null;
    if (dte !== null && dte <= 21) {
      events.push({
        id: `expiry-${p.symbol}-${p.expirationDate}-${p.strike}-${p.side}`,
        type: "expiry",
        severity: dte <= 7 ? "high" : "medium",
        title: `${p.symbol} ${p.side?.toUpperCase() ?? "OPT"} expires in ${dte}d`,
        detail: `${p.quantity} contract${Math.abs(p.quantity) === 1 ? "" : "s"} at ${p.strike ?? "n/a"} strike, value ${fmtMoney(p.value)}.`,
        symbols: [p.symbol],
        at: p.expirationDate ?? now,
        source: "Robinhood MCP",
      });
    }
  }
  for (const warning of risk?.warnings ?? []) {
    events.push({
      id: `risk-${warning.title}`,
      type: "risk",
      severity: warning.severity,
      title: warning.title,
      detail: warning.detail,
      symbols: [],
      at: risk?.updatedAt ?? now,
      source: "Risk engine",
    });
  }
  for (const p of proposals.filter((x) => x.status === "pending").slice(0, 4)) {
    events.push({
      id: `proposal-${p.id}`,
      type: "agent",
      severity: p.confidence >= 8 ? "high" : "medium",
      title: `${p.side.toUpperCase()} ${p.quantity} ${p.symbol} awaits review`,
      detail: `${p.tabTopic} · confidence ${p.confidence}/10 · ${p.timeHorizon}`,
      symbols: [p.symbol],
      at: p.createdAt,
      source: "Proposal queue",
    });
  }
  for (const line of feed.slice(0, 8)) {
    events.push({
      id: `feed-${line.id}`,
      type: "agent",
      severity: "low",
      title: "Agent activity",
      detail: line.text,
      symbols: [],
      at: new Date(line.at).toISOString(),
      source: "Research lens",
    });
  }
  return events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40);
}
