import { useEffect, useState } from "react";
import { client, type OptionContract } from "../lib/client";

export function ChainViewer({
  initialSymbol,
  onClose,
}: {
  initialSymbol?: string;
  onClose: () => void;
}) {
  const [symbol, setSymbol] = useState(initialSymbol ?? "");
  const [query, setQuery] = useState(initialSymbol ?? "");
  const [expirations, setExpirations] = useState<string[]>([]);
  const [expiration, setExpiration] = useState<string | null>(null);
  const [contracts, setContracts] = useState<OptionContract[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function loadExpirations(sym: string) {
    if (!sym.trim()) return;
    setBusy(true);
    setErr(null);
    setContracts([]);
    setExpiration(null);
    try {
      const res = await client.request("options.chain", { symbol: sym.trim().toUpperCase() });
      setSymbol(sym.trim().toUpperCase());
      setExpirations(res.expirations ?? []);
      if (res.expirations?.length) void loadChain(sym.trim().toUpperCase(), res.expirations[0]);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function loadChain(sym: string, exp: string) {
    setBusy(true);
    setErr(null);
    setExpiration(exp);
    try {
      const res = await client.request("options.chain", { symbol: sym, expiration: exp });
      setContracts(res.contracts ?? []);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (initialSymbol) void loadExpirations(initialSymbol);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Group by strike for a calls | strike | puts ladder.
  const byStrike = new Map<number, { call?: OptionContract; put?: OptionContract }>();
  for (const c of contracts) {
    const row = byStrike.get(c.strike) ?? {};
    if (c.optionType === "call") row.call = c;
    else row.put = c;
    byStrike.set(c.strike, row);
  }
  const strikes = [...byStrike.keys()].sort((a, b) => a - b);

  const cell = (c: OptionContract | undefined) =>
    c ? (
      <>
        <td className="px-2 text-right text-ink">{c.mark != null ? c.mark.toFixed(2) : "—"}</td>
        <td className="px-2 text-right text-ink-dim">
          {c.delta != null ? c.delta.toFixed(2) : "—"}
        </td>
        <td className="px-2 text-right text-ink-dim">
          {c.iv != null ? `${(c.iv * 100).toFixed(0)}%` : "—"}
        </td>
        <td className="px-2 text-right text-ink-faint">{c.openInterest ?? "—"}</td>
      </>
    ) : (
      <>
        <td className="px-2 text-right text-ink-faint">—</td>
        <td className="px-2 text-right text-ink-faint">—</td>
        <td className="px-2 text-right text-ink-faint">—</td>
        <td className="px-2 text-right text-ink-faint">—</td>
      </>
    );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-md border border-hairline-2 bg-panel">
        <div className="flex items-center gap-3 border-b border-hairline px-4 py-3">
          <span className="font-wordmark text-[17px] italic text-ink">options chain</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && void loadExpirations(query)}
            placeholder="SYMBOL"
            className="font-data w-28 rounded-sm border border-hairline bg-bg px-2 py-1 text-[12px] text-ink placeholder:text-ink-faint focus:border-amber/50 focus:outline-none"
          />
          <button
            onClick={() => void loadExpirations(query)}
            className="rounded-sm border border-hairline px-3 py-1 text-[11px] text-ink-dim hover:border-amber/50 hover:text-amber"
          >
            Load
          </button>
          <div className="flex-1" />
          <button onClick={onClose} className="text-[16px] text-ink-faint hover:text-ink">
            ✕
          </button>
        </div>

        {expirations.length > 0 && (
          <div className="flex gap-1 overflow-x-auto border-b border-hairline px-4 py-2">
            {expirations.slice(0, 18).map((e) => (
              <button
                key={e}
                onClick={() => void loadChain(symbol, e)}
                className={`font-data shrink-0 rounded-sm px-2 py-0.5 text-[10px] ${
                  expiration === e
                    ? "bg-amber-dim text-amber"
                    : "text-ink-faint hover:text-ink-dim"
                }`}
              >
                {e}
              </button>
            ))}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {err && <div className="p-4 text-[12px] text-neg break-words">{err}</div>}
          {busy && <div className="p-4 text-[12px] text-ink-faint">Loading…</div>}
          {!busy && strikes.length > 0 && (
            <table className="font-data w-full text-[11px]">
              <thead className="sticky top-0 bg-panel text-[9px] uppercase tracking-wider text-ink-faint">
                <tr className="border-b border-hairline">
                  <th colSpan={4} className="py-1 text-center text-pos">
                    Calls
                  </th>
                  <th className="px-2 text-center">Strike</th>
                  <th colSpan={4} className="py-1 text-center text-neg">
                    Puts
                  </th>
                </tr>
                <tr className="border-b border-hairline text-ink-faint">
                  <th className="px-2 text-right">mark</th>
                  <th className="px-2 text-right">Δ</th>
                  <th className="px-2 text-right">IV</th>
                  <th className="px-2 text-right">OI</th>
                  <th className="px-2"></th>
                  <th className="px-2 text-right">mark</th>
                  <th className="px-2 text-right">Δ</th>
                  <th className="px-2 text-right">IV</th>
                  <th className="px-2 text-right">OI</th>
                </tr>
              </thead>
              <tbody>
                {strikes.map((s) => {
                  const row = byStrike.get(s)!;
                  return (
                    <tr key={s} className="border-b border-hairline/50 hover:bg-bg">
                      {cell(row.call)}
                      <td className="px-2 text-center font-semibold text-amber">{s}</td>
                      {cell(row.put)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {!busy && !err && strikes.length === 0 && symbol && (
            <div className="p-4 text-center text-[12px] text-ink-faint">
              {expirations.length === 0
                ? "No chain found (connect your full account first)."
                : "Pick an expiration."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
