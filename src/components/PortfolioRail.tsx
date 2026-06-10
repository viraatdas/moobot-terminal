import { useState } from "react";
import { client, fmtMoney } from "../lib/client";

interface Props {
  portfolio: any;
  positions: any[];
  rhAuthed: boolean;
}

function num(...candidates: unknown[]): number | null {
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: "pos" | "neg" }) {
  return (
    <div>
      <div className="text-[10px] tracking-[0.16em] uppercase text-ink-faint">{label}</div>
      <div
        className={`font-data mt-0.5 text-[15px] font-semibold ${
          accent === "pos" ? "text-pos" : accent === "neg" ? "text-neg" : "text-ink"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

export function PortfolioRail({ portfolio, positions, rhAuthed }: Props) {
  const [query, setQuery] = useState("");
  const [quote, setQuote] = useState<any>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);

  const totalValue = num(
    portfolio?.total_market_value,
    portfolio?.market_value,
    portfolio?.total_value,
    portfolio?.equity,
    portfolio?.portfolio_value,
  );
  const buyingPower = num(
    portfolio?.buying_power,
    portfolio?.cash?.buying_power,
    portfolio?.cash_balance,
    portfolio?.cash,
  );

  async function lookup() {
    const sym = query.trim().toUpperCase();
    if (!sym) return;
    setQuoteErr(null);
    try {
      const res = await client.request("rh.call", {
        tool: "get_equity_quotes",
        args: { symbols: [sym] },
      });
      const q = Array.isArray(res) ? res[0] : (res?.quotes?.[0] ?? res?.results?.[0] ?? res);
      setQuote({ symbol: sym, raw: q });
    } catch (err) {
      setQuote(null);
      setQuoteErr(String(err));
    }
  }

  return (
    <div className="flex min-h-0 flex-col bg-bg">
      <div className="grid grid-cols-2 gap-4 border-b border-hairline p-4">
        <Stat label="Portfolio" value={totalValue !== null ? fmtMoney(totalValue) : "—"} />
        <Stat label="Buying Power" value={buyingPower !== null ? fmtMoney(buyingPower) : "—"} />
      </div>

      <div className="border-b border-hairline p-3">
        <div className="flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void lookup()}
            placeholder="Quote: AAPL"
            className="font-data w-full rounded-sm border border-hairline bg-panel px-2.5 py-1.5 text-[12px] text-ink placeholder:text-ink-faint focus:border-amber/50 focus:outline-none"
          />
          <button
            onClick={() => void lookup()}
            className="rounded-sm border border-hairline bg-panel px-3 text-[11px] font-medium text-ink-dim hover:border-hairline-2 hover:text-ink"
          >
            Go
          </button>
        </div>
        {quote && (
          <div className="font-data mt-2 rounded-sm bg-panel p-2.5 text-[11px] leading-relaxed text-ink-dim">
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-[13px] font-semibold text-ink">{quote.symbol}</span>
              <span className="text-[13px] font-semibold text-amber">
                {fmtMoney(
                  num(
                    quote.raw?.last_trade_price,
                    quote.raw?.price,
                    quote.raw?.last_price,
                    quote.raw?.mark_price,
                  ),
                )}
              </span>
            </div>
            <div className="flex justify-between">
              <span>
                bid {fmtMoney(num(quote.raw?.bid_price, quote.raw?.bid))}
              </span>
              <span>
                ask {fmtMoney(num(quote.raw?.ask_price, quote.raw?.ask))}
              </span>
            </div>
          </div>
        )}
        {quoteErr && <div className="mt-2 text-[11px] text-neg">{quoteErr}</div>}
      </div>

      <div className="flex items-center justify-between px-4 pt-3 pb-1.5">
        <span className="text-[10px] tracking-[0.16em] uppercase text-ink-faint">Positions</span>
        <span className="font-data text-[10px] text-ink-faint">{positions.length}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {!rhAuthed && (
          <div className="px-2 py-6 text-center text-[12px] text-ink-faint">
            Connect Robinhood to load your book.
          </div>
        )}
        {rhAuthed && positions.length === 0 && (
          <div className="px-2 py-6 text-center text-[12px] text-ink-faint">No open positions.</div>
        )}
        {positions.map((p, i) => {
          const sym = String(p?.symbol ?? p?.ticker ?? p?.instrument_symbol ?? "?");
          const qty = num(p?.quantity, p?.shares, p?.position_quantity);
          const mv = num(p?.market_value, p?.equity, p?.value);
          const pnl = num(
            p?.unrealized_pnl,
            p?.total_return,
            p?.unrealized_gain,
            p?.todays_return,
          );
          return (
            <div
              key={`${sym}-${i}`}
              className="flex items-center justify-between rounded-sm px-2 py-2 hover:bg-panel"
            >
              <div>
                <div className="font-data text-[12.5px] font-semibold text-ink">{sym}</div>
                <div className="font-data text-[10px] text-ink-faint">
                  {qty !== null ? `${qty} sh` : ""}
                </div>
              </div>
              <div className="text-right">
                <div className="font-data text-[12.5px] text-ink">
                  {mv !== null ? fmtMoney(mv) : "—"}
                </div>
                {pnl !== null && (
                  <div
                    className={`font-data text-[10px] ${pnl >= 0 ? "text-pos" : "text-neg"}`}
                  >
                    {pnl >= 0 ? "+" : ""}
                    {fmtMoney(pnl)}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
