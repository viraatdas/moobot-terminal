import { useEffect, useState } from "react";
import { client, type TradeProposal } from "../lib/client";

interface Toast {
  id: number;
  kind: "alert" | "proposal";
  title: string;
  detail: string;
}

let seq = 0;

export function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  function push(t: Omit<Toast, "id">) {
    const id = seq++;
    setToasts((ts) => [{ id, ...t }, ...ts].slice(0, 4));
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 7000);
  }

  useEffect(() => {
    let known = new Set<string>();
    let primed = false;
    const off = client.onEvent((event, payload) => {
      if (event === "alert.triggered") {
        const a = payload.alert;
        push({
          kind: "alert",
          title: `${a.symbol} ${a.op} ${a.price}`,
          detail: a.lastPrice != null ? `now ${Number(a.lastPrice).toFixed(2)}` : "",
        });
      }
      if (event === "proposals.changed") {
        const pending: TradeProposal[] = (payload.proposals ?? []).filter(
          (p: TradeProposal) => p.status === "pending",
        );
        const ids = new Set(pending.map((p) => p.id));
        if (primed) {
          for (const p of pending) {
            if (!known.has(p.id)) {
              push({
                kind: "proposal",
                title: `${p.side.toUpperCase()} ${p.quantity} ${p.symbol}`,
                detail: `proposal from "${p.tabTopic}" · conf ${p.confidence}/10`,
              });
            }
          }
        }
        known = ids;
        primed = true;
      }
    });
    return off;
  }, []);

  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast-in pointer-events-auto w-72 rounded-md border bg-panel p-3 shadow-xl ${
            t.kind === "proposal" ? "border-amber/40" : "border-hairline-2"
          }`}
        >
          <div className="flex items-center gap-2">
            <span className={t.kind === "proposal" ? "text-amber" : "text-pos"}>
              {t.kind === "proposal" ? "▲" : "⏰"}
            </span>
            <span className="font-data text-[12px] font-semibold text-ink">{t.title}</span>
          </div>
          {t.detail && <div className="mt-1 text-[11px] text-ink-dim">{t.detail}</div>}
        </div>
      ))}
    </div>
  );
}
