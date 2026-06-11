import type { CorrelationEngine, CorrelationLattice } from "./correlation.ts";
import type { Position, RobinhoodMcpData } from "./rh-mcp-data.ts";

export interface RiskPosition {
  symbol: string;
  kind: Position["kind"];
  title: string | null;
  quantity: number;
  value: number;
  weight: number;
  unrealizedPnl: number;
  daysToExpiry: number | null;
}

export interface RiskFlag {
  level: "info" | "medium" | "high";
  code: string;
  message: string;
  details: Record<string, unknown>;
}

export interface AccountRiskSummary {
  updatedAt: string;
  accountNumber: string;
  grossExposure: number;
  netDeltaDollars: number;
  cash: number;
  topExposures: Array<{
    symbol: string;
    value: number;
    deltaDollars: number;
    share: number;
    kind: string;
  }>;
  scenarios: Array<{ label: string; move: number; pnl: number }>;
  warnings: Array<{ title: string; detail: string; severity: "low" | "medium" | "high" }>;
  portfolio: {
    equity: number;
    cash: number;
    invested: number;
    pnl: number;
    pnlPercent: number;
    asOf: number;
  };
  exposure: {
    grossPositionValue: number;
    equityValue: number;
    optionValue: number;
    cryptoValue: number;
    grossDeltaDollars: number;
    netDeltaDollars: number;
    cashPct: number;
    investedPct: number;
    optionsPct: number;
    betaSpy90Weighted: number | null;
  };
  concentration: {
    largestWeight: number;
    herfindahl: number;
    topPositions: RiskPosition[];
  };
  options: {
    count: number;
    value: number;
    nearExpiryCount: number;
    nearExpiryDays: number;
    earliestExpiration: string | null;
    averageIv: number | null;
  };
  correlation: {
    method: string;
    measuredPct: number;
    avgCorrWeighted: number;
    grossExposure: number;
    clusters: CorrelationLattice["clusters"];
    topEdges: Array<{
      a: string;
      b: string;
      corr: number;
      source: "measured" | "estimated";
      observations: number;
      riskContribution: number;
    }>;
    insight: string;
  };
  flags: RiskFlag[];
}

const NEAR_EXPIRY_DAYS = 7;

function toNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function nodeExposure(node: { deltaDollars?: unknown; value?: unknown }): number {
  return finiteNumber(node.deltaDollars) ?? toNumber(node.value);
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function daysUntilDateOnly(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return null;
  const expiry = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((expiry - today) / 86400000);
}

function riskPosition(position: Position, baseValue: number): RiskPosition {
  return {
    symbol: position.symbol,
    kind: position.kind,
    title: position.title ?? null,
    quantity: toNumber(position.quantity),
    value: toNumber(position.value),
    weight: safeRatio(Math.abs(toNumber(position.value)), baseValue),
    unrealizedPnl: toNumber(position.unrealizedPnl),
    daysToExpiry:
      position.kind === "option" ? daysUntilDateOnly(position.expirationDate) : null,
  };
}

function average(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function correlationBeta(lattice: CorrelationLattice): number | null {
  let totalWeight = 0;
  let weighted = 0;
  for (const node of lattice.nodes) {
    if (typeof node.betaSpy90 !== "number" || !Number.isFinite(node.betaSpy90)) continue;
    const exposure = nodeExposure(node);
    const sign = exposure === 0 ? 0 : Math.sign(exposure);
    totalWeight += node.weight;
    weighted += sign * node.betaSpy90 * node.weight;
  }
  return totalWeight > 0 ? weighted / totalWeight : null;
}

function buildFlags(input: {
  largestWeight: number;
  optionsPct: number;
  nearExpiryCount: number;
  earliestDays: number | null;
  cashPct: number;
  lattice: CorrelationLattice;
}): RiskFlag[] {
  const flags: RiskFlag[] = [];
  if (input.largestWeight >= 0.35) {
    flags.push({
      level: "high",
      code: "high_concentration",
      message: "Largest position is more than 35% of account equity.",
      details: { largestWeight: input.largestWeight },
    });
  } else if (input.largestWeight >= 0.2) {
    flags.push({
      level: "medium",
      code: "elevated_concentration",
      message: "Largest position is more than 20% of account equity.",
      details: { largestWeight: input.largestWeight },
    });
  }
  if (input.optionsPct >= 0.5) {
    flags.push({
      level: "high",
      code: "high_option_exposure",
      message: "Options marked value is more than 50% of account equity.",
      details: { optionsPct: input.optionsPct },
    });
  } else if (input.optionsPct >= 0.3) {
    flags.push({
      level: "medium",
      code: "elevated_option_exposure",
      message: "Options marked value is more than 30% of account equity.",
      details: { optionsPct: input.optionsPct },
    });
  }
  if (input.nearExpiryCount > 0) {
    flags.push({
      level: input.earliestDays !== null && input.earliestDays <= 1 ? "high" : "medium",
      code: "near_expiry_options",
      message: `${input.nearExpiryCount} option position${
        input.nearExpiryCount === 1 ? "" : "s"
      } expire within ${NEAR_EXPIRY_DAYS} days.`,
      details: { nearExpiryCount: input.nearExpiryCount, earliestDays: input.earliestDays },
    });
  }
  if (input.cashPct < -0.05) {
    flags.push({
      level: "medium",
      code: "negative_cash",
      message: "Cash balance is negative by more than 5% of account equity.",
      details: { cashPct: input.cashPct },
    });
  }
  const topCluster = input.lattice.clusters[0];
  if (topCluster && topCluster.share >= 0.5) {
    flags.push({
      level: topCluster.share >= 0.7 ? "high" : "medium",
      code: "correlated_cluster",
      message: "A high-correlation cluster dominates the exposed value.",
      details: {
        label: topCluster.label,
        share: topCluster.share,
        avgCorr: topCluster.avgCorr,
        symbols: topCluster.symbols,
      },
    });
  }
  if (input.lattice.edges.length > 0 && input.lattice.measuredPct < 0.5) {
    flags.push({
      level: "info",
      code: "limited_correlation_history",
      message: "Less than half of correlation edges are measured from cached market history.",
      details: { measuredPct: input.lattice.measuredPct },
    });
  }
  return flags;
}

function warningSeverity(level: RiskFlag["level"]): "low" | "medium" | "high" {
  return level === "info" ? "low" : level;
}

export class RiskSummaryService {
  private rhData: RobinhoodMcpData;
  private correlation: CorrelationEngine;

  constructor(rhData: RobinhoodMcpData, correlation: CorrelationEngine) {
    this.rhData = rhData;
    this.correlation = correlation;
  }

  async summary(accountNumber?: string): Promise<AccountRiskSummary> {
    const [snapshot, lattice] = await Promise.all([
      this.rhData.snapshot(accountNumber),
      this.correlation.lattice(accountNumber),
    ]);
    const positions = [...snapshot.equities, ...snapshot.options, ...snapshot.crypto];
    const equity = toNumber(snapshot.portfolio.equity);
    const grossPositionValue = positions.reduce(
      (sum, position) => sum + Math.abs(toNumber(position.value)),
      0,
    );
    const baseValue = Math.abs(equity) || grossPositionValue || 1;
    const rankedPositions = positions
      .map((position) => riskPosition(position, baseValue))
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    const largestWeight = rankedPositions[0]?.weight ?? 0;
    const herfindahl = rankedPositions.reduce((sum, position) => sum + position.weight ** 2, 0);
    const optionPositions = snapshot.options;
    const optionValue = optionPositions.reduce(
      (sum, position) => sum + Math.abs(toNumber(position.value)),
      0,
    );
    const nearExpiry = optionPositions
      .map((position) => daysUntilDateOnly(position.expirationDate))
      .filter((days): days is number => days !== null && days >= 0 && days <= NEAR_EXPIRY_DAYS)
      .sort((a, b) => a - b);
    const ivs = optionPositions
      .map((position) => toNumber(position.iv, Number.NaN))
      .filter((iv) => Number.isFinite(iv));
    const grossDeltaDollars = lattice.nodes.reduce(
      (sum, node) => sum + Math.abs(toNumber(node.deltaDollars)),
      0,
    );
    const netDeltaDollars = lattice.nodes.reduce((sum, node) => sum + toNumber(node.deltaDollars), 0);
    const exposureDenominator = lattice.nodes.length > 0 ? grossDeltaDollars : grossPositionValue;
    const topExposures = lattice.nodes
      .slice()
      .sort((a, b) => Math.abs(nodeExposure(b)) - Math.abs(nodeExposure(a)))
      .slice(0, 8)
      .map((node) => ({
        symbol: node.symbol,
        value: node.value,
        deltaDollars: node.deltaDollars,
        share: safeRatio(Math.abs(nodeExposure(node)), exposureDenominator),
        kind: node.kind,
      }));
    const exposureBySymbol = new Map(
      lattice.nodes.map((node) => [node.symbol, nodeExposure(node)]),
    );
    const exposureFor = (symbol: string) => exposureBySymbol.get(symbol) ?? 0;
    const scenarios = [
      { label: "SPY -3%", move: -0.03, pnl: netDeltaDollars * -0.03 },
      { label: "QQQ -5%", move: -0.05, pnl: netDeltaDollars * -0.05 },
      { label: "NVDA -8%", move: -0.08, pnl: exposureFor("NVDA") * -0.08 },
      { label: "BTC -10%", move: -0.1, pnl: exposureFor("BTC") * -0.1 },
    ];
    const optionsPct = safeRatio(optionValue, baseValue);
    const cashPct = safeRatio(toNumber(snapshot.portfolio.cash), baseValue);
    const flags = buildFlags({
      largestWeight,
      optionsPct,
      nearExpiryCount: nearExpiry.length,
      earliestDays: nearExpiry[0] ?? null,
      cashPct,
      lattice,
    });

    return {
      updatedAt: new Date().toISOString(),
      accountNumber: snapshot.accountNumber,
      grossExposure: exposureDenominator,
      netDeltaDollars,
      cash: toNumber(snapshot.portfolio.cash),
      topExposures,
      scenarios,
      warnings: flags.map((flag) => ({
        title: flag.code
          .split("_")
          .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1))
          .join(" "),
        detail: flag.message,
        severity: warningSeverity(flag.level),
      })),
      portfolio: {
        equity,
        cash: toNumber(snapshot.portfolio.cash),
        invested: toNumber(snapshot.portfolio.invested),
        pnl: toNumber(snapshot.portfolio.pnl),
        pnlPercent: toNumber(snapshot.portfolio.pnlPercent),
        asOf: toNumber(snapshot.portfolio.asOf),
      },
      exposure: {
        grossPositionValue,
        equityValue: snapshot.equities.reduce(
          (sum, position) => sum + Math.abs(toNumber(position.value)),
          0,
        ),
        optionValue,
        cryptoValue: snapshot.crypto.reduce(
          (sum, position) => sum + Math.abs(toNumber(position.value)),
          0,
        ),
        grossDeltaDollars,
        netDeltaDollars,
        cashPct,
        investedPct: safeRatio(toNumber(snapshot.portfolio.invested), baseValue),
        optionsPct,
        betaSpy90Weighted: correlationBeta(lattice),
      },
      concentration: {
        largestWeight,
        herfindahl,
        topPositions: rankedPositions.slice(0, 10),
      },
      options: {
        count: optionPositions.length,
        value: optionValue,
        nearExpiryCount: nearExpiry.length,
        nearExpiryDays: NEAR_EXPIRY_DAYS,
        earliestExpiration:
          optionPositions
            .map((position) => position.expirationDate)
            .filter((date): date is string => Boolean(date))
            .sort()[0] ?? null,
        averageIv: average(ivs),
      },
      correlation: {
        method: lattice.method,
        measuredPct: lattice.measuredPct,
        avgCorrWeighted: lattice.avgCorrWeighted,
        grossExposure: lattice.grossExposure,
        clusters: lattice.clusters.slice(0, 5),
        topEdges: lattice.edges
          .slice()
          .sort((a, b) => b.riskContribution - a.riskContribution)
          .slice(0, 8)
          .map((edge) => ({
            a: edge.a,
            b: edge.b,
            corr: edge.corr,
            source: edge.source,
            observations: edge.observations,
            riskContribution: edge.riskContribution,
          })),
        insight: lattice.insight,
      },
      flags,
    };
  }
}
