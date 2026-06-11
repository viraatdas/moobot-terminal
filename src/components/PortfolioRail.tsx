import { useState } from "react";
import { Zap } from "lucide-react";
import { fmtMoney, fmtPct, type AccountSnapshot, type Position } from "../lib/client";
import { ChainViewer } from "./ChainViewer";

interface Props {
  snapshot: AccountSnapshot | null;
  robinhoodConnected: boolean;
  agenticBuyingPower: number | null;
  onConnect: () => void;
}

export function PortfolioRail({
  snapshot,
  robinhoodConnected,
  agenticBuyingPower,
  onConnect,
}: Props) {
  const [chainSymbol, setChainSymbol] = useState<string | null>(null);

  const pf = snapshot?.portfolio;
  const asOf = pf?.asOf ? new Date(pf.asOf) : null;
  const stale = asOf ? Date.now() - asOf.getTime() > 45_000 : false;

  return (
    <div className="flex min-h-0 flex-col bg-bg">
      {/* header: account value + day P&L */}
      <div className="border-b border-hairline p-4">
        <div className="text-[10px] tracking-[0.16em] uppercase text-ink-faint">
          Account value
        </div>
        <div className="font-data mt-0.5 text-[22px] font-semibold text-ink">
          {pf ? fmtMoney(pf.equity) : "—"}
        </div>
        {pf && (
          <div
            className={`font-data mt-0.5 text-[12px] ${
              pf.pnl >= 0 ? "text-pos" : "text-neg"
            }`}
          >
            {pf.pnl >= 0 ? "▲" : "▼"} {fmtMoney(Math.abs(pf.pnl))} ({fmtPct(pf.pnlPercent)}){" "}
            {pf.pnlLabel ?? "unrealized"}
          </div>
        )}
        {asOf && (
          <div className="mt-1 flex items-center gap-1.5 text-[9.5px] tracking-[0.12em] text-ink-faint uppercase">
            <span className={`h-1.5 w-1.5 rounded-full ${stale ? "bg-amber" : "bg-pos live-ping"}`} />
            <span className="font-data">
              MCP quotes · {asOf.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </span>
          </div>
        )}
        <div className="mt-2 flex items-center gap-4 text-[10px] text-ink-faint">
          {pf && <span className="font-data">cash {fmtMoney(pf.cash)}</span>}
          {agenticBuyingPower !== null && (
            <span className="font-data" title="Buying power on the agentic trading account">
              tradeable {fmtMoney(agenticBuyingPower)}
            </span>
          )}
          <div className="flex-1" />
          <button
            onClick={() => setChainSymbol("")}
            className="flex items-center gap-1 rounded-sm border border-hairline px-2 py-0.5 text-[10px] text-ink-dim hover:border-amber/50 hover:text-amber"
          >
            <Zap className="h-3 w-3" />
            Options chain
          </button>
        </div>
      </div>

      {/* connect state */}
      {!robinhoodConnected && (
        <div className="border-b border-hairline bg-amber-dim/40 p-3">
          <div className="text-[11px] leading-snug text-amber">
            Connect Robinhood MCP to view your accounts, positions, balances, and options.
          </div>
          <button
            onClick={onConnect}
            className="mt-2 rounded-sm border border-amber/40 bg-amber-dim px-3 py-1 text-[11px] font-semibold text-amber hover:bg-amber/25"
          >
            Connect Robinhood
          </button>
        </div>
      )}

      {chainSymbol !== null && (
        <ChainViewer
          initialSymbol={chainSymbol || undefined}
          onClose={() => setChainSymbol(null)}
        />
      )}

      {/* positions */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {snapshot && (
          <>
            <Section title="Stocks" positions={snapshot.equities} />
            <Section
              title="Options"
              positions={snapshot.options}
              onOpenChain={(sym) => setChainSymbol(sym)}
            />
            <Section title="Crypto" positions={snapshot.crypto} />
            {snapshot.equities.length === 0 &&
              snapshot.options.length === 0 &&
              snapshot.crypto.length === 0 && (
                <div className="px-4 py-6 text-center text-[12px] text-ink-faint">
                  No open positions in this account.
                </div>
              )}
          </>
        )}
        {!snapshot && robinhoodConnected && (
          <div className="px-4 py-6 text-center text-[12px] text-ink-faint">Loading positions…</div>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  positions,
  onOpenChain,
}: {
  title: string;
  positions: Position[];
  onOpenChain?: (symbol: string) => void;
}) {
  if (positions.length === 0) return null;
  const total = positions.reduce((s, p) => s + p.value, 0);
  return (
    <div className="border-b border-hairline">
      <div className="flex items-center justify-between px-4 pt-3 pb-1.5">
        <span className="text-[10px] tracking-[0.16em] uppercase text-ink-faint">{title}</span>
        <span className="font-data text-[10px] text-ink-faint">{fmtMoney(total)}</span>
      </div>
      <div className="px-2 pb-2">
        {positions.map((p, i) => (
          <PositionRow key={`${p.symbol}-${i}`} p={p} onOpenChain={onOpenChain} />
        ))}
      </div>
    </div>
  );
}

function PositionRow({ p, onOpenChain }: { p: Position; onOpenChain?: (symbol: string) => void }) {
  const label =
    p.kind === "option"
      ? `${p.symbol} ${p.side?.toUpperCase()}${p.strike != null ? ` ${p.strike}` : ""}`
      : p.symbol;
  const sub =
    p.kind === "option"
      ? `${p.quantity} · ${p.expirationDate ?? ""}${
          p.daysToExpiry != null ? ` · ${p.daysToExpiry}d` : ""
        }`
      : p.kind === "crypto" && p.quantity === 0
        ? "value from Robinhood MCP portfolio"
        : `${p.quantity} ${p.kind === "crypto" ? "" : "sh"} @ ${fmtMoney(p.averagePrice)}`;
  return (
    <div
      onClick={() => onOpenChain?.(p.symbol)}
      className={`flex items-center justify-between rounded-sm px-2 py-1.5 hover:bg-panel ${
        onOpenChain ? "cursor-pointer" : ""
      }`}
    >
      <div className="min-w-0">
        <div className="font-data truncate text-[12px] font-semibold text-ink">{label}</div>
        <div className="font-data truncate text-[9.5px] text-ink-faint">{sub}</div>
      </div>
      <div className="ml-2 text-right">
        <div className="font-data text-[12px] text-ink">{fmtMoney(p.value)}</div>
        <div className={`font-data text-[9.5px] ${p.unrealizedPnl >= 0 ? "text-pos" : "text-neg"}`}>
          {p.unrealizedPnl >= 0 ? "+" : ""}
          {fmtMoney(p.unrealizedPnl)} ({fmtPct(p.unrealizedPnlPercent)})
        </div>
      </div>
    </div>
  );
}
