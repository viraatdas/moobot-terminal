/**
 * Prediction-market data (Polymarket + Kalshi). Both expose public read APIs, so
 * this is a thin structured fetcher — cleaner than having a lens scrape HTML. It
 * gives research/strategy lenses event-probability signals (elections, macro
 * prints, approvals, geopolitics) to weave into a thesis alongside price data.
 *
 * Read-only and unauthenticated; trading these venues is out of scope.
 */
export interface PredictionMarket {
  source: "polymarket" | "kalshi";
  id: string;
  question: string;
  /** Probability (0..1) of the YES / top outcome. */
  probability: number | null;
  outcomes: { name: string; probability: number }[];
  volume: number | null;
  closeTime: string | null;
  url: string | null;
}

export interface PredictionSearchResult {
  query: string;
  markets: PredictionMarket[];
  sources: { polymarket: "ok" | "error"; kalshi: "ok" | "error" };
  updatedAt: string;
}

const TTL_MS = 5 * 60_000;
const UA = "moobot-terminal/0.2";

function finite(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// Relevance = how many query words appear in the question. 0 means no match.
// (An all-words requirement was too strict: "fed rate" missed "Fed decision…".)
function matchScore(question: string, words: string[]): number {
  if (words.length === 0) return 1;
  const q = question.toLowerCase();
  return words.reduce((n, w) => n + (q.includes(w) ? 1 : 0), 0);
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { "User-Agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export class PredictionMarkets {
  private cache = new Map<string, { at: number; data: PredictionSearchResult }>();

  async search(rawQuery: unknown, limit = 12): Promise<PredictionSearchResult> {
    const query = String(rawQuery ?? "").trim();
    const key = `${query.toLowerCase()}|${limit}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < TTL_MS) return cached.data;

    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const [pm, ks] = await Promise.allSettled([this.polymarket(words), this.kalshi(words)]);
    const markets: PredictionMarket[] = [];
    if (pm.status === "fulfilled") markets.push(...pm.value);
    if (ks.status === "fulfilled") markets.push(...ks.value);
    markets.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));

    const data: PredictionSearchResult = {
      query,
      markets: markets.slice(0, limit),
      sources: { polymarket: pm.status === "fulfilled" ? "ok" : "error", kalshi: ks.status === "fulfilled" ? "ok" : "error" },
      updatedAt: new Date().toISOString(),
    };
    this.cache.set(key, { at: Date.now(), data });
    return data;
  }

  private async polymarket(words: string[]): Promise<PredictionMarket[]> {
    // Gamma API — open markets by descending volume; filter client-side.
    const raw = await getJson("https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=250&order=volume&ascending=false");
    const list: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.markets) ? raw.markets : [];
    const out: PredictionMarket[] = [];
    for (const m of list) {
      const question = String(m?.question ?? m?.title ?? "");
      if (!question || (words.length && matchScore(question, words) === 0)) continue;
      let names: string[] = [];
      let prices: number[] = [];
      try {
        names = typeof m.outcomes === "string" ? JSON.parse(m.outcomes) : Array.isArray(m.outcomes) ? m.outcomes : [];
        const p = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
        prices = Array.isArray(p) ? p.map((x: unknown) => Number(x)) : [];
      } catch {
        /* leave empty */
      }
      const outcomes = names.map((name, i) => ({ name: String(name), probability: finite(prices[i]) ?? 0 }));
      out.push({
        source: "polymarket",
        id: String(m?.id ?? m?.conditionId ?? m?.slug ?? question),
        question,
        probability: outcomes.length ? outcomes[0].probability : null,
        outcomes,
        volume: finite(m?.volume) ?? finite(m?.volumeNum),
        closeTime: typeof m?.endDate === "string" ? m.endDate : null,
        url: m?.slug ? `https://polymarket.com/market/${m.slug}` : null,
      });
    }
    return out;
  }

  private async kalshi(words: string[]): Promise<PredictionMarket[]> {
    const raw = await getJson("https://api.elections.kalshi.com/trade-api/v2/markets?status=open&limit=500");
    const list: any[] = Array.isArray(raw?.markets) ? raw.markets : [];
    const out: PredictionMarket[] = [];
    for (const m of list) {
      const question = String(m?.title ?? m?.subtitle ?? "");
      if (!question || (words.length && matchScore(question, words) === 0)) continue;
      // Kalshi prices are in cents (1..99). Prefer last trade, else bid/ask mid.
      const last = finite(m?.last_price);
      const bid = finite(m?.yes_bid);
      const ask = finite(m?.yes_ask);
      const cents = last ?? (bid != null && ask != null ? (bid + ask) / 2 : bid ?? ask);
      const prob = cents == null ? null : Math.max(0, Math.min(1, cents / 100));
      out.push({
        source: "kalshi",
        id: String(m?.ticker ?? question),
        question,
        probability: prob,
        outcomes: prob == null ? [] : [{ name: "Yes", probability: prob }, { name: "No", probability: 1 - prob }],
        volume: finite(m?.volume),
        closeTime: typeof m?.close_time === "string" ? m.close_time : null,
        url: m?.ticker ? `https://kalshi.com/markets/${String(m.ticker).split("-")[0].toLowerCase()}` : null,
      });
    }
    return out;
  }
}
