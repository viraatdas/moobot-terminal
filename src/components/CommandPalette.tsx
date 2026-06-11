import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  Activity,
  BellPlus,
  ChartCandlestick,
  Command as CommandIcon,
  Focus,
  ListPlus,
  PanelsTopLeft,
  Play,
  Search,
  Sparkles,
  Waypoints,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  LENS_META,
  type AccountSnapshot,
  type LensType,
  type ResearchTab,
} from "../lib/client";
import {
  collectCommandPaletteSymbols,
  CREATE_LENS_ORDER,
  DEFAULT_COMMAND_PALETTE_SECTIONS,
  describeCommandSymbol,
  filterCommandPaletteCommands,
  queryToCommandSymbol,
  type CommandPaletteCommand,
  type CommandPaletteIconKey,
  type CommandPaletteSectionTarget,
  type CommandPaletteSymbol,
  type CommandPaletteWatchlistSymbol,
} from "./commandPaletteModel";

export interface CommandPaletteProps {
  snapshot?: AccountSnapshot | null;
  watchlist?: CommandPaletteWatchlistSymbol[];
  researchTabs?: ResearchTab[];
  activeLens?: ResearchTab | null;
  sectionTargets?: CommandPaletteSectionTarget[];
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  onOpenOptionsChain?: (symbol?: string) => void | Promise<void>;
  onAddAlert?: (symbol?: string) => void | Promise<void>;
  onRunActiveLens?: (tab: ResearchTab) => void | Promise<void>;
  onRunAllLenses?: () => void | Promise<void>;
  onCreateLens?: (type?: LensType) => void | Promise<void>;
  onFocusSection?: (target: CommandPaletteSectionTarget) => void | Promise<void>;
  onSelectSymbol?: (symbol: string, item: CommandPaletteSymbol) => void | Promise<void>;
}

const ICONS: Record<CommandPaletteIconKey, LucideIcon> = {
  activity: Activity,
  alert: BellPlus,
  chain: ChartCandlestick,
  create: ListPlus,
  focus: Focus,
  lens: Waypoints,
  play: Play,
  search: Search,
  spark: Sparkles,
  symbol: PanelsTopLeft,
};

export function CommandPalette({
  snapshot = null,
  watchlist = [],
  researchTabs = [],
  activeLens = null,
  sectionTargets = DEFAULT_COMMAND_PALETTE_SECTIONS,
  open,
  defaultOpen = false,
  onOpenChange,
  onOpenOptionsChain,
  onAddAlert,
  onRunActiveLens,
  onRunAllLenses,
  onCreateLens,
  onFocusSection,
  onSelectSymbol,
}: CommandPaletteProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const isOpen = open ?? internalOpen;

  const setPaletteOpen = useCallback(
    (nextOpen: boolean) => {
      if (open === undefined) setInternalOpen(nextOpen);
      onOpenChange?.(nextOpen);
      if (!nextOpen) setQuery("");
    },
    [onOpenChange, open],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (event.metaKey && !event.ctrlKey && !event.altKey && key === "k") {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }

      if (isOpen && event.key === "Escape") {
        event.preventDefault();
        setPaletteOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [isOpen, setPaletteOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen]);

  const symbolItems = useMemo(
    () => collectCommandPaletteSymbols(snapshot, watchlist),
    [snapshot, watchlist],
  );
  const querySymbol = queryToCommandSymbol(query);

  const commands = useMemo(
    () =>
      buildCommands({
        querySymbol,
        symbolItems,
        researchTabs,
        activeLens,
        sectionTargets,
        onOpenOptionsChain,
        onAddAlert,
        onRunActiveLens,
        onRunAllLenses,
        onCreateLens,
        onFocusSection,
        onSelectSymbol,
      }),
    [
      activeLens,
      onAddAlert,
      onCreateLens,
      onFocusSection,
      onOpenOptionsChain,
      onRunActiveLens,
      onRunAllLenses,
      onSelectSymbol,
      querySymbol,
      researchTabs,
      sectionTargets,
      symbolItems,
    ],
  );

  const groups = useMemo(() => filterCommandPaletteCommands(commands, query), [commands, query]);
  const flatCommands = useMemo(() => groups.flatMap((group) => group.commands), [groups]);

  useEffect(() => {
    const nextIndex = nextEnabledIndex(flatCommands, -1, 1);
    setSelectedIndex(nextIndex < 0 ? 0 : nextIndex);
  }, [flatCommands]);

  useEffect(() => {
    if (!isOpen) return;
    const active = document.getElementById(`${listId}-item-${selectedIndex}`);
    active?.scrollIntoView({ block: "nearest" });
  }, [isOpen, listId, selectedIndex]);

  const invoke = useCallback(
    (command: CommandPaletteCommand) => {
      if (command.disabled) return;
      if (command.closeOnSelect !== false) setPaletteOpen(false);
      void Promise.resolve(command.run()).catch((err) => console.error("command failed", err));
    },
    [setPaletteOpen],
  );

  const onInputKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setPaletteOpen(false);
        return;
      }

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const nextIndex = nextEnabledIndex(flatCommands, selectedIndex, direction);
        if (nextIndex >= 0) setSelectedIndex(nextIndex);
        return;
      }

      if (event.key === "Home") {
        event.preventDefault();
        const nextIndex = nextEnabledIndex(flatCommands, -1, 1);
        if (nextIndex >= 0) setSelectedIndex(nextIndex);
        return;
      }

      if (event.key === "End") {
        event.preventDefault();
        const nextIndex = nextEnabledIndex(flatCommands, 0, -1);
        if (nextIndex >= 0) setSelectedIndex(nextIndex);
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        const command = flatCommands[selectedIndex];
        if (command) invoke(command);
      }
    },
    [flatCommands, invoke, selectedIndex, setPaletteOpen],
  );

  if (!isOpen) return null;

  let itemIndex = 0;
  const activeDescendant =
    flatCommands.length > 0 ? `${listId}-item-${selectedIndex}` : undefined;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/70 px-4 pt-[12vh] backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setPaletteOpen(false);
      }}
    >
      <div className="w-full max-w-2xl overflow-hidden rounded-md border border-hairline-2 bg-panel shadow-[0_28px_90px_rgba(0,0,0,0.55)]">
        <div className="flex items-center gap-3 border-b border-hairline bg-bg/80 px-4 py-3">
          <CommandIcon className="h-4 w-4 shrink-0 text-amber" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={activeDescendant}
            placeholder="Search symbols, lenses, alerts, sections"
            className="min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-faint focus:outline-none"
          />
          <button
            onClick={() => setPaletteOpen(false)}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-sm text-ink-faint hover:bg-panel-2 hover:text-ink"
            aria-label="Close command palette"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div
          id={listId}
          role="listbox"
          className="max-h-[min(58vh,520px)] overflow-y-auto p-2"
        >
          {groups.length === 0 ? (
            <EmptyState query={query} />
          ) : (
            groups.map((group) => (
              <div key={group.group} className="py-1.5">
                <div className="px-2 pb-1 text-[10px] font-semibold tracking-[0.16em] text-ink-faint uppercase">
                  {group.group}
                </div>
                <div className="space-y-1">
                  {group.commands.map((command) => {
                    const currentIndex = itemIndex;
                    itemIndex += 1;
                    return (
                      <CommandRow
                        key={command.id}
                        id={`${listId}-item-${currentIndex}`}
                        command={command}
                        active={currentIndex === selectedIndex}
                        selected={currentIndex === selectedIndex}
                        onPointerMove={() => setSelectedIndex(currentIndex)}
                        onSelect={() => invoke(command)}
                      />
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function buildCommands({
  querySymbol,
  symbolItems,
  researchTabs,
  activeLens,
  sectionTargets,
  onOpenOptionsChain,
  onAddAlert,
  onRunActiveLens,
  onRunAllLenses,
  onCreateLens,
  onFocusSection,
  onSelectSymbol,
}: {
  querySymbol: string | null;
  symbolItems: CommandPaletteSymbol[];
  researchTabs: ResearchTab[];
  activeLens: ResearchTab | null;
  sectionTargets: CommandPaletteSectionTarget[];
  onOpenOptionsChain?: (symbol?: string) => void | Promise<void>;
  onAddAlert?: (symbol?: string) => void | Promise<void>;
  onRunActiveLens?: (tab: ResearchTab) => void | Promise<void>;
  onRunAllLenses?: () => void | Promise<void>;
  onCreateLens?: (type?: LensType) => void | Promise<void>;
  onFocusSection?: (target: CommandPaletteSectionTarget) => void | Promise<void>;
  onSelectSymbol?: (symbol: string, item: CommandPaletteSymbol) => void | Promise<void>;
}): CommandPaletteCommand[] {
  const commands: CommandPaletteCommand[] = [];
  const typedSymbol = querySymbol ?? undefined;

  commands.push({
    id: `options.open.${typedSymbol ?? "blank"}`,
    group: "Options",
    title: typedSymbol ? `Open ${typedSymbol} options chain` : "Open options chain",
    subtitle: typedSymbol ? "Load chain for the typed symbol" : "Open the chain viewer",
    keywords: ["chain", "calls", "puts", "contracts", "derivatives"],
    icon: "chain",
    disabled: !onOpenOptionsChain,
    run: () => onOpenOptionsChain?.(typedSymbol),
  });

  commands.push({
    id: `alerts.add.${typedSymbol ?? "blank"}`,
    group: "Alerts",
    title: typedSymbol ? `Add ${typedSymbol} price alert` : "Add price alert",
    subtitle: typedSymbol ? "Open alerts with the typed symbol" : "Open price alerts",
    keywords: ["alert", "price", "notification", "watch"],
    icon: "alert",
    disabled: !onAddAlert,
    run: () => onAddAlert?.(typedSymbol),
  });

  for (const item of symbolItems) {
    commands.push({
      id: `symbol.${item.symbol}.chain`,
      group: "Symbols",
      title: `Open ${item.symbol} options chain`,
      subtitle: describeCommandSymbol(item),
      accessory: item.source,
      keywords: [...item.keywords, "chain", "options", "symbol", item.symbol],
      icon: "symbol",
      disabled: !onOpenOptionsChain,
      run: async () => {
        await onSelectSymbol?.(item.symbol, item);
        await onOpenOptionsChain?.(item.symbol);
      },
    });

    commands.push({
      id: `symbol.${item.symbol}.alert`,
      group: "Symbols",
      title: `Add ${item.symbol} price alert`,
      subtitle: describeCommandSymbol(item),
      accessory: item.source,
      keywords: [...item.keywords, "alert", "price", "symbol", item.symbol],
      icon: "alert",
      disabled: !onAddAlert,
      run: async () => {
        await onSelectSymbol?.(item.symbol, item);
        await onAddAlert?.(item.symbol);
      },
    });
  }

  commands.push({
    id: "research.run-active",
    group: "Research",
    title: "Run active lens",
    subtitle: activeLens
      ? `${LENS_META[activeLens.type].label}: ${activeLens.topic || LENS_META[activeLens.type].label}`
      : "No active lens is available yet",
    keywords: ["research", "lens", "agent", "run", "active"],
    icon: "play",
    disabled: !activeLens || activeLens.lastRunStatus === "running" || !onRunActiveLens,
    run: () => (activeLens ? onRunActiveLens?.(activeLens) : undefined),
  });

  commands.push({
    id: "research.run-all",
    group: "Research",
    title: "Run all lenses",
    subtitle:
      researchTabs.length > 0
        ? `${researchTabs.filter((tab) => !tab.paused).length} unpaused of ${researchTabs.length} total`
        : "No lenses have been created",
    keywords: ["research", "lens", "agent", "run", "all"],
    icon: "activity",
    disabled: researchTabs.length === 0 || !onRunAllLenses,
    run: () => onRunAllLenses?.(),
  });

  commands.push({
    id: "research.create",
    group: "Research",
    title: "Create lens",
    subtitle: "Open the new lens composer",
    keywords: ["new", "create", "research", "lens", "agent"],
    icon: "create",
    disabled: !onCreateLens,
    run: () => onCreateLens?.(),
  });

  for (const lensType of CREATE_LENS_ORDER) {
    const meta = LENS_META[lensType];
    commands.push({
      id: `research.create.${lensType}`,
      group: "Research",
      title: `Create ${meta.label} lens`,
      subtitle: meta.blurb,
      keywords: ["new", "create", "research", "lens", "agent", lensType, meta.label],
      icon: lensType === "pulse" ? "spark" : "lens",
      disabled: !onCreateLens,
      run: () => onCreateLens?.(lensType),
    });
  }

  for (const target of sectionTargets) {
    commands.push({
      id: `section.${target.id}`,
      group: "Navigate",
      title: `Focus ${target.label}`,
      subtitle: target.detail,
      keywords: [
        "focus",
        "go",
        "show",
        "section",
        target.id,
        target.label,
        ...(target.keywords ?? []),
      ],
      icon: "focus",
      disabled: !onFocusSection,
      run: () => onFocusSection?.(target),
    });
  }

  return commands;
}

function CommandRow({
  id,
  command,
  active,
  selected,
  onPointerMove,
  onSelect,
}: {
  id: string;
  command: CommandPaletteCommand;
  active: boolean;
  selected: boolean;
  onPointerMove: () => void;
  onSelect: () => void;
}) {
  const Icon = ICONS[command.icon];
  return (
    <button
      id={id}
      role="option"
      aria-selected={selected}
      disabled={command.disabled}
      onPointerMove={onPointerMove}
      onClick={onSelect}
      className={`flex min-h-[52px] w-full items-center gap-3 rounded-sm border px-3 py-2 text-left transition-colors ${
        active
          ? "border-amber/35 bg-amber-dim text-ink"
          : "border-transparent text-ink-dim hover:bg-bg"
      } ${command.disabled ? "opacity-45" : ""}`}
    >
      <span
        className={`grid h-8 w-8 shrink-0 place-items-center rounded-sm border ${
          active ? "border-amber/35 bg-bg text-amber" : "border-hairline bg-bg text-ink-faint"
        }`}
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-ink">{command.title}</span>
        {command.subtitle && (
          <span className="mt-0.5 block truncate text-[11px] text-ink-faint">
            {command.subtitle}
          </span>
        )}
      </span>
      {command.accessory && (
        <span className="font-data shrink-0 rounded-sm border border-hairline bg-bg px-1.5 py-0.5 text-[9px] text-ink-faint uppercase">
          {command.accessory}
        </span>
      )}
    </button>
  );
}

function EmptyState({ query }: { query: string }) {
  return (
    <div className="px-6 py-12 text-center">
      <Search className="mx-auto mb-3 h-5 w-5 text-ink-faint" />
      <div className="text-[13px] font-semibold text-ink">No command found</div>
      <div className="mx-auto mt-1 max-w-xs text-[12px] leading-relaxed text-ink-faint">
        {query.trim()
          ? "Try a ticker, lens name, alert action, or cockpit section."
          : "Start typing to search positions, watchlist symbols, lenses, and cockpit actions."}
      </div>
    </div>
  );
}

function nextEnabledIndex(
  commands: CommandPaletteCommand[],
  currentIndex: number,
  direction: 1 | -1,
): number {
  if (commands.length === 0) return -1;
  for (let step = 1; step <= commands.length; step += 1) {
    const index = (currentIndex + step * direction + commands.length) % commands.length;
    if (!commands[index].disabled) return index;
  }
  return -1;
}
