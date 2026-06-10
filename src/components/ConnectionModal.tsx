import { useState } from "react";
import { client, getEndpoint, setCloudEndpoint, clearCloudEndpoint } from "../lib/client";

export function ConnectionModal({ onClose }: { onClose: () => void }) {
  const current = getEndpoint();
  const [host, setHost] = useState(localStorage.getItem("moobot.cloud.host") ?? "");
  const [token, setToken] = useState(localStorage.getItem("moobot.cloud.token") ?? "");

  function connectCloud() {
    if (!host.trim() || !token.trim()) return;
    setCloudEndpoint(host.trim(), token.trim());
    client.reconnect();
    onClose();
  }
  function useLocal() {
    clearCloudEndpoint();
    client.reconnect();
    onClose();
  }

  const inputCls =
    "font-data w-full rounded-sm border border-hairline bg-bg px-2.5 py-1.5 text-[12px] text-ink placeholder:text-ink-faint focus:border-amber/50 focus:outline-none";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div className="w-full max-w-md rounded-md border border-hairline-2 bg-panel p-5">
        <div className="font-wordmark text-[18px] italic text-ink">engine connection</div>
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-dim">
          Connect to a <span className="text-ink">cloud sidecar</span> so your lenses keep
          running while your laptop is closed, or use the <span className="text-ink">local</span>{" "}
          engine that runs only while the app is open.
        </p>
        <div className="mt-3 rounded-sm bg-bg px-2.5 py-1.5 font-data text-[10px] text-ink-faint">
          now: {current.cloud ? "cloud" : "local"} · {current.url.replace(/\?token=.*/, "")}
        </div>

        <div className="mt-3 space-y-2">
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="cloud host — e.g. moobot-sidecar.fly.dev"
            className={inputCls}
          />
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="MOOBOT_TOKEN (shared secret)"
            className={inputCls}
          />
        </div>

        <div className="mt-4 flex items-center justify-between gap-2">
          <button
            onClick={useLocal}
            className="rounded-sm border border-hairline px-3 py-1.5 text-[12px] text-ink-dim hover:border-hairline-2 hover:text-ink"
          >
            Use local engine
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-sm px-3 py-1.5 text-[12px] text-ink-faint hover:text-ink"
            >
              Cancel
            </button>
            <button
              onClick={connectCloud}
              disabled={!host.trim() || !token.trim()}
              className="rounded-sm border border-amber/40 bg-amber-dim px-4 py-1.5 text-[12px] font-semibold text-amber hover:bg-amber/25 disabled:opacity-40"
            >
              Connect cloud
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
