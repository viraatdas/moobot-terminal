import { useEffect, useMemo, useRef, useState } from "react";
import { Bell, Bot, ChevronDown, ChevronUp, Code2, FlaskConical, Link2, Settings, Trophy, Wifi, Zap } from "lucide-react";
import { fmtMoney, type AgentEngine } from "../lib/client";
import { MarketClock } from "./MarketClock";

interface Props {
  sidecarUp: boolean;
  rhAuthed: boolean;
  accounts: any[];
  accountNumber: string | null;
  onSelectAccount: (num: string) => void;
  onConnect: () => void;
  authUrl: string | null;
  pendingCount: number;
  onOpenAlerts: () => void;
  onOpenConnection: () => void;
  onOpenMarketConnections: () => void;
  cloud: boolean;
  agentEngine: AgentEngine;
  onAgentEngineChange: (engine: AgentEngine) => void;
  paperMode: boolean;
  onTogglePaper: () => void;
  onOpenTrackRecord: () => void;
  eventTriggers: boolean;
  onToggleEventTriggers: () => void;
}

function accountNumberFor(a: any, fallback: number): string {
  return String(a?.account_number ?? a?.accountNumber ?? a?.number ?? fallback);
}

function shortAccount(num: string): string {
  return num.length > 4 ? `••${num.slice(-4)}` : num;
}

function accountKind(a: any): string {
  if (a?.is_default) return "Main account";
  if (a?.agentic_allowed) return "Agentic trading";
  return "Robinhood";
}

function accountValue(a: any): number | null {
  const n = Number(a?.total_value ?? a?.portfolio_value ?? a?.equity);
  return Number.isFinite(n) ? n : null;
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

function AccountMenu({
  accounts,
  accountNumber,
  onSelectAccount,
}: {
  accounts: any[];
  accountNumber: string | null;
  onSelectAccount: (num: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = useMemo(() => {
    const found = accounts.find((a, i) => accountNumberFor(a, i) === accountNumber);
    return found ?? accounts[0] ?? null;
  }, [accounts, accountNumber]);
  const selectedNum = selected
    ? accountNumberFor(selected, 0)
    : (accountNumber ?? "");
  const selectedValue = selected ? accountValue(selected) : null;
  const hasChoices = accounts.length > 1;

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => hasChoices && setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="group flex min-w-42 items-center gap-2 rounded-sm border border-hairline bg-panel-2 px-2.5 py-1.5 text-left hover:border-amber/40"
        title={selectedNum ? `Viewing ${selectedNum}` : "Robinhood account"}
      >
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            selected?.agentic_allowed ? "bg-amber" : "bg-pos"
          }`}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[10px] font-semibold tracking-[0.12em] text-ink-dim uppercase group-hover:text-ink">
            {selected ? accountKind(selected) : "Robinhood"}
          </span>
          <span className="font-data block truncate text-[10px] text-ink-faint">
            {selectedNum ? shortAccount(selectedNum) : "MCP connected"}
            {selectedValue !== null ? ` · ${fmtMoney(selectedValue)}` : ""}
          </span>
        </span>
        {hasChoices &&
          (open ? (
            <ChevronUp className="h-3.5 w-3.5 text-ink-faint" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-ink-faint" />
          ))}
      </button>

      {open && hasChoices && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+7px)] z-[70] w-72 overflow-hidden rounded-md border border-hairline-2 bg-panel shadow-2xl"
        >
          <div className="border-b border-hairline px-3 py-2 text-[9.5px] tracking-[0.16em] text-ink-faint uppercase">
            View account
          </div>
          <div className="max-h-72 overflow-y-auto py-1">
            {accounts.map((a, i) => {
              const num = accountNumberFor(a, i);
              const selectedRow = num === selectedNum;
              const value = accountValue(a);
              return (
                <button
                  key={num}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onSelectAccount(num);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left ${
                    selectedRow ? "bg-amber-dim" : "hover:bg-panel-2"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      a?.agentic_allowed ? "bg-amber" : "bg-pos"
                    }`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-semibold text-ink">
                      {accountKind(a)}
                    </span>
                    <span className="font-data block truncate text-[10px] text-ink-faint">
                      {shortAccount(num)}
                      {value !== null ? ` · ${fmtMoney(value)}` : ""}
                    </span>
                  </span>
                  <span
                    className={`rounded-sm border px-1.5 py-0.5 text-[9px] font-semibold tracking-[0.1em] uppercase ${
                      a?.agentic_allowed
                        ? "border-amber/30 text-amber"
                        : "border-pos/25 text-pos"
                    }`}
                  >
                    {a?.agentic_allowed ? "trade" : a?.is_default ? "default" : "view"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function TogglePill({ on }: { on: boolean }) {
  return (
    <span
      className={`rounded-sm border px-1.5 py-0.5 text-[9px] font-semibold tracking-[0.1em] uppercase ${
        on ? "border-amber/40 bg-amber-dim text-amber" : "border-hairline text-ink-faint"
      }`}
    >
      {on ? "On" : "Off"}
    </span>
  );
}

// Low-frequency settings, grouped off the main bar: agent engine, event triggers,
// connection details, and the track-record modal.
function SettingsMenu({
  agentEngine,
  onAgentEngineChange,
  eventTriggers,
  onToggleEventTriggers,
  onOpenConnection,
  onOpenMarketConnections,
  onOpenTrackRecord,
}: {
  agentEngine: AgentEngine;
  onAgentEngineChange: (engine: AgentEngine) => void;
  eventTriggers: boolean;
  onToggleEventTriggers: () => void;
  onOpenConnection: () => void;
  onOpenMarketConnections: () => void;
  onOpenTrackRecord: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Settings"
        className={`grid h-7 w-7 place-items-center rounded-sm border ${
          open
            ? "border-amber/50 bg-amber-dim text-amber"
            : "border-hairline text-ink-dim hover:border-amber/50 hover:text-amber"
        }`}
      >
        <Settings className="h-3.5 w-3.5" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+7px)] z-[70] w-64 overflow-hidden rounded-md border border-hairline-2 bg-panel shadow-2xl"
        >
          <div className="border-b border-hairline px-3 py-2.5">
            <div className="mb-1.5 text-[9.5px] tracking-[0.16em] text-ink-faint uppercase">
              Agent engine
            </div>
            <div className="flex items-center overflow-hidden rounded-sm border border-hairline bg-panel-2">
              {(["claude", "codex"] as const).map((engine) => {
                const active = agentEngine === engine;
                const Icon = engine === "codex" ? Code2 : Bot;
                return (
                  <button
                    key={engine}
                    type="button"
                    onClick={() => onAgentEngineChange(engine)}
                    className={`flex h-7 flex-1 items-center justify-center gap-1.5 text-[10px] font-semibold tracking-[0.12em] uppercase ${
                      active ? "bg-amber-dim text-amber" : "text-ink-faint hover:text-ink-dim"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {engine}
                  </button>
                );
              })}
            </div>
            <div className="mt-1.5 text-[9.5px] leading-snug text-ink-faint">
              Default for new lenses. Existing tabs keep their engine.
            </div>
          </div>

          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={eventTriggers}
            onClick={onToggleEventTriggers}
            className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-panel-2"
          >
            <Zap className={`h-3.5 w-3.5 shrink-0 ${eventTriggers ? "text-amber" : "text-ink-faint"}`} />
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] font-medium text-ink">Event triggers</span>
              <span className="block text-[10px] text-ink-faint">Wake agents on 5% moves &amp; new filings</span>
            </span>
            <TogglePill on={eventTriggers} />
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onOpenConnection();
              setOpen(false);
            }}
            className="flex w-full items-center gap-2.5 border-t border-hairline px-3 py-2.5 text-left hover:bg-panel-2"
          >
            <Wifi className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
            <span className="text-[12px] font-medium text-ink">Connection…</span>
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onOpenMarketConnections();
              setOpen(false);
            }}
            className="flex w-full items-center gap-2.5 border-t border-hairline px-3 py-2.5 text-left hover:bg-panel-2"
          >
            <Link2 className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
            <span className="text-[12px] font-medium text-ink">Market connections…</span>
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onOpenTrackRecord();
              setOpen(false);
            }}
            className="flex w-full items-center gap-2.5 border-t border-hairline px-3 py-2.5 text-left hover:bg-panel-2"
          >
            <Trophy className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
            <span className="text-[12px] font-medium text-ink">Track record</span>
          </button>
        </div>
      )}
    </div>
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
  onOpenAlerts,
  onOpenConnection,
  onOpenMarketConnections,
  cloud,
  agentEngine,
  onAgentEngineChange,
  paperMode,
  onTogglePaper,
  onOpenTrackRecord,
  eventTriggers,
  onToggleEventTriggers,
}: Props) {
  return (
    <div
      data-tauri-drag-region
      className={`flex h-11 shrink-0 items-center gap-5 border-b bg-panel pr-4 pl-[84px] ${
        paperMode ? "border-amber/40" : "border-hairline"
      }`}
    >
      <span
        data-tauri-drag-region
        className="font-wordmark text-[17px] italic tracking-wide text-ink"
      >
        moobot
        <span className="not-italic text-amber">.</span>
      </span>

      <div className="flex items-center gap-4" data-tauri-drag-region>
        <span
          className="flex items-center gap-1.5"
          title={`Engine: ${cloud ? "cloud" : "local"} — ${sidecarUp ? "connected" : "disconnected"}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${sidecarUp ? "bg-pos" : "bg-neg pulse-dot"}`} />
          <span className="text-[10px] tracking-[0.14em] uppercase text-ink-faint">
            {cloud ? "Cloud" : "Local"}
          </span>
        </span>
        <Dot ok={rhAuthed} label="robinhood" />
      </div>

      {pendingCount > 0 && (
        <span className="font-data rounded-sm bg-amber-dim px-2 py-0.5 text-[10px] font-semibold text-amber">
          {pendingCount} PROPOSAL{pendingCount > 1 ? "S" : ""} AWAITING REVIEW
        </span>
      )}

      <div className="flex-1" data-tauri-drag-region />

      <MarketClock />

      <button
        onClick={onTogglePaper}
        title={
          paperMode
            ? "Paper mode ON — approvals are simulated, nothing is sent to Robinhood. Click to go live."
            : "Live mode — approvals place real orders. Click to switch to paper (dry-run)."
        }
        className={`flex h-7 items-center gap-1.5 rounded-sm border px-2 text-[10px] font-semibold tracking-[0.12em] uppercase ${
          paperMode
            ? "border-amber/50 bg-amber-dim text-amber"
            : "border-hairline text-ink-faint hover:border-amber/40 hover:text-ink-dim"
        }`}
      >
        <FlaskConical className="h-3.5 w-3.5" />
        {paperMode ? "paper" : "live"}
      </button>

      <button
        onClick={onOpenAlerts}
        title="Price alerts"
        className="grid h-7 w-7 place-items-center rounded-sm border border-hairline text-ink-dim hover:border-amber/50 hover:text-amber"
      >
        <Bell className="h-3.5 w-3.5" />
      </button>

      <SettingsMenu
        agentEngine={agentEngine}
        onAgentEngineChange={onAgentEngineChange}
        eventTriggers={eventTriggers}
        onToggleEventTriggers={onToggleEventTriggers}
        onOpenConnection={onOpenConnection}
        onOpenMarketConnections={onOpenMarketConnections}
        onOpenTrackRecord={onOpenTrackRecord}
      />

      {!rhAuthed && sidecarUp && (
        <button
          onClick={onConnect}
          className="rounded-sm border border-amber/40 bg-amber-dim px-3 py-1 text-[11px] font-semibold tracking-wide text-amber hover:bg-amber/25"
        >
          {authUrl ? "Waiting for browser…" : "Connect Robinhood"}
        </button>
      )}

      {rhAuthed && (accounts.length > 1 || accountNumber) && (
        <AccountMenu
          accounts={accounts}
          accountNumber={accountNumber}
          onSelectAccount={onSelectAccount}
        />
      )}
    </div>
  );
}
