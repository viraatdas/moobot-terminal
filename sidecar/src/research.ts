import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  RESEARCH_DIR,
  RESEARCH_ALLOWED_TOOLS,
  RESEARCH_DISALLOWED_TOOLS,
} from "./config.ts";
import type { PluginManager } from "./plugins.ts";

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
  private plugins: PluginManager;
  onEvent?: (ev: ResearchEvent) => void;
  onProposalsMaybeChanged?: (tabId: string) => void;

  constructor(plugins: PluginManager) {
    this.plugins = plugins;
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

  findings(id: string): {
    markdown: string;
    state: unknown;
    panels: Array<{ plugin: string; title: string; items: unknown[] }>;
  } {
    const dir = this.tabDir(id);
    let markdown = "";
    let state: unknown = null;
    try {
      markdown = fs.readFileSync(path.join(dir, "findings.md"), "utf8");
    } catch {}
    try {
      state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    } catch {}
    const panels: Array<{ plugin: string; title: string; items: unknown[] }> = [];
    const manifests = new Map(this.plugins.list().map((p) => [p.name, p]));
    try {
      for (const file of fs.readdirSync(path.join(dir, "panels"))) {
        if (!file.endsWith(".json")) continue;
        const name = file.replace(/\.json$/, "");
        try {
          const items = JSON.parse(
            fs.readFileSync(path.join(dir, "panels", file), "utf8"),
          );
          if (!Array.isArray(items)) continue;
          panels.push({
            plugin: name,
            title: manifests.get(name)?.panel?.title ?? name,
            items: items.slice(0, 8),
          });
        } catch {}
      }
    } catch {}
    return { markdown, state, panels };
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
    const prompt =
      (isFirst ? FIRST_RUN_PROMPT(tab) : LOOP_PROMPT) + this.plugins.promptFragment();
    const allowedTools = [
      ...new Set([...RESEARCH_ALLOWED_TOOLS, ...this.plugins.extraAllowedTools()]),
    ];
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--allowedTools",
      allowedTools.join(","),
      "--disallowedTools",
      RESEARCH_DISALLOWED_TOOLS.join(","),
      "--permission-mode",
      "acceptEdits",
    ];
    if (tab.sessionId) args.push("--resume", tab.sessionId);

    this.onEvent?.({ tabId: id, kind: "activity", text: "starting research agent…" });

    const child = spawn(this.claudeBin(), args, {
      cwd: this.tabDir(id),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.running.set(id, { child });

    let stderr = "";
    let gotOutput = false;
    let settled = false;
    child.stderr!.on("data", (d) => (stderr += d.toString()));

    let buffer = "";
    child.stdout!.on("data", (chunk) => {
      gotOutput = true;
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
      const finish = (status: "ok" | "error", error: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimer);
        clearTimeout(maxTimer);
        this.running.delete(id);
        tab.runCount += 1;
        tab.lastRunStatus = status;
        tab.lastError = error;
        if (status === "error") {
          this.onEvent?.({ tabId: id, kind: "run-error", text: error ?? "unknown error" });
        }
        this.persist(tab);
        this.onEvent?.({ tabId: id, kind: "run-finished" });
        this.onEvent?.({ tabId: id, kind: "findings-updated" });
        this.onProposalsMaybeChanged?.(id);
        resolve();
      };

      // Spawn failure (e.g. claude not found) emits 'error', not 'close'.
      child.on("error", (err) => {
        finish("error", `failed to launch claude: ${err.message}`);
      });

      // Watchdog: kill if the agent never streams, or runs too long.
      const startupTimer = setTimeout(() => {
        if (!gotOutput && !settled) {
          child.kill("SIGKILL");
          finish(
            "error",
            "agent produced no output within 2 min (claude/MCP startup stalled)",
          );
        }
      }, 120_000);
      const maxTimer = setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
          finish("error", "agent exceeded the 10 min run limit and was stopped");
        }
      }, 600_000);

      child.on("close", (code) => {
        finish(
          code === 0 ? "ok" : "error",
          code === 0 ? null : stderr.slice(-2000) || `claude exited with code ${code}`,
        );
      });
    });
  }

  /** Resolve the claude binary, preferring the known install path. */
  private claudeBin(): string {
    const candidate = path.join(os.homedir(), ".local", "bin", "claude");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      return "claude"; // fall back to PATH lookup
    }
  }

  private handleStreamEvent(tab: ResearchTab, ev: any) {
    // Capture the session id from any event that carries it (the init event is
    // the canonical source, but grabbing it defensively means a slow/odd init
    // never costs us --resume continuity).
    if (ev.session_id && tab.sessionId !== ev.session_id) {
      tab.sessionId = ev.session_id;
      this.persist(tab);
    }
    if (ev.type === "system" && ev.subtype === "init") return;
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
