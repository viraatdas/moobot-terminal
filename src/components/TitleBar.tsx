interface Props {
  sidecarUp: boolean;
  rhAuthed: boolean;
  accounts: any[];
  accountNumber: string | null;
  onSelectAccount: (num: string) => void;
  onConnect: () => void;
  authUrl: string | null;
  pendingCount: number;
}

function Dot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-pos" : "bg-neg pulse-dot"}`}
      />
      <span className="text-[10px] tracking-[0.14em] uppercase text-ink-faint">{label}</span>
    </span>
  );
}

export function TitleBar({
  sidecarUp,
  rhAuthed,
  accounts,
  accountNumber,
  onSelectAccount,
  onConnect,
  authUrl,
  pendingCount,
}: Props) {
  return (
    <div
      data-tauri-drag-region
      className="flex h-11 shrink-0 items-center gap-5 border-b border-hairline bg-panel pr-4 pl-[84px]"
    >
      <span
        data-tauri-drag-region
        className="font-wordmark text-[17px] italic tracking-wide text-ink"
      >
        moobot
        <span className="not-italic text-amber">.</span>
      </span>

      <div className="flex items-center gap-4" data-tauri-drag-region>
        <Dot ok={sidecarUp} label="engine" />
        <Dot ok={rhAuthed} label="robinhood" />
      </div>

      {pendingCount > 0 && (
        <span className="font-data rounded-sm bg-amber-dim px-2 py-0.5 text-[10px] font-semibold text-amber">
          {pendingCount} PROPOSAL{pendingCount > 1 ? "S" : ""} AWAITING REVIEW
        </span>
      )}

      <div className="flex-1" data-tauri-drag-region />

      {!rhAuthed && sidecarUp && (
        <button
          onClick={onConnect}
          className="rounded-sm border border-amber/40 bg-amber-dim px-3 py-1 text-[11px] font-semibold tracking-wide text-amber hover:bg-amber/25"
        >
          {authUrl ? "Waiting for browser…" : "Connect Robinhood"}
        </button>
      )}

      {rhAuthed && accounts.length > 1 && (
        <select
          value={accountNumber ?? ""}
          onChange={(e) => onSelectAccount(e.target.value)}
          className="font-data rounded-sm border border-hairline bg-panel-2 px-2 py-1 text-[11px] text-ink-dim outline-none"
        >
          {accounts.map((a, i) => {
            const num = String(a?.account_number ?? a?.accountNumber ?? a?.number ?? i);
            return (
              <option key={num} value={num}>
                {num}
              </option>
            );
          })}
        </select>
      )}

      {rhAuthed && accounts.length <= 1 && accountNumber && (
        <span className="font-data text-[11px] text-ink-faint">{accountNumber}</span>
      )}
    </div>
  );
}
