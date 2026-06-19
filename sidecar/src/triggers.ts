import type { ResearchManager } from "./research.ts";
import type { ResearchTab } from "./research.ts";
import type { RobinhoodMcpData } from "./rh-mcp-data.ts";
import type { MarketEventsService } from "./market-events.ts";
import type { WatchlistStore } from "./watchlist.ts";

export interface TriggerEngineDeps {
  research: ResearchManager;
  rhData: RobinhoodMcpData;
  marketEvents: MarketEventsService;
  watchlist: WatchlistStore;
  isConnected: () => boolean;
  isEnabled: () => boolean;
}

const PRICE_TICK_MS = 90_000;
// Re-check filings every Nth price tick (~6 min); SEC data is cached internally.
const FILING_EVERY_TICKS = 4;
// A lens woken by an event won't be event-woken again for this long.
const MIN_WAKE_GAP_MS = 12 * 60_000;
// A material intraday move from the rolling baseline.
const MOVE_THRESHOLD = 0.05;

const CASHTAG_RE = /\$([A-Za-z]{1,5})\b/g;

/**
 * Wakes research lenses on real-world events — a 5% move or a fresh 8-K — instead
 * of only the per-lens timer. Lenses are matched to symbols by the tickers named
 * in their topic/notes; "pulse" lenses (portfolio monitors) wake on any event.
 */
export class TriggerEngine {
  private deps: TriggerEngineDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;
  private baseline = new Map<string, number>();
  private seenEventIds = new Set<string>();
  private lastWake = new Map<string, number>();
  private ticking = false;

  constructor(deps: TriggerEngineDeps) {
    this.deps = deps;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), PRICE_TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Symbols a lens cares about: watchlist symbols named in its text, plus $cashtags. */
  private lensSymbols(tab: ResearchTab, watchSymbols: string[]): Set<string> {
    const haystack = `${tab.topic} ${tab.notes ?? ""}`;
    const upper = haystack.toUpperCase();
    const found = new Set<string>();
    for (const sym of watchSymbols) {
      if (new RegExp(`\\b${sym.replace(/[.^]/g, "\\$&")}\\b`).test(upper)) found.add(sym);
    }
    let m: RegExpExecArray | null;
    CASHTAG_RE.lastIndex = 0;
    while ((m = CASHTAG_RE.exec(haystack)) !== null) found.add(m[1].toUpperCase());
    return found;
  }

  private wakeFor(symbol: string, reason: string, tabs: ResearchTab[], watchSymbols: string[]) {
    const now = Date.now();
    for (const tab of tabs) {
      if (tab.paused) continue;
      if (tab.type === "lattice" || tab.type === "exposure") continue; // deterministic / math lenses
      const symbols = this.lensSymbols(tab, watchSymbols);
      const matches = symbols.has(symbol) || tab.type === "pulse";
      if (!matches) continue;
      const last = this.lastWake.get(tab.id) ?? 0;
      if (now - last < MIN_WAKE_GAP_MS) continue;
      if (tab.lastRunStatus === "running") continue;
      this.lastWake.set(tab.id, now);
      void this.deps.research.run(tab.id, reason).catch(() => {});
    }
  }

  private async tick() {
    if (this.ticking) return;
    if (!this.deps.isEnabled() || !this.deps.isConnected()) return;
    this.ticking = true;
    this.tickCount += 1;
    try {
      const tabs = this.deps.research.list();
      const watchSymbols = this.deps.watchlist.list().map((w) => w.symbol.toUpperCase());
      const universe = new Set<string>(watchSymbols);
      for (const tab of tabs) {
        if (tab.paused) continue;
        for (const sym of this.lensSymbols(tab, watchSymbols)) universe.add(sym);
      }
      const symbols = [...universe];
      if (symbols.length === 0) return;

      // 1. Price moves from a rolling baseline.
      try {
        const prices = await this.deps.rhData.quotes(symbols);
        for (const [symbol, price] of prices) {
          const base = this.baseline.get(symbol);
          if (base === undefined || base <= 0) {
            this.baseline.set(symbol, price);
            continue;
          }
          const move = (price - base) / base;
          if (Math.abs(move) >= MOVE_THRESHOLD) {
            const reason = `${symbol} ${move >= 0 ? "+" : ""}${(move * 100).toFixed(1)}% move`;
            this.wakeFor(symbol, reason, tabs, watchSymbols);
            this.baseline.set(symbol, price); // reset so it doesn't re-fire each tick
          }
        }
      } catch {
        // quotes unavailable this tick — try again next time
      }

      // 2. New SEC filings / news (less often; SEC is cached internally). The
      // first pass only seeds seen-ids so we never wake on the existing backlog.
      if (this.tickCount % FILING_EVERY_TICKS === 1) {
        const firstFilingPass = this.seenEventIds.size === 0;
        try {
          const res = await this.deps.marketEvents.events(undefined, { symbols });
          for (const ev of res.events) {
            if (ev.type !== "filing" && ev.type !== "news") continue;
            if (ev.severity === "low") continue;
            if (this.seenEventIds.has(ev.id)) continue;
            this.seenEventIds.add(ev.id);
            if (firstFilingPass) continue; // seed only — don't wake on startup backlog
            const label = ev.type === "news" ? "news" : "filing";
            for (const symbol of ev.symbols) {
              this.wakeFor(symbol, `new ${symbol} ${label}: ${ev.title}`, tabs, watchSymbols);
            }
          }
        } catch {
          // filings unavailable this tick
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}
