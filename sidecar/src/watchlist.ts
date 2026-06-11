import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.ts";

export interface WatchlistItem {
  symbol: string;
  label: string | null;
  note: string;
  addedAt: string;
  updatedAt: string;
}

interface WatchlistFile {
  version: 1;
  items: WatchlistItem[];
}

const WATCHLIST_FILE = path.join(DATA_DIR, "watchlist.json");

function normalizeSymbol(value: unknown): string {
  const symbol = String(value ?? "")
    .trim()
    .replace(/^\$/, "")
    .toUpperCase();
  if (!symbol || !/^[A-Z0-9.^_-]+$/.test(symbol)) {
    throw new Error("Valid symbol required");
  }
  return symbol;
}

function cleanText(value: unknown, fallback = ""): string {
  return String(value ?? fallback).trim().slice(0, 500);
}

function cleanLabel(value: unknown): string | null {
  const label = cleanText(value).slice(0, 80);
  return label || null;
}

function isItem(value: any): value is WatchlistItem {
  return (
    value &&
    typeof value.symbol === "string" &&
    typeof value.note === "string" &&
    typeof value.addedAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

export class WatchlistStore {
  private read(): WatchlistFile {
    try {
      const raw = JSON.parse(fs.readFileSync(WATCHLIST_FILE, "utf8"));
      const rows = Array.isArray(raw) ? raw : raw?.items;
      const items = Array.isArray(rows)
        ? rows
            .filter(isItem)
            .map((item) => ({
              ...item,
              symbol: normalizeSymbol(item.symbol),
              label: cleanLabel(item.label),
              note: cleanText(item.note),
            }))
        : [];
      return { version: 1, items };
    } catch {
      return { version: 1, items: [] };
    }
  }

  private write(file: WatchlistFile) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${WATCHLIST_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2));
    fs.renameSync(tmp, WATCHLIST_FILE);
  }

  list(): WatchlistItem[] {
    return this.read().items.sort((a, b) => a.addedAt.localeCompare(b.addedAt));
  }

  add(
    rawSymbol: unknown,
    opts: { label?: unknown; note?: unknown } = {},
  ): { item: WatchlistItem; items: WatchlistItem[] } {
    const symbol = normalizeSymbol(rawSymbol);
    const file = this.read();
    const now = new Date().toISOString();
    const existing = file.items.find((item) => item.symbol === symbol);
    if (existing) {
      if (opts.label !== undefined) existing.label = cleanLabel(opts.label);
      if (opts.note !== undefined) existing.note = cleanText(opts.note);
      existing.updatedAt = now;
      this.write(file);
      return { item: existing, items: this.list() };
    }
    const item: WatchlistItem = {
      symbol,
      label: cleanLabel(opts.label),
      note: cleanText(opts.note),
      addedAt: now,
      updatedAt: now,
    };
    file.items.push(item);
    this.write(file);
    return { item, items: this.list() };
  }

  remove(rawSymbol: unknown): { ok: true; removed: boolean; items: WatchlistItem[] } {
    const symbol = normalizeSymbol(rawSymbol);
    const file = this.read();
    const before = file.items.length;
    file.items = file.items.filter((item) => item.symbol !== symbol);
    const removed = file.items.length !== before;
    if (removed) this.write(file);
    return { ok: true, removed, items: this.list() };
  }
}
