import { useState } from "react";
import {
  client,
  fmtMoney,
  fmtPct,
  type AccountSnapshot,
  type Position,
  type RestStatus,
} from "../lib/client";

interface Props {
  snapshot: AccountSnapshot | null;
  restStatus: RestStatus;
  agenticBuyingPower: number | null;
  onConnected: () => void;
}

const CONSOLE_SNIPPET =
  "copy(JSON.parse(localStorage.getItem('web:auth_state')||'{}').access_token)";

export function PortfolioRail({
  snapshot,
  restStatus,
  agenticBuyingPower,
  onConnected,
}: Props) {
  const [showConnect, setShowConnect] = useState(false);

  const pf = snapshot?.portfolio;
  const needsToken = !restStatus.hasToken;
  const expired = restStatus.expired;

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
            {pf.pnl >= 0 ? "▲" : "▼"} {fmtMoney(Math.abs(pf.pnl))} ({fmtPct(pf.pnlPercent)}) today
          </div>
        )}
        <div className="mt-2 flex gap-4 text-[10px] text-ink-faint">
          {pf && <span className="font-data">cash {fmtMoney(pf.cash)}</span>}
          {agenticBuyingPower !== null && (
            <span className="font-data" title="Buying power on the agentic trading account">
              tradeable {fmtMoney(agenticBuyingPower)}
            </span>
          )}
        </div>
      </div>

      {/* connect / reconnect states */}
      {(needsToken || expired) && (
        <div className="border-b border-hairline bg-amber-dim/40 p-3">
          <div className="text-[11px] leading-snug text-amber">
            {expired
              ? "Robinhood session expired — reconnect to refresh positions."
              : "Connect your full Robinhood account to see all positions, options, and crypto."}
          </div>
          <button
            onClick={() => setShowConnect(true)}
            className="mt-2 rounded-sm border border-amber/40 bg-amber-dim px-3 py-1 text-[11px] font-semibold text-amber hover:bg-amber/25"
          >
            {expired ? "Reconnect" : "Connect full account"}
          </button>
        </div>
      )}

      {showConnect && (
        <ConnectModal
          onClose={() => setShowConnect(false)}
          onConnected={() => {
            setShowConnect(false);
            onConnected();
          }}
        />
      )}

      {/* positions */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {snapshot && (
          <>
            <Section title="Stocks" positions={snapshot.equities} />
            <Section title="Options" positions={snapshot.options} />
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
        {!snapshot && !needsToken && !expired && (
          <div className="px-4 py-6 text-center text-[12px] text-ink-faint">Loading positions…</div>
        )}
      </div>
    </div>
  );
}

function Section({ title, positions }: { title: string; positions: Position[] }) {
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
          <PositionRow key={`${p.symbol}-${i}`} p={p} />
        ))}
      </div>
    </div>
  );
}

function PositionRow({ p }: { p: Position }) {
  const label =
    p.kind === "option"
      ? `${p.symbol} ${p.side?.toUpperCase()}${p.strike != null ? ` ${p.strike}` : ""}`
      : p.symbol;
  const sub =
    p.kind === "option"
      ? `${p.quantity} · ${p.expirationDate ?? ""}${
          p.daysToExpiry != null ? ` · ${p.daysToExpiry}d` : ""
        }`
      : `${p.quantity} ${p.kind === "crypto" ? "" : "sh"} @ ${fmtMoney(p.averagePrice)}`;
  return (
    <div className="flex items-center justify-between rounded-sm px-2 py-1.5 hover:bg-panel">
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

function ConnectModal({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected: () => void;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function connect() {
    if (!token.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await client.request("rhrest.setToken", { token: token.trim() });
      onConnected();
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div className="w-full max-w-lg rounded-md border border-hairline-2 bg-panel p-5">
        <div className="font-wordmark text-[18px] italic text-ink">Connect full account</div>
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-dim">
          The official agent connection can't list options or crypto holdings. To see
          everything, paste a token from your logged-in Robinhood web session.
        </p>
        <ol className="mt-3 space-y-1.5 text-[12px] text-ink-dim">
          <li>
            1. Open <span className="text-ink">robinhood.com</span> (logged in) and open the
            browser console (⌥⌘I).
          </li>
          <li>2. Paste and run this — it copies your token to the clipboard:</li>
        </ol>
        <code className="mt-2 block rounded-sm bg-bg px-3 py-2 font-data text-[10.5px] break-all text-amber select-all">
          {CONSOLE_SNIPPET}
        </code>
        <textarea
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Paste the token (or the full web:auth_state JSON for auto-refresh)"
          rows={3}
          className="mt-3 w-full resize-none rounded-sm border border-hairline bg-bg px-3 py-2 font-data text-[11px] text-ink placeholder:text-ink-faint focus:border-amber/50 focus:outline-none"
        />
        {err && <div className="mt-2 text-[11px] text-neg break-words">{err}</div>}
        <div className="mt-3 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-sm px-3 py-1.5 text-[12px] text-ink-faint hover:text-ink"
          >
            Cancel
          </button>
          <button
            onClick={() => void connect()}
            disabled={!token.trim() || busy}
            className="rounded-sm border border-amber/40 bg-amber-dim px-4 py-1.5 text-[12px] font-semibold text-amber hover:bg-amber/25 disabled:opacity-40"
          >
            {busy ? "Connecting…" : "Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}
