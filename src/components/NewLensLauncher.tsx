import { useEffect, useState } from "react";
import type { ComponentType } from "react";
import {
  Activity,
  Bot,
  Compass,
  Crosshair,
  FlaskConical,
  Layers3,
  Loader2,
  MessageSquareText,
  Network,
  Search,
  ShieldAlert,
  TrendingUp,
  X,
} from "lucide-react";
import type { LensType } from "../lib/client";

export type LensTemplateId = "starter-cockpit" | "book-watch" | "portfolio-risk" | "correlation-map";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreateChat: () => Promise<void>;
  onCreateTemplate: (template: LensTemplateId) => Promise<void>;
  onOpenAgent: (type: LensType) => void;
}

const templates: Array<{
  id: LensTemplateId;
  label: string;
  detail: string;
  icon: ComponentType<{ className?: string }>;
}> = [
  { id: "starter-cockpit", label: "Starter cockpit", detail: "Watch + Portfolio + Lattice", icon: Layers3 },
  { id: "book-watch", label: "Watch my book", detail: "Continuous market pulse", icon: Activity },
  { id: "portfolio-risk", label: "Portfolio risk", detail: "Exposure and scenarios", icon: ShieldAlert },
  { id: "correlation-map", label: "Correlation map", detail: "Hidden one-bet risk", icon: Network },
];

const agents: Array<{
  type: LensType;
  label: string;
  detail: string;
  icon: ComponentType<{ className?: string }>;
}> = [
  { type: "research", label: "Research", detail: "Ticker, theme, or catalyst brief", icon: Search },
  { type: "trade", label: "Trade", detail: "Approval-ready proposals", icon: TrendingUp },
  { type: "strategy", label: "Strategy", detail: "Rules, backtest, live monitor", icon: FlaskConical },
  { type: "thesis", label: "Thesis", detail: "Test a belief against the book", icon: Crosshair },
  { type: "scout", label: "Scout", detail: "Find new setups", icon: Compass },
];

export function NewLensLauncher({
  open,
  onClose,
  onCreateChat,
  onCreateTemplate,
  onOpenAgent,
}: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setBusy(null);
    setError(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, open]);

  if (!open) return null;

  async function run(id: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(id);
    setError(null);
    try {
      await action();
      setBusy(null);
      onClose();
    } catch (err) {
      setError(String(err));
      setBusy(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 px-4 pt-[10vh]">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="New tab"
        className="w-full max-w-3xl overflow-hidden rounded-sm border border-hairline bg-bg shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-hairline bg-panel px-5 py-4">
          <div>
            <div className="text-[11px] font-semibold tracking-[0.16em] text-ink-faint uppercase">New tab</div>
            <div className="mt-1 text-[14px] font-semibold text-ink">Choose what should open next.</div>
            {error && <div className="mt-1 max-w-md truncate text-[11px] text-neg">{error}</div>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-sm border border-hairline text-ink-faint hover:border-hairline-2 hover:text-ink"
            title="Close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="grid gap-px bg-hairline md:grid-cols-[1.08fr_1fr]">
          <div className="bg-bg p-4">
            <button
              type="button"
              onClick={() => void run("chat", onCreateChat)}
              disabled={busy !== null}
              className="group flex w-full items-start gap-3 rounded-sm border border-amber/45 bg-amber-dim px-3.5 py-3.5 text-left hover:bg-amber/25 disabled:opacity-50"
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-sm border border-amber/35 bg-bg text-amber">
                {busy === "chat" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <MessageSquareText className="h-4 w-4" />
                )}
              </span>
              <span className="min-w-0">
                <span className="block text-[14px] font-semibold text-ink">Regular chat</span>
                <span className="mt-0.5 block text-[12px] leading-snug text-ink-dim">
                  Composer first. Portfolio, venues, research tabs, and web context available.
                </span>
              </span>
            </button>

            <div className="mt-4 flex items-center justify-between">
              <div className="text-[10px] font-semibold tracking-[0.16em] text-ink-faint uppercase">Templates</div>
              <div className="font-data text-[10px] text-ink-faint">fast starts</div>
            </div>
            <div className="mt-2 space-y-1.5">
              {templates.map((template) => (
                <LauncherRow
                  key={template.id}
                  icon={template.icon}
                  label={template.label}
                  detail={template.detail}
                  busy={busy === template.id}
                  disabled={busy !== null}
                  onClick={() => void run(template.id, () => onCreateTemplate(template.id))}
                />
              ))}
            </div>
          </div>

          <div className="bg-bg p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-[10px] font-semibold tracking-[0.16em] text-ink-faint uppercase">
                <Bot className="h-3.5 w-3.5" />
                Agents
              </div>
              <div className="font-data text-[10px] text-ink-faint">specialists</div>
            </div>
            <div className="mt-2 space-y-1.5">
              {agents.map((agent) => (
                <LauncherRow
                  key={agent.type}
                  icon={agent.icon}
                  label={agent.label}
                  detail={agent.detail}
                  disabled={busy !== null}
                  onClick={() => {
                    if (busy) return;
                    onOpenAgent(agent.type);
                    onClose();
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function LauncherRow({
  icon: Icon,
  label,
  detail,
  busy = false,
  disabled = false,
  onClick,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  detail: string;
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group flex w-full items-center gap-2.5 rounded-sm border border-hairline bg-panel px-3 py-2.5 text-left hover:border-hairline-2 hover:bg-panel-2 disabled:opacity-50"
    >
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-sm border border-hairline bg-bg text-ink-faint group-hover:text-ink-dim">
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[12px] font-semibold text-ink">{label}</span>
        <span className="block truncate text-[11px] text-ink-faint">{detail}</span>
      </span>
    </button>
  );
}
