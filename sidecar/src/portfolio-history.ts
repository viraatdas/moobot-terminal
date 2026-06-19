import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.ts";
import { writeJsonFileAtomic } from "./json-store.ts";

export interface PortfolioHistoryPoint {
  time: number;
  equity: number;
  cash: number;
  invested: number;
  asOf: number;
}

export interface PortfolioDayPerformance {
  dayPnl: number;
  dayPnlPercent: number;
  dayStartEquity: number;
  dayStartAt: number;
}

export interface PortfolioHistoryResponse {
  accountNumber: string;
  range: string;
  source: "local";
  stale: boolean;
  asOf: number;
  warning?: string | null;
  points: PortfolioHistoryPoint[];
}

interface PortfolioHistoryFile {
  version: 1;
  accounts: Record<string, PortfolioHistoryPoint[]>;
}

const PORTFOLIO_HISTORY_FILE = path.join(DATA_DIR, "portfolio-history.json");
const MAX_POINTS_PER_ACCOUNT = 8000;
const KEEP_DAYS_MS = 400 * 24 * 60 * 60 * 1000;

function finiteNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeAccount(value: unknown): string {
  const account = String(value ?? "").trim();
  if (!account) throw new Error("Account number is required");
  return account;
}

function rangeKey(range: unknown): string {
  return String(range ?? "1d").trim().toLowerCase();
}

function msRangeToRange(range: unknown): string {
  const key = rangeKey(range);
  return new Set(["1d", "5d", "1mo", "3mo", "ytd", "1y", "max"]).has(key) ? key : "1d";
}

function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfRange(nowMs: number, range: string): number {
  const ms = Number(nowMs);
  const day = 24 * 60 * 60 * 1000;
  const year = new Date(nowMs).getFullYear();

  if (range === "ytd") return new Date(year, 0, 1).getTime();
  if (range === "1y") return ms - 365 * day;
  if (range === "3mo") return ms - 90 * day;
  if (range === "1mo") return ms - 30 * day;
  if (range === "5d") return ms - 5 * day;
  if (range === "1d") return startOfLocalDay(ms);
  return 0;
}

export class PortfolioHistoryService {
  private read(): PortfolioHistoryFile {
    try {
      const raw = JSON.parse(fs.readFileSync(PORTFOLIO_HISTORY_FILE, "utf8"));
      const accounts = (raw as PortfolioHistoryFile).accounts;
      const cleaned: Record<string, PortfolioHistoryPoint[]> = {};
      if (accounts && typeof accounts === "object") {
        for (const [key, rawPoints] of Object.entries(accounts)) {
          const points = Array.isArray(rawPoints)
            ? rawPoints
                .filter(
                  (point: unknown): point is PortfolioHistoryPoint =>
                    Boolean(point) &&
                    typeof (point as PortfolioHistoryPoint).time === "number" &&
                    Number.isFinite((point as PortfolioHistoryPoint).time),
                )
                .map((point) => ({
                  time: finiteNumber((point as PortfolioHistoryPoint).time),
                  equity: finiteNumber((point as PortfolioHistoryPoint).equity),
                  cash: finiteNumber((point as PortfolioHistoryPoint).cash),
                  invested: finiteNumber((point as PortfolioHistoryPoint).invested),
                  asOf: finiteNumber((point as PortfolioHistoryPoint).asOf),
                }))
                .filter(
                  (point) => Number.isFinite(point.equity) && Number.isFinite(point.cash) && Number.isFinite(point.invested),
                )
            : [];
          cleaned[key] = points.sort((a, b) => a.time - b.time);
        }
      }
      return { version: 1, accounts: cleaned };
    } catch {
      return { version: 1, accounts: {} };
    }
  }

  private write(file: PortfolioHistoryFile) {
    writeJsonFileAtomic(PORTFOLIO_HISTORY_FILE, file);
  }

  private prune(points: PortfolioHistoryPoint[], now: number): PortfolioHistoryPoint[] {
    const minTime = now - KEEP_DAYS_MS;
    const pruned = points
      .filter((point) => point.time >= minTime)
      .sort((a, b) => a.time - b.time)
      .slice(-MAX_POINTS_PER_ACCOUNT);
    return pruned;
  }

  private resolveAccount(file: PortfolioHistoryFile, accountNumber?: string): string | null {
    if (accountNumber && file.accounts[accountNumber]?.length) return accountNumber;
    const entries = Object.entries(file.accounts)
      .map(([account, points]) => ({ account, lastPointTime: points.at(-1)?.time ?? 0 }))
      .filter((entry) => Number.isFinite(entry.lastPointTime) && entry.lastPointTime > 0)
      .sort((a, b) => b.lastPointTime - a.lastPointTime);
    return entries[0]?.account ?? null;
  }

  record(accountNumber: unknown, point: { time?: number; equity: number; cash: number; invested: number; asOf: number }) {
    const account = normalizeAccount(accountNumber);
    const now = Date.now();
    const snapshot: PortfolioHistoryPoint = {
      time: finiteNumber(point.time, now),
      equity: finiteNumber(point.equity),
      cash: finiteNumber(point.cash),
      invested: finiteNumber(point.invested),
      asOf: finiteNumber(point.asOf),
    };
    if (!Number.isFinite(snapshot.equity)) return;
    if (!Number.isFinite(snapshot.time)) return;

    const file = this.read();
    const points = file.accounts[account] ?? [];
    const last = points.at(-1);
    if (
      !last ||
      Math.abs(last.time - snapshot.time) > 45_000 ||
      last.equity !== snapshot.equity ||
      last.cash !== snapshot.cash ||
      last.invested !== snapshot.invested
    ) {
      points.push(snapshot);
    } else {
      points[points.length - 1] = snapshot;
    }
    file.accounts[account] = this.prune(points, now);
    this.write(file);
  }

  dayPerformance(
    accountNumber: unknown,
    equityNow: number,
    asOfMs?: number,
  ): PortfolioDayPerformance | null {
    const account = normalizeAccount(accountNumber);
    const file = this.read();
    const points = file.accounts[account];
    if (!points?.length) return null;
    const now = Number(asOfMs ?? Date.now());
    const dayStart = startOfLocalDay(now);
    const dayPoints = points.filter((point) => point.time >= dayStart && point.time <= now);
    const baseline = dayPoints[0];
    if (!baseline) return null;
    const dayPnl = finiteNumber(equityNow) - baseline.equity;
    return {
      dayPnl,
      dayPnlPercent: baseline.equity > 0 ? (dayPnl / baseline.equity) * 100 : 0,
      dayStartEquity: baseline.equity,
      dayStartAt: baseline.time,
    };
  }

  history(
    accountNumber: unknown,
    opts: { range?: unknown } = {},
  ): PortfolioHistoryResponse {
    const file = this.read();
    const target = this.resolveAccount(file, accountNumber ? String(accountNumber) : undefined);
    if (!target) {
      return {
        accountNumber: "",
        range: msRangeToRange(opts.range),
        source: "local",
        stale: false,
        asOf: Date.now(),
        warning: "No account history yet.",
        points: [],
      };
    }

    const range = msRangeToRange(opts.range);
    const now = Date.now();
    const allPoints = file.accounts[target] ?? [];
    const minTime = startOfRange(now, range);
    let points = minTime > 0 ? allPoints.filter((point) => point.time >= minTime) : [...allPoints];
    if (!points.length && allPoints.length) {
      const last = allPoints.at(-1);
      if (last) points = [last];
    }
    const last = points.at(-1)?.time;
    const stale = last ? now - last > 90_000 : false;
    const warning =
      points.length === 0
        ? allPoints.length > 0
          ? "No points yet in this range."
          : "No account history yet."
        : null;

    return {
      accountNumber: target,
      range,
      source: "local",
      stale,
      asOf: now,
      warning,
      points,
    };
  }
}
