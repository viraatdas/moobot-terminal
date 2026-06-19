import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Link2, Loader2, RefreshCw, ShieldAlert, X } from "lucide-react";
import { client } from "../lib/client";

type Venue = "kalshi" | "polymarket" | "hyperliquid";

const CHECK_REQUEST: Record<Venue, string> = {
  kalshi: "venue.kalshi.portfolio",
  polymarket: "venue.polymarket.account",
  hyperliquid: "venue.hyperliquid.account",
};

interface Field {
  name: string;
  label: string;
  type: "text" | "password" | "textarea" | "select";
  placeholder?: string;
  options?: string[];
}

interface VenueMeta {
  key: Venue;
  label: string;
  blurb: string;
  obtain: string;
  fields: Field[];
}

// Drives both the form and the help text. NOTE: secrets are POSTed to the local
// sidecar (127.0.0.1), written 0600 server-side, and NEVER echoed back. The panel
// only ever shows the redacted status.
const VENUES: VenueMeta[] = [
  {
    key: "kalshi",
    label: "Kalshi",
    blurb: "US-regulated event contracts. Trade with an API Key ID + RSA private key.",
    obtain: "kalshi.com > Account > API Keys > Create. The RSA private key is shown once. Paste it here. Use the demo env (demo.kalshi.co) first.",
    fields: [
      { name: "env", label: "Environment", type: "select", options: ["demo", "prod"] },
      { name: "keyId", label: "API Key ID", type: "text", placeholder: "UUID from your Kalshi API Keys page" },
      { name: "privateKeyPem", label: "RSA private key (PEM)", type: "textarea", placeholder: "-----BEGIN RSA PRIVATE KEY-----\n..." },
    ],
  },
  {
    key: "hyperliquid",
    label: "Hyperliquid",
    blurb: "Perps DEX. Use an AGENT (API) wallet key. It can trade but never withdraw.",
    obtain: "app.hyperliquid.xyz/API → approve an agent wallet (sign with your master wallet). Paste the agent key + your master 0x address. Start on testnet.",
    fields: [
      { name: "network", label: "Network", type: "select", options: ["testnet", "mainnet"] },
      { name: "accountAddress", label: "Master account address", type: "text", placeholder: "0x... (your main wallet)" },
      { name: "agentPrivateKey", label: "Agent wallet private key", type: "password", placeholder: "0x... (64 hex)" },
    ],
  },
  {
    key: "polymarket",
    label: "Polymarket",
    blurb: "Polygon prediction markets. Use a DEDICATED bot wallet, not your personal one.",
    obtain: "Generate a fresh Polygon EOA (e.g. `cast wallet new`), fund pUSD/POL, and paste its private key. CLOB API creds are derived in-code.",
    fields: [
      { name: "privateKey", label: "Polygon wallet private key", type: "password", placeholder: "0x... (64 hex)" },
      { name: "funder", label: "Funder address (optional)", type: "text", placeholder: "0x... proxy/funder, if used" },
    ],
  },
];

export function ConnectionsModal({ onClose, paperMode }: { onClose: () => void; paperMode: boolean }) {
  const [status, setStatus] = useState<Record<string, any> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(() => {
    client
      .request<Record<string, any>>("connections.status")
      .then((s) => {
        setStatus(s);
        setErr(null);
      })
      .catch((e) => setErr(String(e?.message ?? e)));
  }, []);

  useEffect(() => refresh(), [refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/55 px-4" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-[580px] max-w-full flex-col rounded-sm border border-hairline bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
          <div className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-amber" />
            <span className="text-[11px] font-semibold tracking-[0.16em] text-ink uppercase">Market connections</span>
          </div>
          <button onClick={onClose} className="text-ink-faint hover:text-ink">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <p className="text-[11px] leading-snug text-ink-faint">
            Keys are stored locally (owner-only files), never shown again, and never leave this Mac. Every order still
            routes through your approval + paper-mode gate.
          </p>
          {!status && <div className="py-6 text-center text-[12px] text-ink-faint">Loading...</div>}
          {status &&
            VENUES.map((v) => (
              <VenueCard
                key={v.key}
                meta={v}
                s={status[v.key]}
                paperMode={paperMode}
                onChanged={setStatus}
                onError={setErr}
              />
            ))}
          {err && <div className="rounded-sm border border-neg/40 bg-neg-dim px-3 py-2 text-[11px] text-neg">{err}</div>}
        </div>
      </div>
    </div>
  );
}

function VenueCard({
  meta,
  s,
  paperMode,
  onChanged,
  onError,
}: {
  meta: VenueMeta;
  s: any;
  paperMode: boolean;
  onChanged: (status: Record<string, any>) => void;
  onError: (msg: string | null) => void;
}) {
  const connected = !!s?.hasStoredKey;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);
  const [form, setForm] = useState<Record<string, string>>(() =>
    Object.fromEntries(meta.fields.map((f) => [f.name, f.type === "select" ? (f.options?.[0] ?? "") : ""])),
  );

  const identity = s?.keyIdMasked ?? s?.addressMasked ?? s?.funderMasked ?? null;
  const mode = s?.env ?? s?.network ?? null;

  const act = useCallback(
    (type: string, payload: any) => {
      setBusy(true);
      onError(null);
      client
        .request<Record<string, any>>(type, payload)
        .then((st) => {
          onChanged(st);
          return st;
        })
        .catch((e) => onError(String(e?.message ?? e)))
        .finally(() => setBusy(false));
    },
    [onChanged, onError],
  );

  const connect = () => {
    act("connections.saveKey", { venue: meta.key, payload: form });
    // Clear secrets out of React state immediately after sending.
    setForm((f) => Object.fromEntries(Object.keys(f).map((k) => [k, k === "env" || k === "network" ? f[k] : ""])));
    setOpen(false);
  };

  const testRead = () => {
    setBusy(true);
    onError(null);
    setCheck(null);
    client
      .request<any>(CHECK_REQUEST[meta.key])
      .then((data) => setCheck({ ok: true, text: summarizeRead(meta.key, data) }))
      .catch((e) => setCheck({ ok: false, text: String(e?.message ?? e) }))
      .finally(() => setBusy(false));
  };

  const armDisabledReason = useMemo(() => {
    if (!connected) return "Connect a key first";
    if (paperMode) return "Turn off Paper mode to arm live trading";
    return null;
  }, [connected, paperMode]);

  return (
    <div className="rounded-sm border border-hairline bg-bg">
      <div className="flex items-start justify-between gap-3 px-3 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-semibold text-ink">{meta.label}</span>
            {connected ? (
              <span className="flex items-center gap-1 rounded-sm border border-pos/40 bg-pos-dim px-1.5 py-0.5 text-[9px] font-semibold tracking-[0.1em] text-pos uppercase">
                <Check className="h-2.5 w-2.5" /> Connected
              </span>
            ) : (
              <span className="rounded-sm border border-hairline px-1.5 py-0.5 text-[9px] font-semibold tracking-[0.1em] text-ink-faint uppercase">
                Not connected
              </span>
            )}
            {connected && mode && (
              <span className="font-data text-[9px] tracking-[0.1em] text-ink-faint uppercase">{mode}</span>
            )}
            {connected && s?.trading && (
              <span className="rounded-sm border border-neg/50 bg-neg-dim px-1.5 py-0.5 text-[9px] font-semibold tracking-[0.1em] text-neg uppercase">
                live $
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[11px] leading-snug text-ink-faint">{meta.blurb}</div>
          {connected && identity && (
            <div className="font-data mt-0.5 text-[10px] text-ink-faint">key {identity}</div>
          )}
          {check && (
            <div className={`font-data mt-1 text-[10px] ${check.ok ? "text-pos" : "text-neg"}`}>
              {check.ok ? "read ok" : "read failed"} · {check.text}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {connected ? (
            <>
              <button
                onClick={testRead}
                disabled={busy}
                className="flex items-center gap-1 rounded-sm border border-hairline px-2 py-1 text-[10px] font-semibold text-ink-dim uppercase hover:border-amber/40 hover:text-amber disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                Test
              </button>
              <button
                onClick={() => act("connections.clearKey", { venue: meta.key })}
                disabled={busy}
                className="rounded-sm border border-hairline px-2 py-1 text-[10px] font-semibold text-ink-dim uppercase hover:border-neg/40 hover:text-neg disabled:opacity-50"
              >
                Disconnect
              </button>
            </>
          ) : (
            <button
              onClick={() => setOpen((o) => !o)}
              className="rounded-sm border border-amber/40 bg-amber-dim px-2 py-1 text-[10px] font-semibold text-amber uppercase hover:bg-amber/25"
            >
              {open ? "Cancel" : "Connect"}
            </button>
          )}
        </div>
      </div>

      {/* live-trading arm (gated on paper-off + a stored key) */}
      {connected && (
        <div className="flex items-center justify-between gap-2 border-t border-hairline px-3 py-2">
          <span className="flex items-center gap-1.5 text-[10px] text-ink-faint">
            <ShieldAlert className={`h-3 w-3 ${s?.trading ? "text-neg" : "text-ink-faint"}`} />
            Live trading {s?.trading ? "armed" : "off"}
          </span>
          <button
            onClick={() => act("connections.setArming", { venue: meta.key, trading: !s?.trading })}
            disabled={busy || (!s?.trading && !!armDisabledReason)}
            title={!s?.trading && armDisabledReason ? armDisabledReason : ""}
            className={`rounded-sm border px-2 py-1 text-[10px] font-semibold uppercase disabled:opacity-40 ${
              s?.trading
                ? "border-neg/50 bg-neg-dim text-neg hover:bg-neg/25"
                : "border-hairline text-ink-dim hover:border-amber/40 hover:text-amber"
            }`}
          >
            {s?.trading ? "Disarm" : "Arm live"}
          </button>
        </div>
      )}

      {/* connect form */}
      {open && !connected && (
        <div className="space-y-2 border-t border-hairline px-3 py-3">
          <div className="text-[10px] leading-snug text-ink-faint">{meta.obtain}</div>
          {meta.fields.map((f) => (
            <div key={f.name}>
              <label className="mb-0.5 block text-[9px] font-semibold tracking-[0.12em] text-ink-faint uppercase">
                {f.label}
              </label>
              {f.type === "select" ? (
                <select
                  value={form[f.name]}
                  onChange={(e) => setForm((s2) => ({ ...s2, [f.name]: e.target.value }))}
                  className="font-data w-full rounded-sm border border-hairline bg-panel-2 px-2 py-1.5 text-[11px] text-ink outline-none"
                >
                  {f.options?.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : f.type === "textarea" ? (
                <textarea
                  value={form[f.name]}
                  onChange={(e) => setForm((s2) => ({ ...s2, [f.name]: e.target.value }))}
                  placeholder={f.placeholder}
                  rows={3}
                  className="font-data w-full resize-none rounded-sm border border-hairline bg-bg px-2 py-1.5 text-[11px] text-ink placeholder:text-ink-faint focus:border-amber/50 focus:outline-none"
                />
              ) : (
                <input
                  type={f.type === "password" ? "password" : "text"}
                  value={form[f.name]}
                  onChange={(e) => setForm((s2) => ({ ...s2, [f.name]: e.target.value }))}
                  placeholder={f.placeholder}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-data w-full rounded-sm border border-hairline bg-bg px-2 py-1.5 text-[11px] text-ink placeholder:text-ink-faint focus:border-amber/50 focus:outline-none"
                />
              )}
            </div>
          ))}
          <div className="flex justify-end">
            <button
              onClick={connect}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-sm border border-amber/40 bg-amber-dim px-3 py-1.5 text-[11px] font-semibold text-amber uppercase hover:bg-amber/25 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
              Connect {meta.label}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function summarizeRead(venue: Venue, data: any): string {
  if (venue === "kalshi") {
    const cents = Number(data?.balance?.balance ?? data?.balance?.balance_cents);
    return Number.isFinite(cents) ? `balance ${(cents / 100).toLocaleString(undefined, { style: "currency", currency: "USD" })}` : "portfolio reachable";
  }
  if (venue === "polymarket") {
    const open = Array.isArray(data?.openOrders) ? data.openOrders.length : 0;
    return `${open} open orders`;
  }
  const positions = data?.clearinghouseState?.assetPositions;
  const open = Array.isArray(data?.openOrders) ? data.openOrders.length : 0;
  return `${Array.isArray(positions) ? positions.length : 0} positions · ${open} open orders`;
}
