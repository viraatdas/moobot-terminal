import { useEffect, useState } from "react";
import { client } from "../lib/client";

interface Alert {
  id: string;
  symbol: string;
  op: "above" | "below";
  price: number;
  note: string;
  enabled: boolean;
  lastPrice: number | null;
  triggeredAt: string | null;
}

export function AlertsModal({
  initialSymbol,
  onClose,
}: {
  initialSymbol?: string | null;
  onClose: () => void;
}) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [symbol, setSymbol] = useState("");
  const [op, setOp] = useState<"above" | "below">("above");
  const [price, setPrice] = useState("");
  const [note, setNote] = useState("");

  const refresh = async () => {
    try {
      setAlerts(await client.request("alerts.list"));
    } catch {}
  };

  useEffect(() => {
    void refresh();
    const off = client.onEvent((event) => {
      if (event === "alert.triggered") void refresh();
    });
    return off;
  }, []);

  useEffect(() => {
    const clean = initialSymbol?.replace(/^\$/, "").trim().toUpperCase();
    if (clean) setSymbol(clean);
  }, [initialSymbol]);

  async function add() {
    if (!symbol.trim() || !(Number(price) > 0)) return;
    await client.request("alerts.create", {
      symbol: symbol.trim().toUpperCase(),
      op,
      price: Number(price),
      note: note.trim(),
    });
    setSymbol("");
    setPrice("");
    setNote("");
    void refresh();
  }

  const inputCls =
    "font-data rounded-sm border border-hairline bg-bg px-2 py-1.5 text-[12px] text-ink placeholder:text-ink-faint focus:border-amber/50 focus:outline-none";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div className="flex max-h-[80vh] w-full max-w-md flex-col rounded-md border border-hairline-2 bg-panel">
        <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
          <span className="font-wordmark text-[17px] italic text-ink">price alerts</span>
          <button onClick={onClose} className="text-[16px] text-ink-faint hover:text-ink">
            ✕
          </button>
        </div>

        <div className="border-b border-hairline p-3">
          <div className="grid grid-cols-[1fr_88px_1fr] gap-2">
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              placeholder="SYMBOL"
              className={inputCls}
            />
            <select
              value={op}
              onChange={(e) => setOp(e.target.value as "above" | "below")}
              className="font-data rounded-sm border border-hairline bg-bg px-1.5 text-[11px] text-ink-dim outline-none"
            >
              <option value="above">above</option>
              <option value="below">below</option>
            </select>
            <input
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void add()}
              placeholder="PRICE"
              className={inputCls}
            />
          </div>
          <div className="mt-2 flex gap-2">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="note (optional)"
              className={`${inputCls} flex-1`}
            />
            <button
              onClick={() => void add()}
              disabled={!symbol.trim() || !(Number(price) > 0)}
              className="rounded-sm border border-amber/40 bg-amber-dim px-4 text-[12px] font-semibold text-amber hover:bg-amber/25 disabled:opacity-40"
            >
              Add
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {alerts.length === 0 && (
            <div className="py-6 text-center text-[12px] text-ink-faint">
              No alerts. Get a native notification when a price crosses your level.
            </div>
          )}
          {alerts.map((a) => (
            <div
              key={a.id}
              className="flex items-center justify-between rounded-sm px-2 py-2 hover:bg-bg"
            >
              <div className="min-w-0">
                <div className="font-data text-[12px] text-ink">
                  {a.symbol} {a.op} {a.price}
                  {a.triggeredAt && <span className="ml-2 text-[9.5px] text-amber">triggered</span>}
                </div>
                <div className="font-data text-[9.5px] text-ink-faint">
                  {a.lastPrice != null ? `last ${a.lastPrice.toFixed(2)}` : "watching…"}
                  {a.note ? ` · ${a.note}` : ""}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={async () => {
                    await client.request("alerts.update", { id: a.id, enabled: !a.enabled });
                    void refresh();
                  }}
                  className="rounded-sm border border-hairline px-2 py-0.5 text-[10px] text-ink-dim hover:text-ink"
                >
                  {a.enabled ? (a.triggeredAt ? "re-arm" : "pause") : "enable"}
                </button>
                <button
                  onClick={async () => {
                    await client.request("alerts.remove", { id: a.id });
                    void refresh();
                  }}
                  className="rounded-sm border border-hairline px-2 py-0.5 text-[10px] text-ink-faint hover:border-neg/50 hover:text-neg"
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
