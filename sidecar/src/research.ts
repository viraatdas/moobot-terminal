import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  RESEARCH_DIR,
  RESEARCH_ALLOWED_TOOLS,
  RESEARCH_DISALLOWED_TOOLS,
} from "./config.ts";

export interface ResearchTab {
  id: string;
  topic: string;
  /** Extra guidance: sources to favor, angle, constraints. */
  notes: string;
  intervalMinutes: number; // 0 = manual only
  paused: boolean;
  createdAt: string;
  lastRunAt: string | null;
  lastRunStatus: "idle" | "running" | "ok" | "error";
  lastError: string | null;
  sessionId: string | null;
  runCount: number;
}

export interface ResearchEvent {
  tabId: string;
  kind: "run-started" | "activity" | "run-finished" | "run-error" | "findings-updated";
  text?: string;
}

const FIRST_RUN_PROMPT = (tab: ResearchTab) => `You are a research analyst inside Moobot Terminal, a personal trading terminal. Your working directory is your dedicated workspace for this research topic.

RESEARCH TOPIC: ${tab.topic}
${tab.notes ? `OPERATOR NOTES: ${tab.notes}` : ""}

Your job, every run:
1. Research the topic using web search, web fetch (news, SEC EDGAR at https://efts.sec.gov/LATEST/search-index?q= and https://www.sec.gov/cgi-bin/browse-edgar, company IR pages), and Robinhood market data tools (quotes, search).
2. Maintain ./findings.md as a LIVING DOCUMENT — not a log. Structure: "## Thesis" (current view, updated each run), "## Key Signals" (dated bullets, newest first, prune stale ones), "## Risks", "## Watch Next" (what to check next run). Keep it under ~200 lines; rewrite rather than append.
3. Maintain ./state.json with {"sentiment": "bullish"|"bearish"|"neutral", "conviction": 1-10, "headline": "<one-line current take>", "updatedAt": "<iso date>"}.
4. ONLY if the evidence this run materially supports a trade, write a proposal file ./proposals/<short-slug>.json with: {"symbol": "...", "side": "buy"|"sell", "quantity": <number>, "orderType": "market"|"limit", "limitPrice": <number or null>, "thesis": "<3-5 sentences citing the specific evidence>", "confidence": 1-10, "timeHorizon": "<e.g. 2 weeks>"}. Most runs should NOT produce a proposal. You cannot place orders; a human reviews every proposal.

Be concrete: numbers, dates, filings, price levels. No filler. Do the first research pass now.`;

const LOOP_PROMPT = `New research iteration. Re-check the topic: what changed since last run (news, filings, price action, sentiment)? Update ./findings.md and ./state.json per your standing instructions. Only write a proposal file if evidence materially supports a trade now.`;

interface RunningProc {
  child: ChildProcess;
}

export class ResearchManager {
  private tabs = new Map<string, ResearchTab>();
  private running = new Map<string, RunningProc>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  onEvent?: (ev: ResearchEvent) => void;
  onProposalsMaybeChanged?: (tabId: string) => void;

  constructor() {
    this.loadAll();
    for (const tab of this.tabs.values()) this.schedule(tab);
  }

  private tabDir(id: string) {
    return path.join(RESEARCH_DIR, id);
  }

  private configPath(id: string) {
    return path.join(this.tabDir(id), "tab.json");
  }

  private loadAll() {
    if (!fs.existsSync(RESEARCH_DIR)) return;
    for (const entry of fs.readdirSync(RESEARCH_DIR)) {
      try {
        const tab = JSON.parse(
          fs.readFileSync(this.configPath(entry), "utf8"),
        ) as ResearchTab;
        if (tab.lastRunStatus === "running") tab.lastRunStatus = "idle";
        this.tabs.set(tab.id, tab);
      } catch {
        // not a tab dir; skip
      }
    }
  }

  private persist(tab: ResearchTab) {
    fs.mkdirSync(this.tabDir(tab.id), { recursive: true });
    fs.writeFileSync(this.configPath(tab.id), JSON.stringify(tab, null, 2));
  }

  list(): ResearchTab[] {
    return [...this.tabs.values()].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  get(id: string): ResearchTab | undefined {
    return this.tabs.get(id);
  }

  findings(id: string): { markdown: string; state: unknown } {
    const dir = this.tabDir(id);
    let markdown = "";
    let state: unknown = null;
    try {
      markdown = fs.readFileSync(path.join(dir, "findings.md"), "utf8");
    } catch {}
    try {
      state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    } catch {}
    return { markdown, state };
  }

  create(topic: string, notes = "", intervalMinutes = 30): ResearchTab {
    const tab: ResearchTab = {
      id: crypto.randomUUID().slice(0, 8),
      topic,
      notes,
      intervalMinutes,
      paused: false,
      createdAt: new Date().toISOString(),
      lastRunAt: null,
      lastRunStatus: "idle",
      lastError: null,
      sessionId: null,
      runCount: 0,
    };
    fs.mkdirSync(path.join(this.tabDir(tab.id), "proposals"), { recursive: true });
    this.tabs.set(tab.id, tab);
    this.persist(tab);
    this.schedule(tab);
    void this.run(tab.id);
    return tab;
  }

  update(id: string, patch: Partial<Pick<ResearchTab, "topic" | "notes" | "intervalMinutes" | "paused">>) {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error(`No research tab ${id}`);
    Object.assign(tab, patch);
    this.persist(tab);
    this.schedule(tab);
    return tab;
  }

  remove(id: string) {
    const proc = this.running.get(id);
    proc?.child.kill("SIGTERM");
    this.running.delete(id);
    const timer = this.timers.get(id);
    if (timer) clearInterval(timer);
    this.timers.delete(id);
    this.tabs.delete(id);
    fs.rmSync(this.tabDir(id), { recursive: true, force: true });
  }

  private schedule(tab: ResearchTab) {
    const existing = this.timers.get(tab.id);
    if (existing) clearInterval(existing);
    if (tab.paused || tab.intervalMinutes <= 0) return;
    const timer = setInterval(
      () => void this.run(tab.id),
      tab.intervalMinutes * 60 * 1000,
    );
    this.timers.set(tab.id, timer);
  }

  async run(id: string): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error(`No research tab ${id}`);
    if (this.running.has(id)) return; // already running

    tab.lastRunStatus = "running";
    tab.lastRunAt = new Date().toISOString();
    this.persist(tab);
    this.onEvent?.({ tabId: id, kind: "run-started" });

    const isFirst = tab.sessionId === null;
    const prompt = isFirst ? FIRST_RUN_PROMPT(tab) : LOOP_PROMPT;
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--allowedTools",
      RESEARCH_ALLOWED_TOOLS.join(","),
      "--disallowedTools",
      RESEARCH_DISALLOWED_TOOLS.join(","),
      "--permission-mode",
      "acceptEdits",
    ];
    if (tab.sessionId) args.push("--resume", tab.sessionId);

    const child = spawn("claude", args, {
      cwd: this.tabDir(id),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.running.set(id, { child });

    let stderr = "";
    child.stderr!.on("data", (d) => (stderr += d.toString()));

    let buffer = "";
    child.stdout!.on("data", (chunk) => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          this.handleStreamEvent(tab, JSON.parse(line));
        } catch {}
      }
    });

    await new Promise<void>((resolve) => {
      child.on("close", (code) => {
        this.running.delete(id);
        tab.runCount += 1;
        if (code === 0) {
          tab.lastRunStatus = "ok";
          tab.lastError = null;
        } else {
          tab.lastRunStatus = "error";
          tab.lastError = stderr.slice(-2000) || `claude exited with code ${code}`;
          this.onEvent?.({ tabId: id, kind: "run-error", text: tab.lastError });
        }
        this.persist(tab);
        this.onEvent?.({ tabId: id, kind: "run-finished" });
        this.onEvent?.({ tabId: id, kind: "findings-updated" });
        this.onProposalsMaybeChanged?.(id);
        resolve();
      });
    });
  }

  private handleStreamEvent(tab: ResearchTab, ev: any) {
    if (ev.type === "system" && ev.subtype === "init" && ev.session_id) {
      tab.sessionId = ev.session_id;
      this.persist(tab);
      return;
    }
    if (ev.type === "assistant") {
      const blocks = ev.message?.content ?? [];
      for (const b of blocks) {
        if (b.type === "text" && b.text?.trim()) {
          this.onEvent?.({
            tabId: tab.id,
            kind: "activity",
            text: b.text.trim().slice(0, 500),
          });
        } else if (b.type === "tool_use") {
          const detail =
            b.name === "WebSearch"
              ? `searching: ${b.input?.query ?? ""}`
              : b.name === "WebFetch"
                ? `reading: ${b.input?.url ?? ""}`
                : b.name === "Write" || b.name === "Edit"
                  ? `updating ${path.basename(b.input?.file_path ?? "file")}`
                  : b.name;
          this.onEvent?.({ tabId: tab.id, kind: "activity", text: detail });
        }
      }
    }
  }

  /** Directory a tab's agent writes proposal JSON files into. */
  proposalsDir(id: string) {
    return path.join(this.tabDir(id), "proposals");
  }

  stopAll() {
    for (const { child } of this.running.values()) child.kill("SIGTERM");
    for (const t of this.timers.values()) clearInterval(t);
  }
}
