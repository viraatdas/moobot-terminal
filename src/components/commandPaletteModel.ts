import {
  fmtMoney,
  fmtPct,
  type AccountSnapshot,
  type LensType,
  type Position,
} from "../lib/client";

export type CommandPaletteGroup = "Symbols" | "Options" | "Alerts" | "Research" | "Navigate";

export type CommandPaletteIconKey =
  | "activity"
  | "alert"
  | "chain"
  | "create"
  | "focus"
  | "lens"
  | "play"
  | "search"
  | "spark"
  | "symbol";

export interface CommandPaletteCommand {
  id: string;
  group: CommandPaletteGroup;
  title: string;
  subtitle?: string;
  accessory?: string;
  keywords?: string[];
  icon: CommandPaletteIconKey;
  disabled?: boolean;
  closeOnSelect?: boolean;
  run: () => void | Promise<void>;
}

export interface CommandPaletteCommandGroup {
  group: CommandPaletteGroup;
  commands: CommandPaletteCommand[];
}

export interface CommandPaletteWatchlistSymbol {
  symbol: string;
  name?: string;
  note?: string;
  price?: number | null;
  changePercent?: number | null;
  keywords?: string[];
}

export interface CommandPaletteSymbol {
  symbol: string;
  label?: string;
  source: "position" | "watchlist";
  kind?: Position["kind"] | "watchlist";
  quantity?: number;
  value?: number;
  price?: number | null;
  changePercent?: number | null;
  detail?: string;
  keywords: string[];
}

export interface CommandPaletteSectionTarget {
  id: string;
  label: string;
  detail?: string;
  keywords?: string[];
}

export const COMMAND_PALETTE_GROUP_ORDER: CommandPaletteGroup[] = [
  "Research",
  "Symbols",
  "Options",
  "Alerts",
  "Navigate",
];

export const DEFAULT_COMMAND_PALETTE_SECTIONS: CommandPaletteSectionTarget[] = [
  {
    id: "portfolio",
    label: "Portfolio rail",
    detail: "Account value, positions, and buying power",
    keywords: ["positions", "holdings", "account", "book"],
  },
  {
    id: "research",
    label: "Research board",
    detail: "Active lenses, findings, and live agent activity",
    keywords: ["lenses", "agents", "findings", "tabs"],
  },
  {
    id: "proposals",
    label: "Trade proposals",
    detail: "Pending approvals, history, and manual order ticket",
    keywords: ["orders", "ticket", "approve", "trades"],
  },
];

export const CREATE_LENS_ORDER: LensType[] = [
  "research",
  "pulse",
  "scout",
  "thesis",
  "exposure",
  "lattice",
  "trade",
];

export function normalizeCommandSymbol(value: string): string {
  return value.replace(/^\$/, "").trim().toUpperCase();
}

export function queryToCommandSymbol(query: string): string | null {
  const symbol = normalizeCommandSymbol(query);
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) return null;
  return symbol;
}

export function collectCommandPaletteSymbols(
  snapshot: AccountSnapshot | null | undefined,
  watchlist: CommandPaletteWatchlistSymbol[] = [],
): CommandPaletteSymbol[] {
  const bySymbol = new Map<string, CommandPaletteSymbol>();

  const add = (item: CommandPaletteSymbol) => {
    const existing = bySymbol.get(item.symbol);
    if (!existing) {
      bySymbol.set(item.symbol, item);
      return;
    }

    existing.keywords = [...new Set([...existing.keywords, ...item.keywords])];
    existing.label ??= item.label;
    existing.detail ??= item.detail;
    existing.price ??= item.price;
    existing.changePercent ??= item.changePercent;
  };

  const positions = [
    ...(snapshot?.equities ?? []),
    ...(snapshot?.options ?? []),
    ...(snapshot?.crypto ?? []),
  ];

  for (const position of positions) {
    const symbol = normalizeCommandSymbol(position.symbol);
    if (!symbol) continue;
    add(positionToPaletteSymbol(position, symbol));
  }

  for (const entry of watchlist) {
    const symbol = normalizeCommandSymbol(entry.symbol);
    if (!symbol) continue;
    add({
      symbol,
      label: entry.name,
      source: "watchlist",
      kind: "watchlist",
      price: entry.price,
      changePercent: entry.changePercent,
      detail: entry.note,
      keywords: [
        symbol,
        entry.name ?? "",
        entry.note ?? "",
        "watchlist",
        ...(entry.keywords ?? []),
      ].filter(Boolean),
    });
  }

  return [...bySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export function describeCommandSymbol(item: CommandPaletteSymbol): string {
  const parts: string[] = [];
  parts.push(item.source === "position" ? positionKindLabel(item.kind) : "Watchlist");
  if (item.label) parts.push(item.label);
  if (item.quantity != null && item.kind !== "crypto") parts.push(`${trimNumber(item.quantity)} sh`);
  if (item.value != null) parts.push(fmtMoney(item.value));
  if (item.price != null) parts.push(`last ${fmtMoney(item.price)}`);
  if (item.changePercent != null) parts.push(fmtPct(item.changePercent));
  if (item.detail) parts.push(item.detail);
  return parts.join(" | ");
}

export function filterCommandPaletteCommands(
  commands: CommandPaletteCommand[],
  query: string,
): CommandPaletteCommandGroup[] {
  const tokens = tokenize(query);
  const filtered =
    tokens.length === 0
      ? commands
      : commands
          .map((command, index) => ({
            command,
            index,
            score: scoreCommand(command, tokens),
          }))
          .filter((entry) => entry.score > Number.NEGATIVE_INFINITY)
          .sort((a, b) => b.score - a.score || a.index - b.index)
          .map((entry) => entry.command);

  return COMMAND_PALETTE_GROUP_ORDER.map((group) => ({
    group,
    commands: filtered.filter((command) => command.group === group),
  })).filter((group) => group.commands.length > 0);
}

function positionToPaletteSymbol(position: Position, symbol: string): CommandPaletteSymbol {
  const optionBits: string[] =
    position.kind === "option"
      ? [
          position.side ?? "",
          position.strike != null ? String(position.strike) : "",
          position.expirationDate ?? "",
        ]
      : [];

  return {
    symbol,
    label: position.title,
    source: "position",
    kind: position.kind,
    quantity: position.quantity,
    value: position.value,
    price: position.currentPrice ?? position.markPrice ?? null,
    changePercent: position.unrealizedPnlPercent,
    keywords: [
      symbol,
      position.title ?? "",
      position.kind,
      "position",
      "holding",
      ...optionBits,
    ].filter(Boolean),
  };
}

function positionKindLabel(kind: CommandPaletteSymbol["kind"]): string {
  if (kind === "option") return "Option position";
  if (kind === "crypto") return "Crypto position";
  if (kind === "equity") return "Equity position";
  return "Position";
}

function trimNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function tokenize(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function scoreCommand(command: CommandPaletteCommand, tokens: string[]): number {
  const fields = [
    command.title,
    command.subtitle ?? "",
    command.accessory ?? "",
    command.group,
    ...(command.keywords ?? []),
  ].map((part) => part.toLowerCase());
  const haystack = fields.join(" ");
  let score = 0;

  for (const token of tokens) {
    if (!haystack.includes(token)) return Number.NEGATIVE_INFINITY;

    if (command.title.toLowerCase().startsWith(token)) score += 16;
    else if (fields.some((field) => field.startsWith(token))) score += 10;
    else score += 3;
  }

  if (command.disabled) score -= 4;
  return score;
}
