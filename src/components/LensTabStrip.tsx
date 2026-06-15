import { Plus, X } from "lucide-react";
import { LENS_META, type LensType, type ResearchTab } from "../lib/client";

interface Props {
  centerMode: "cockpit" | "lens";
  tabs: ResearchTab[];
  activeLens: ResearchTab | null;
  draftLensTab: { id: number; type: LensType } | null;
  onSelectCockpit: () => void;
  onSelectLens: (tab: ResearchTab) => void;
  onCloseLens: (tab: ResearchTab) => void;
  onOpenDraft: (draft: { id: number; type: LensType }) => void;
  onCloseDraft: () => void;
  onNewLens: () => void;
  onOpenCommandPalette: () => void;
}

/**
 * Presentational center-pane tab strip: Cockpit pill, one button per lens tab,
 * the optional draft ("New Lens") tab, the add button, and the ⌘K launcher.
 * All state is passed in; every interaction is delegated upward.
 */
export function LensTabStrip({
  centerMode,
  tabs,
  activeLens,
  draftLensTab,
  onSelectCockpit,
  onSelectLens,
  onCloseLens,
  onOpenDraft,
  onCloseDraft,
  onNewLens,
  onOpenCommandPalette,
}: Props) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-hairline bg-panel px-2">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        <button
          onClick={onSelectCockpit}
          className={`h-7 shrink-0 rounded-sm border px-3 text-[10px] font-semibold tracking-[0.12em] uppercase ${
            centerMode === "cockpit"
              ? "border-amber/40 bg-amber-dim text-amber"
              : "border-transparent text-ink-faint hover:border-hairline hover:text-ink-dim"
          }`}
        >
          Cockpit
        </button>
        {tabs.map((tab) => {
          const active = centerMode === "lens" && activeLens?.id === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => onSelectLens(tab)}
              className={`group flex h-7 max-w-52 shrink-0 items-center gap-2 rounded-sm border px-2.5 text-[10px] ${
                active
                  ? "border-amber/40 bg-amber-dim text-amber"
                  : "border-transparent text-ink-faint hover:border-hairline hover:text-ink-dim"
              }`}
              title={tab.topic || LENS_META[tab.type]?.label}
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  tab.lastRunStatus === "running"
                    ? "bg-amber pulse-dot"
                    : tab.lastRunStatus === "error"
                      ? "bg-neg"
                      : "bg-pos"
                }`}
              />
              <span className="truncate">
                {tab.topic || LENS_META[tab.type]?.label || tab.type}
              </span>
              <span className="font-data text-[8px] uppercase opacity-55">{tab.type}</span>
              <span
                role="button"
                tabIndex={-1}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onCloseLens(tab);
                }}
                className="ml-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-sm opacity-0 hover:bg-neg-dim hover:text-neg group-hover:opacity-100"
                title="Close lens tab"
              >
                <X className="h-3 w-3" />
              </span>
            </button>
          );
        })}
        {draftLensTab && (
          <button
            onClick={() => onOpenDraft(draftLensTab)}
            className={`group flex h-7 max-w-52 shrink-0 items-center gap-2 rounded-sm border px-2.5 text-[10px] ${
              centerMode === "lens" && !activeLens
                ? "border-amber/40 bg-amber-dim text-amber"
                : "border-transparent text-ink-faint hover:border-hairline hover:text-ink-dim"
            }`}
            title="New empty lens tab"
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber" />
            <span className="truncate">New Lens</span>
            <span className="font-data text-[8px] uppercase opacity-55">{draftLensTab.type}</span>
            <span
              role="button"
              tabIndex={-1}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onCloseDraft();
              }}
              className="ml-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-sm opacity-0 hover:bg-neg-dim hover:text-neg group-hover:opacity-100"
              title="Close empty lens tab"
            >
              <X className="h-3 w-3" />
            </span>
          </button>
        )}
        <button
          onClick={onNewLens}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-sm border border-hairline text-ink-faint hover:border-amber/40 hover:text-amber"
          title="New lens tab (⌘T)"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      <button
        onClick={onOpenCommandPalette}
        className="font-data rounded-sm border border-hairline bg-bg px-2 py-1 text-[10px] text-ink-faint hover:border-amber/40 hover:text-amber"
        title="Open command palette (⌘K)"
      >
        ⌘K
      </button>
    </div>
  );
}
