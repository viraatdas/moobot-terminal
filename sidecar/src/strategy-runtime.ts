import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseSpec, evalCondition, sizeOrder, SeriesContext, type StrategySpec, type PositionView } from "./backtest.ts";
import { canonicalSpecHash, gateVerification } from "./verify.ts";
import { loadStrategyBars } from "./strategy-bars.ts";
import type { TrackRecordService } from "./track-record.ts";
import { LENS_MODEL } from "./config.ts";
import type { ResearchManager } from "./research.ts";
import type { RobinhoodMcpData } from "./rh-mcp-data.ts";
import type { MarketData } from "./market-data.ts";
import type { ProposalQueue } from "./proposals.ts";

export interface StrategyRuntimeDeps {
  research: ResearchManager;
  rhData: RobinhoodMcpData;
  marketData: MarketData;
  proposals: ProposalQueue;
  trackRecord: TrackRecordService;
  isEnabled: () => boolean;
  isConnected: () => boolean;
  isPaper: () => boolean;
  onActivity?: (tabId: string, text: string) => void;
}

const TICK_MS = 3 * 60_000;
const MIN_FIRE_GAP_MS = 6 * 60 * 60_000; // don't re-fire the same symbol/side within 6h
const GATE_TIMEOUT_MS = 75_000;

/**
 * Evaluates LIVE strategy lenses each interval and files proposals when a
 * mechanical rule trips. The same rule evaluator the backtest uses runs here, so
 * live and historical behaviour match. An optional live-only LLM gate gets the
 * final say before a signal becomes a proposal — the one spot where model
 * judgment (and fresh news) enters, deliberately excluded from the backtest.
 */
export class StrategyRuntime {
  private deps: StrategyRuntimeDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private lastSignal = new Map<string, boolean>();
  private lastFire = new Map<string, number>();
  private observed = new Map<string, { firstSeen: number; bars: number; best: number }>();

  constructor(deps: StrategyRuntimeDeps) {
    this.deps = deps;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick() {
    if (this.ticking) return;
    if (!this.deps.isEnabled() || !this.deps.isConnected()) return;
    this.ticking = true;
    try {
      const live = this.deps.research
        .list()
        .filter((t) => t.type === "strategy" && !t.paused)
        .map((t) => ({ tab: t, parsed: parseSpec(this.deps.research.readStrategy(t.id)) }))
        .filter((x): x is { tab: (typeof x)["tab"]; parsed: StrategySpec } => "version" in x.parsed && x.parsed.live === true);
      if (live.length === 0) return;

      // Held equities (entry price + size) so exits fire against real positions.
      const held = new Map<string, { quantity: number; avgPrice: number }>();
      let accountEquity = 0;
      let snapshotOk = false;
      try {
        const snap = await this.deps.rhData.snapshot();
        accountEquity = Number(snap.portfolio?.equity) || 0;
        for (const p of snap.equities) {
          if (Math.abs(p.quantity) > 0) held.set(p.symbol.toUpperCase(), { quantity: p.quantity, avgPrice: p.averagePrice });
        }
        snapshotOk = true;
      } catch {
        // no snapshot this tick — fixed-size entries can still fire; equity-% entries
        // are skipped below (we won't size off a guessed account value), and exits
        // need holdings so they're skipped too.
      }

      // Evaluate on SETTLED daily bars only — exactly what the backtest sees — so
      // live and historical decisions match. We deliberately do NOT splice in a
      // synthetic forming bar: its high=low=close=quote, volume=0 shape was fake and
      // corrupted intrabar/volume/ATR/trailing-stop rules. Same 5y window as the
      // backtest (was 2y, another live-vs-backtest divergence).
      const allSymbols = [...new Set(live.flatMap((s) => s.parsed.universe))];
      // One canonical loader (shared with the backtest/verify path) enforces the
      // adjusted-only invariant; sequential to throttle Yahoo's chart API.
      const history = await loadStrategyBars(this.deps.marketData, allSymbols, { minBars: 30, sequential: true });

      for (const { tab, parsed: spec } of live) {
        const specHash = canonicalSpecHash(spec);
        // Decide whether NEW entries may fire (real money only). EXITS always fire
        // so a held position is never stranded by a stale/diverged verdict. Real
        // money opens new positions ONLY from rules whose EXACT hash matches a
        // non-stale "holds-up" verification AND whose live results have not diverged
        // from the backtest. Paper mode is exempt so unverified strategies can trial.
        let entriesAllowed = true;
        if (!this.deps.isPaper()) {
          const v = this.deps.research.readVerification(tab.id);
          // ONE canonical gate (shared with the UI badge + the go-live gate). When
          // it passes, v is non-null. The live-divergence check stays separate.
          if (!gateVerification(spec, v).ok) {
            entriesAllowed = false;
            this.deps.onActivity?.(tab.id, "not opening new positions (real money): rules unverified or changed since verification — exits still allowed");
          } else {
            try {
              const lc = await this.deps.trackRecord.liveConsistency(tab.id, v!.backtestWinRatePct ?? null, v!.specHash ?? null);
              if (lc.verdict === "diverged") {
                entriesAllowed = false;
                this.deps.onActivity?.(tab.id, `not opening new positions (real money): live results diverged from backtest — ${lc.detail} — exits still allowed`);
              }
            } catch {
              /* reconciliation unavailable this tick — leave entries allowed */
            }
          }
        }
        for (const symbol of spec.universe) {
          const bars = history.get(symbol);
          if (!bars) continue;
          const ctx = new SeriesContext(bars);
          const i = bars.length - 1;
          const holding = held.get(symbol);
          const key = `${tab.id}:${symbol}`;
          const side: "buy" | "sell" = holding ? "sell" : "buy";
          const sigKey = `${key}:${side}`;

          // Track best price for live trailing-stop approximation.
          if (holding) {
            // Seed the high-water mark at the entry price, not just today's close:
            // a position may have already run past entry before the runtime began
            // observing it, and a too-low seed would fire the trailing stop early.
            const seedBest =
              spec.direction === "long"
                ? Math.max(holding.avgPrice, bars[i].close)
                : Math.min(holding.avgPrice, bars[i].close);
            const obs = this.observed.get(key) ?? { firstSeen: Date.now(), bars: 0, best: seedBest };
            obs.bars += 1;
            obs.best = spec.direction === "long" ? Math.max(obs.best, bars[i].close) : Math.min(obs.best, bars[i].close);
            this.observed.set(key, obs);
          } else {
            this.observed.delete(key);
          }

          let signal: boolean;
          if (holding) {
            const obs = this.observed.get(key)!;
            const view: PositionView = { side: spec.direction, entryPrice: holding.avgPrice, barsHeld: obs.bars, best: obs.best };
            signal = evalCondition(spec.exit, ctx, i, view);
          } else {
            signal = evalCondition(spec.entry, ctx, i, null);
          }

          const prev = this.lastSignal.get(sigKey) ?? false;
          this.lastSignal.set(sigKey, signal);
          if (!signal || prev) continue; // only on a rising edge
          if (Date.now() - (this.lastFire.get(sigKey) ?? 0) < MIN_FIRE_GAP_MS) continue;

          // Block NEW entries when real-money rules are unverified/diverged; exits
          // (closing a held position) are never blocked.
          if (side === "buy" && !entriesAllowed) continue;

          // Equity-% sizing needs a real account value. If the snapshot failed this
          // tick we don't know it, so skip the entry rather than size off a guess.
          if (side === "buy" && spec.sizing.type === "equityPct" && (!snapshotOk || accountEquity <= 0)) {
            this.deps.onActivity?.(tab.id, `skipped ${symbol} entry — account equity unknown this tick`);
            continue;
          }

          const price = bars[i].close;
          const reason =
            side === "buy"
              ? `entry rule met @ ${price.toFixed(2)}`
              : `exit rule met @ ${price.toFixed(2)}`;

          // Live LLM gate — the only place model judgment enters.
          if (spec.llmGate && spec.llmGate.mode === "live-only" && spec.llmGate.prompt.trim()) {
            const verdict = await this.runGate(spec, symbol, side, price);
            if (!verdict.confirm) {
              this.deps.onActivity?.(tab.id, `gate declined ${side} ${symbol}: ${verdict.reason}`);
              continue;
            }
            this.deps.onActivity?.(tab.id, `gate confirmed ${side} ${symbol}: ${verdict.reason}`);
          }

          const quantity =
            side === "sell" && holding
              ? Math.abs(holding.quantity)
              : sizeOrder(spec.sizing, accountEquity, price);
          if (quantity <= 0) continue;

          this.fileProposal(tab.id, tab.topic, symbol, side, quantity, spec, reason, specHash);
          this.lastFire.set(sigKey, Date.now());
          this.deps.onActivity?.(tab.id, `signal: ${side} ${quantity} ${symbol} — ${reason}`);
          await this.deps.proposals.ingest(tab.id);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private fileProposal(
    tabId: string,
    topic: string,
    symbol: string,
    side: "buy" | "sell",
    quantity: number,
    spec: StrategySpec,
    reason: string,
    strategySpecHash: string,
  ) {
    const dir = this.deps.research.proposalsDir(tabId);
    fs.mkdirSync(dir, { recursive: true });
    const proposal = {
      symbol,
      side,
      quantity,
      orderType: "market",
      limitPrice: null,
      stop: null,
      target: null,
      thesis: `Mechanical strategy "${topic}" fired a ${side} signal. ${spec.notes || ""}`.trim(),
      whyNow: reason,
      confidence: spec.llmGate ? 7 : 6,
      timeHorizon: "per strategy rules",
      strategySpecHash,
    };
    const file = `strat-${symbol}-${side}-${Date.now()}.json`;
    fs.writeFileSync(path.join(dir, file), JSON.stringify(proposal, null, 2));
  }

  private runGate(
    spec: StrategySpec,
    symbol: string,
    side: "buy" | "sell",
    price: number,
  ): Promise<{ confirm: boolean; reason: string }> {
    const prompt = `You are a live risk gate for an automated trading strategy. A mechanical rule just fired a ${side.toUpperCase()} signal for ${symbol} at $${price.toFixed(2)}.
Strategy summary: ${spec.notes || "(none)"}
Confirm the trade ONLY if this holds right now: ${spec.llmGate?.prompt}
You may use web search to check current news. Then respond with ONLY a single-line JSON object and nothing else: {"confirm": true|false, "reason": "<one sentence>"}`;

    return new Promise((resolve) => {
      const bin = process.env.MOOBOT_CLAUDE_BIN || "claude";
      const child = spawn(
        bin,
        [
          "-p",
          prompt,
          "--model",
          LENS_MODEL,
          "--output-format",
          "json",
          "--allowedTools",
          "WebSearch,WebFetch",
          "--disallowedTools",
          "Bash,Write,Edit",
          "--permission-mode",
          "default",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      let done = false;
      const finish = (v: { confirm: boolean; reason: string }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
        resolve(v);
      };
      const timer = setTimeout(() => finish({ confirm: false, reason: "gate timed out" }), GATE_TIMEOUT_MS);
      child.stdout.on("data", (d) => (out += d.toString()));
      child.on("error", () => finish({ confirm: false, reason: "gate unavailable" }));
      child.on("close", () => {
        const verdict = parseVerdict(out);
        finish(verdict ?? { confirm: false, reason: "gate response unparseable" });
      });
    });
  }
}

function parseVerdict(stdout: string): { confirm: boolean; reason: string } | null {
  // Unwrap the claude CLI `--output-format json` envelope to the reply text.
  // CLI >= ~2.1 returns an ARRAY of message objects; the reply is the `result`
  // field of the element whose type === "result". Older CLIs return a single
  // `{ result }` object. If neither shape is present, scan the raw text.
  let text = stdout;
  try {
    const env = JSON.parse(stdout);
    if (Array.isArray(env)) {
      const r = env.find((m) => m && m.type === "result" && typeof m.result === "string");
      if (r) text = r.result;
    } else if (env && typeof env.result === "string") {
      text = env.result;
    }
  } catch {
    /* not JSON — search the raw text */
  }
  return extractVerdict(text);
}

/** Pull a {confirm, reason} object out of model reply text — whether the whole
 * string is the JSON object or it's embedded in surrounding prose. */
function extractVerdict(text: string): { confirm: boolean; reason: string } | null {
  const coerce = (s: string): { confirm: boolean; reason: string } | null => {
    try {
      const o = JSON.parse(s);
      if (o && typeof o === "object" && "confirm" in o) {
        return { confirm: o.confirm === true, reason: String(o.reason ?? "") };
      }
    } catch {
      /* not parseable */
    }
    return null;
  };
  const whole = coerce(text.trim());
  if (whole) return whole;
  const match = text.match(/\{[^{}]*"confirm"[^{}]*\}/);
  if (match) {
    const embedded = coerce(match[0]);
    if (embedded) return embedded;
  }
  return null;
}
