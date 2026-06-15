// SEC / EDGAR filings subsystem: ticker→CIK resolution, submissions fetch, filing
// classification, and the cached per-symbol filing/news event builders. Extracted
// from market-events.ts (which only builds option-expiry events) so the expiry
// logic isn't buried behind a self-contained HTTP client. market-events.ts calls
// the one exported entry point, secFilingsAndNews().
import type { MarketEvent, MarketEventSeverity } from "./market-events.ts";

const SEC_COMPANY_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const SEC_SUBMISSIONS_PREFIX = "https://data.sec.gov/submissions/CIK";
const SEC_USER_AGENT = "MoobotTerminal/0.1 (+https://github.com/viraatdas/moobot-terminal; moobot@viraat.dev)";
const SEC_DATA_TTL_MS = 10 * 60 * 1000;
const SEC_REQUEST_TIMEOUT_MS = 7000;
const SEC_MAX_SYMBOLS = 10;

const SEC_NEWS_FORMS = new Set([
  "8-K",
  "8-K/A",
  "6-K",
  "6-K/A",
  "S-1",
  "S-1/A",
  "S-3",
  "S-3/A",
  "424B",
  "424B-1",
  "424B-2",
  "424B-3",
  "424B-4",
  "424B-5",
]);

// Classify a normalized form once: its severity AND whether it is news-grade. This
// folds the previously-disconnected filingSeverity if-chain and SEC_NEWS_FORMS set
// into ONE function (callers no longer decide the two halves in separate places).
// Behavior is preserved EXACTLY — severity stays prefix-based, news stays exact-set
// membership — so existing classifications (incl. S-3→low and the 424B dash quirk)
// are unchanged; fix those deliberately here if ever desired.
function classifyForm(form: string): { severity: MarketEventSeverity; news: boolean } {
  let severity: MarketEventSeverity = "low";
  if (form.startsWith("8-K") || form.startsWith("6-K")) severity = "high";
  else if (form === "10-Q" || form === "10-K" || form.startsWith("S-1") || form.startsWith("424B")) severity = "medium";
  return { severity, news: SEC_NEWS_FORMS.has(form) };
}

type SecTickerRow = {
  cik_str?: string | number | null;
  ticker?: unknown;
};

type SecRecentFilings = {
  accessionNumber?: unknown[];
  filingDate?: unknown[];
  form?: unknown[];
  primaryDocument?: unknown[];
  reportDate?: unknown[];
  primaryDocumentDescription?: unknown[];
};

type SecSubmissionsResponse = {
  cik?: string;
  filings?: {
    recent?: SecRecentFilings;
  };
};

interface SecFilingEventSource {
  symbol: string;
  cik: string;
  form: string;
  filingDate: string;
  accessionNumber: string;
  primaryDocument: string;
  primaryDocumentDescription: string;
  reportDate: string;
  severity: MarketEventSeverity;
}

interface CachedSymbolFilings {
  expiresAt: number;
  filings: MarketEvent[];
  news: MarketEvent[];
}

let tickerMapCache: { expiresAt: number; map: Map<string, string> } | null = null;
let tickerMapPromise: Promise<Map<string, string>> | null = null;
const filingCache = new Map<string, CachedSymbolFilings>();

function coerceString(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const next = coerceString(item);
    return next ? next : "";
  });
}

function normalizeForm(form: string): string {
  return form.toUpperCase().replace(/\s+/g, " ").trim();
}

function toIsoDate(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00.000Z`;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function filingUrl(cik: string, accessionNumber: string, primaryDocument?: string): string {
  const plainCik = String(Number(cik));
  const noDash = accessionNumber.replace(/-/g, "");
  if (primaryDocument) {
    return `https://www.sec.gov/ixviewer/?doc=/Archives/edgar/data/${plainCik}/${noDash}/${primaryDocument}`;
  }
  return `https://www.sec.gov/Archives/edgar/data/${plainCik}/${noDash}/${accessionNumber}-index.htm`;
}

function collectFilingsFromSubmissions(
  symbol: string,
  cik: string,
  submissions: SecSubmissionsResponse,
  windowDays: number,
): SecFilingEventSource[] {
  const recent = submissions?.filings?.recent;
  if (!recent || typeof recent !== "object") return [];

  const forms = toStringArray(recent.form);
  const filingDates = toStringArray(recent.filingDate);
  const accessions = toStringArray(recent.accessionNumber);
  const primaryDocuments = toStringArray(recent.primaryDocument);
  const reportDates = toStringArray(recent.reportDate);
  const descriptions = toStringArray(recent.primaryDocumentDescription);

  const limit = Math.min(forms.length, filingDates.length, accessions.length);
  const cutoff = Date.now() - Math.max(1, windowDays) * 24 * 60 * 60 * 1000;

  const parsed: SecFilingEventSource[] = [];
  for (let i = 0; i < limit; i += 1) {
    const form = normalizeForm(forms[i]);
    const filingDate = coerceString(filingDates[i]);
    const filingMs = Date.parse(filingDate);
    if (!form || !filingDate || !Number.isFinite(filingMs)) continue;
    if (filingMs < cutoff) continue;
    const accessionNumber = coerceString(accessions[i]);
    if (!accessionNumber) continue;
    parsed.push({
      symbol,
      cik,
      form,
      filingDate,
      accessionNumber,
      primaryDocument: coerceString(primaryDocuments[i]),
      reportDate: coerceString(reportDates[i]),
      primaryDocumentDescription: coerceString(descriptions[i]) || "SEC filing detail",
      severity: classifyForm(form).severity,
    });
  }

  return parsed.sort((a, b) => b.filingDate.localeCompare(a.filingDate));
}

function createEventFromSource(base: SecFilingEventSource, type: "filing" | "news"): MarketEvent {
  return {
    id: `${type}:${base.symbol}:${base.accessionNumber}:${base.form}`,
    type,
    severity: base.severity,
    title: `${base.symbol} ${base.form} filed`,
    detail: base.primaryDocument
      ? `${base.form} filed ${base.filingDate} · ${base.primaryDocumentDescription} (${base.primaryDocument}).`
      : `${base.form} filed ${base.filingDate}.`,
    symbols: [base.symbol],
    at: toIsoDate(base.filingDate),
    source: "SEC EDGAR",
    url: filingUrl(base.cik, base.accessionNumber, base.primaryDocument),
    details: {
      filingDate: base.filingDate,
      reportDate: base.reportDate,
      accessionNumber: base.accessionNumber,
      form: base.form,
    },
  };
}

function tickerMapFromPayload(payload: Record<string, unknown>): Map<string, string> {
  const map = new Map<string, string>();

  if (Array.isArray(payload.data) && Array.isArray(payload.fields)) {
    const rows = payload.data as unknown[];
    const fields = payload.fields as unknown[];
    const tickerIndex = fields.findIndex((item) => String(item).toLowerCase() === "ticker");
    const cikIndex = fields.findIndex((item) => String(item).toLowerCase().includes("cik"));
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      const ticker = coerceString(row[tickerIndex]);
      const cik = coerceString(row[cikIndex]);
      if (ticker && cik) {
        map.set(ticker.toUpperCase(), cik.padStart(10, "0"));
      }
    }
  }

  for (const value of Object.values(payload)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as SecTickerRow;
    const ticker = coerceString(row.ticker);
    if (!ticker) continue;
    const rawCik = coerceString(row.cik_str ?? (row as Record<string, unknown>).cik);
    if (!rawCik) continue;
    map.set(ticker.toUpperCase(), rawCik.padStart(10, "0"));
  }

  return map;
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEC_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": SEC_USER_AGENT,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`SEC request failed (${response.status})`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function getTickerMap(): Promise<Map<string, string>> {
  const now = Date.now();
  if (tickerMapCache && tickerMapCache.expiresAt > now) return tickerMapCache.map;
  if (!tickerMapPromise) {
    tickerMapPromise = (async () => {
      try {
        const payload = await fetchJson<Record<string, unknown>>(SEC_COMPANY_TICKERS_URL);
        return tickerMapFromPayload(payload);
      } catch {
        return new Map<string, string>();
      }
    })();
  }
  const map = await tickerMapPromise;
  tickerMapPromise = null;
  tickerMapCache = { map, expiresAt: now + SEC_DATA_TTL_MS };
  return map;
}

async function resolveCik(symbol: string): Promise<string | null> {
  const map = await getTickerMap();
  const direct = map.get(symbol);
  if (direct) return direct;
  const compact = symbol.replace(/[^A-Z0-9]/g, "");
  if (compact !== symbol) return map.get(compact) ?? null;
  return null;
}

async function filingsForSymbol(
  symbol: string,
  windowDays: number,
): Promise<{ filings: MarketEvent[]; news: MarketEvent[] }> {
  const cached = filingCache.get(symbol);
  if (cached && cached.expiresAt > Date.now()) {
    return { filings: cached.filings, news: cached.news };
  }

  const cik = await resolveCik(symbol);
  if (!cik) return { filings: [], news: [] };
  try {
    const filings = await fetchJson<SecSubmissionsResponse>(`${SEC_SUBMISSIONS_PREFIX}${cik}.json`);
    const parsed = collectFilingsFromSubmissions(symbol, cik, filings, windowDays);
    const seenFiling = new Set<string>();
    const seenNews = new Set<string>();
    const filingEvents: MarketEvent[] = [];
    const newsEvents: MarketEvent[] = [];
    for (const item of parsed.slice(0, 30)) {
      const filingEvent = createEventFromSource(item, "filing");
      if (!seenFiling.has(filingEvent.id)) {
        seenFiling.add(filingEvent.id);
        filingEvents.push(filingEvent);
      }
      if (classifyForm(item.form).news) {
        const newsEvent = createEventFromSource(item, "news");
        if (!seenNews.has(newsEvent.id)) {
          seenNews.add(newsEvent.id);
          newsEvents.push(newsEvent);
        }
      }
    }
    const cachedValue = {
      expiresAt: Date.now() + SEC_DATA_TTL_MS,
      filings: filingEvents,
      news: newsEvents,
    };
    filingCache.set(symbol, cachedValue);
    return { filings: cachedValue.filings, news: cachedValue.news };
  } catch {
    return { filings: [], news: [] };
  }
}

/** Resolve recent SEC filings + news-grade filings for a set of symbols, deduped
 * and capped. The single entry point market-events.ts calls. */
export async function secFilingsAndNews(
  symbols: string[],
  windowDays: number,
): Promise<{ filings: MarketEvent[]; news: MarketEvent[] }> {
  const targetSymbols = symbols.slice(0, SEC_MAX_SYMBOLS);
  const settled = await Promise.allSettled(
    targetSymbols.map((symbol) => filingsForSymbol(symbol, windowDays)),
  );

  const filingEvents: MarketEvent[] = [];
  const newsEvents: MarketEvent[] = [];
  const filingIds = new Set<string>();
  const newsIds = new Set<string>();

  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const row of result.value.filings) {
      if (filingIds.has(row.id)) continue;
      filingIds.add(row.id);
      filingEvents.push(row);
    }
    for (const row of result.value.news) {
      if (newsIds.has(row.id)) continue;
      newsIds.add(row.id);
      newsEvents.push(row);
    }
  }

  return {
    filings: filingEvents.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8),
    news: newsEvents.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8),
  };
}
