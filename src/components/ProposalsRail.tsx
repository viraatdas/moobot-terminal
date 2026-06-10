import { useState } from "react";
import { client, fmtMoney, type TradeProposal } from "../lib/client";

interface Props {
  proposals: TradeProposal[];
  accountNumber: string | null;
  tradeAccountAgentic: boolean;
  onChanged: () => void;
}

export function ProposalsRail({
  proposals,
  accountNumber,
  tradeAccountAgentic,
  onChanged,
}: Props) {
  const pending = proposals.filter((p) => p.status === "pending");
  const settled = proposals.filter((p) => p.status !== "pending").slice(0, 20);

  return (
    <div className="flex min-h-0 flex-col bg-bg">
      <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
        <span className="text-[10px] tracking-[0.16em] uppercase text-ink-faint">
          Trade proposals
        </span>
        {pending.length > 0 && (
          <span className="font-data rounded-sm bg-amber-dim px-1.5 py-0.5 text-[10px] font-semibold text-amber">
            {pending.length}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {pending.length === 0 && (
          <div className="py-5 text-center text-[11.5px] leading-relaxed text-ink-faint">
            No pending proposals.
            <br />
            Research agents file trades here when the evidence is there — nothing executes
            without your approval.
          </div>
        )}
        {pending.map((p) => (
          <ProposalCard
            key={p.id}
            p={p}
            accountNumber={accountNumber}
            onChanged={onChanged}
          />
        ))}

        {settled.length > 0 && (
          <>
            <div className="mt-4 mb-1.5 px-1 text-[10px] tracking-[0.16em] uppercase text-ink-faint">
              History
            </div>
            {settled.map((p) => (
              <div
                key={p.id}
                className="mb-1.5 flex items-center justify-between rounded-sm border border-hairline px-2.5 py-2 opacity-60"
              >
                <span className="font-data text-[11px] text-ink-dim">
                  <span className={p.side === "buy" ? "text-pos" : "text-neg"}>
                    {p.side.toUpperCase()}
                  </span>{" "}
                  {p.quantity} {p.symbol}
                </span>
                <span
                  className={`text-[9.5px] font-semibold tracking-[0.1em] uppercase ${
                    p.status === "approved"
                      ? "text-pos"
                      : p.status === "failed"
                        ? "text-neg"
                        : "text-ink-faint"
                  }`}
                >
                  {p.status}
                </span>
              </div>
            ))}
          </>
        )}
      </div>

      <OrderTicket accountNumber={accountNumber} agentic={tradeAccountAgentic} />
    </div>
  );
}

function ProposalCard({
  p,
  accountNumber,
  onChanged,
}: {
  p: TradeProposal;
  accountNumber: string | null;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(true);

  async function act(action: "approve" | "reject") {
    if (busy) return;
    if (action === "approve") {
      if (!accountNumber) {
        alert("No Robinhood account selected.");
        return;
      }
      const desc = `${p.side.toUpperCase()} ${p.quantity} ${p.symbol} ${
        p.orderType === "limit" ? `@ limit ${fmtMoney(p.limitPrice)}` : "@ market"
      }`;
      if (!confirm(`Place real order?\n\n${desc}\nAccount ${accountNumber}`)) return;
    }
    setBusy(true);
    try {
      await client.request(`proposals.${action}`, { id: p.id, accountNumber });
    } catch (err) {
      alert(String(err));
    }
    setBusy(false);
    onChanged();
  }

  return (
    <div className="mb-2.5 rounded-sm border border-amber/25 bg-panel">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-3 pt-2.5 pb-1 text-left"
      >
        <span className="font-data text-[13px] font-semibold">
          <span className={p.side === "buy" ? "text-pos" : "text-neg"}>
            {p.side.toUpperCase()}
          </span>{" "}
          <span className="text-ink">
            {p.quantity} {p.symbol}
          </span>
        </span>
        <span className="font-data text-[10px] text-ink-faint">
          {p.orderType === "limit" ? `lim ${fmtMoney(p.limitPrice)}` : "mkt"} · conf{" "}
          {p.confidence}/10
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-1">
          <div className="text-[11.5px] leading-relaxed text-ink-dim select-text">{p.thesis}</div>
          <div className="font-data mt-1.5 text-[10px] text-ink-faint">
            from “{p.tabTopic}”{p.timeHorizon ? ` · horizon ${p.timeHorizon}` : ""}
          </div>
        </div>
      )}
      <div className="flex gap-px border-t border-hairline">
        <button
          disabled={busy}
          onClick={() => void act("approve")}
          className="flex-1 py-2 text-[11px] font-semibold tracking-[0.08em] text-pos uppercase hover:bg-pos-dim disabled:opacity-40"
        >
          Approve
        </button>
        <button
          disabled={busy}
          onClick={() => void act("reject")}
          className="flex-1 border-l border-hairline py-2 text-[11px] font-semibold tracking-[0.08em] text-ink-faint uppercase hover:bg-neg-dim hover:text-neg disabled:opacity-40"
        >
          Reject
        </button>
      </div>
    </div>
  );
}

function OrderTicket({
  accountNumber,
  agentic,
}: {
  accountNumber: string | null;
  agentic: boolean;
}) {
  const [symbol, setSymbol] = useState("");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [qty, setQty] = useState("");
  const [type, setType] = useState<"market" | "limit">("market");
  const [limit, setLimit] = useState("");
  const [review, setReview] = useState<unknown>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function buildOrder() {
    return {
      account_number: accountNumber,
      symbol: symbol.trim().toUpperCase(),
      side,
      type,
      quantity: qty,
      time_in_force: "gfd",
      ...(type === "limit" ? { limit_price: limit } : {}),
    };
  }

  const valid =
    accountNumber &&
    symbol.trim() &&
    Number(qty) > 0 &&
    (type === "market" || Number(limit) > 0);

  async function doReview() {
    if (!valid || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await client.request("trade.review", { order: buildOrder() });
      setReview(r);
    } catch (err) {
      setMsg(String(err));
    }
    setBusy(false);
  }

  async function doPlace() {
    if (!valid || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      await client.request("trade.place", { order: buildOrder(), confirmed: true });
      setMsg(`Order placed: ${side.toUpperCase()} ${qty} ${symbol.toUpperCase()}`);
      setReview(null);
      setSymbol("");
      setQty("");
      setLimit("");
    } catch (err) {
      setMsg(String(err));
    }
    setBusy(false);
  }

  const inputCls =
    "font-data rounded-sm border border-hairline bg-bg px-2 py-1.5 text-[12px] text-ink placeholder:text-ink-faint focus:border-amber/50 focus:outline-none w-full";

  return (
    <div className="shrink-0 border-t border-hairline bg-panel p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[10px] tracking-[0.16em] uppercase text-ink-faint">
          Order ticket
        </span>
        {accountNumber && (
          <span className="font-data text-[9.5px] text-ink-faint">
            → {accountNumber}
            {agentic ? " · agentic" : ""}
          </span>
        )}
      </div>
      {!agentic && (
        <div className="mb-2 rounded-sm border border-amber/25 bg-amber-dim px-2 py-1.5 text-[10px] leading-snug text-amber">
          No agentic account found. Robinhood only allows orders from an
          agent-enabled account — enable one in the Robinhood app to trade here.
        </div>
      )}
      <div className="grid grid-cols-[1fr_76px] gap-2">
        <input
          value={symbol}
          onChange={(e) => setSymbol(e.target.value.toUpperCase())}
          placeholder="SYMBOL"
          className={inputCls}
        />
        <input
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          placeholder="QTY"
          className={inputCls}
        />
      </div>
      <div className="mt-2 grid grid-cols-[1fr_1fr_1fr] gap-2">
        <div className="flex overflow-hidden rounded-sm border border-hairline">
          {(["buy", "sell"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSide(s)}
              className={`flex-1 py-1.5 text-[11px] font-semibold uppercase ${
                side === s
                  ? s === "buy"
                    ? "bg-pos-dim text-pos"
                    : "bg-neg-dim text-neg"
                  : "text-ink-faint"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <select
          value={type}
          onChange={(e) => setType(e.target.value as any)}
          className="font-data rounded-sm border border-hairline bg-bg px-1.5 text-[11px] text-ink-dim outline-none"
        >
          <option value="market">market</option>
          <option value="limit">limit</option>
        </select>
        {type === "limit" ? (
          <input
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            placeholder="LIMIT $"
            className={inputCls}
          />
        ) : (
          <div />
        )}
      </div>

      {review != null && (
        <div className="font-data mt-2 max-h-24 overflow-y-auto rounded-sm bg-bg p-2 text-[10px] leading-relaxed whitespace-pre-wrap text-ink-dim select-text">
          {typeof review === "string" ? review : JSON.stringify(review, null, 1)}
        </div>
      )}
      {msg && <div className="mt-2 text-[11px] text-amber select-text">{msg}</div>}

      <div className="mt-2 flex gap-2">
        <button
          disabled={!valid || busy}
          onClick={() => void doReview()}
          className="flex-1 rounded-sm border border-hairline py-1.5 text-[11px] font-semibold text-ink-dim uppercase hover:border-hairline-2 hover:text-ink disabled:opacity-40"
        >
          Review
        </button>
        <button
          disabled={!valid || busy || review == null}
          onClick={() => void doPlace()}
          title={review == null ? "Review first" : ""}
          className="flex-1 rounded-sm border border-amber/40 bg-amber-dim py-1.5 text-[11px] font-semibold text-amber uppercase hover:bg-amber/25 disabled:opacity-40"
        >
          Place
        </button>
      </div>
    </div>
  );
}
