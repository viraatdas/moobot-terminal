import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  RESEARCH_DIR,
  RESEARCH_ALLOWED_TOOLS,
  RESEARCH_DISALLOWED_TOOLS,
  LENS_MODEL,
  CODEX_MODEL,
} from "./config.ts";
import type { PluginManager } from "./plugins.ts";
import { LENSES, LENS_OUTPUT, type AgentEngine, type LensTab, type LensType } from "./lenses.ts";

// Back-compat alias: tabs are now typed lenses.
export type ResearchTab = LensTab;

export interface ResearchEvent {
  tabId: string;
  kind: "run-started" | "activity" | "run-finished" | "run-error" | "findings-updated";
  text?: string;
}

interface RunningProc {
  child: ChildProcess;
}

export type DeterministicLensRunner = (
  tab: ResearchTab,
) => Promise<Record<string, unknown> | null>;

export class ResearchManager {
  private tabs = new Map<string, ResearchTab>();
  private running = new Map<string, RunningProc>();
  private deterministicRunning = new Set<string>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private plugins: PluginManager;
  private deterministicRunner?: DeterministicLensRunner;
  onEvent?: (ev: ResearchEvent) => void;
  onProposalsMaybeChanged?: (tabId: string) => void;

  constructor(plugins: PluginManager, deterministicRunner?: DeterministicLensRunner) {
    this.plugins = plugins;
    this.deterministicRunner = deterministicRunner;
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
        // Migrate pre-lens tabs.
        if (!tab.type) tab.type = "research";
        if (!tab.engine) tab.engine = "claude";
        if (!tab.refs) tab.refs = [];
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

  /** Raw lens output files (per-type JSON/markdown the UI surface renders). */
  lensData(id: string): Record<string, unknown> {
    const tab = this.tabs.get(id);
    if (!tab) return {};
    const dir = this.tabDir(id);
    const out: Record<string, unknown> = {};
    for (const file of LENS_OUTPUT[tab.type] ?? []) {
      try {
        const raw = fs.readFileSync(path.join(dir, file), "utf8");
        out[file] = file.endsWith(".json") ? JSON.parse(raw) : raw;
      } catch {
        out[file] = null;
      }
    }
    return out;
  }

  findings(id: string): {
    markdown: string;
    state: unknown;
    panels: Array<{ plugin: string; title: string; items: unknown[] }>;
    lens: Record<string, unknown>;
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
    return { markdown, state, panels, lens: this.lensData(id) };
  }

  create(
    topic: string,
    notes = "",
    intervalMinutes = 30,
    type: LensType = "research",
    refs: string[] = [],
    engine: AgentEngine = "claude",
  ): ResearchTab {
    const tab: ResearchTab = {
      id: crypto.randomUUID().slice(0, 8),
      type,
      engine,
      topic,
      notes,
      refs,
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

  update(
    id: string,
    patch: Partial<Pick<ResearchTab, "topic" | "notes" | "intervalMinutes" | "paused" | "refs">>,
  ) {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error(`No research tab ${id}`);
    Object.assign(tab, patch);
    this.persist(tab);
    this.schedule(tab);
    return tab;
  }

  /** Gather referenced tabs' latest outputs into a compact prompt block. */
  private buildRefContext(tab: ResearchTab): string {
    if (!tab.refs?.length) return "";
    const parts: string[] = [];
    for (const refId of tab.refs) {
      const ref = this.tabs.get(refId);
      if (!ref) continue;
      const data = this.lensData(refId);
      let body = "";
      for (const [file, content] of Object.entries(data)) {
        if (content == null) continue;
        const text = typeof content === "string" ? content : JSON.stringify(content);
        body += `\n  [${file}]: ${text.slice(0, 1500)}`;
      }
      parts.push(`### @${ref.topic} (${LENSES[ref.type]?.label ?? ref.type})${body || "\n  (no output yet)"}`);
    }
    return parts.length
      ? `REFERENCED LENSES (their latest analysis):\n${parts.join("\n\n")}`
      : "";
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
    if (this.running.has(id) || this.deterministicRunning.has(id)) return; // already running

    tab.lastRunStatus = "running";
    tab.lastRunAt = new Date().toISOString();
    this.persist(tab);
    this.onEvent?.({ tabId: id, kind: "run-started" });

    if (await this.runDeterministicIfAvailable(tab)) return;

    const isFirst = tab.sessionId === null;
    const def = LENSES[tab.type] ?? LENSES.research;
    const refContext = this.buildRefContext(tab);
    const base = isFirst
      ? def.firstPrompt(tab, refContext)
      : def.loopPrompt(tab, refContext);
    // Plugins (sources) only apply to research-style lenses that browse.
    const prompt =
      tab.type === "research" || tab.type === "trade" || tab.type === "thesis"
        ? base + this.plugins.promptFragment()
        : base;
    const allowedTools = [
      ...new Set([
        ...RESEARCH_ALLOWED_TOOLS,
        ...def.extraTools,
        ...this.plugins.extraAllowedTools(),
      ]),
    ];
    const spec = this.agentSpawnSpec(tab, prompt, allowedTools);

    this.onEvent?.({
      tabId: id,
      kind: "activity",
      text: `starting ${this.engineName(tab.engine)} agent…`,
    });

    const child = spawn(spec.bin, spec.args, {
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

      // Spawn failure (e.g. claude/codex not found) emits 'error', not 'close'.
      child.on("error", (err) => {
        finish("error", `failed to launch ${this.engineName(tab.engine)}: ${err.message}`);
      });

      // Watchdog: kill if the agent never streams, or runs too long.
      const startupTimer = setTimeout(() => {
        if (!gotOutput && !settled) {
          child.kill("SIGKILL");
          finish(
            "error",
            `${this.engineName(tab.engine)} produced no output within 2 min (startup stalled)`,
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
          code === 0 ? null : this.describeAgentExit(tab.engine, code, stderr),
        );
      });
    });
  }

  private agentSpawnSpec(
    tab: ResearchTab,
    prompt: string,
    allowedTools: string[],
  ): { bin: string; args: string[] } {
    if (tab.engine === "codex") {
      const safetyPrompt = `${prompt}

RUNNER SAFETY:
- You are running through Codex inside this tab's workspace.
- Use the local read-only APIs documented above for Robinhood data; do not attempt direct order placement, cancellation, review tools, or WebSocket trading calls.
- Write only the files requested by this lens contract plus proposal JSON files when justified.`;
      const common = [
        "--json",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "--sandbox",
        "workspace-write",
      ];
      if (CODEX_MODEL) common.push("--model", CODEX_MODEL);
      if (tab.sessionId) {
        return {
          bin: this.codexBin(),
          args: ["--search", "exec", "resume", ...common, tab.sessionId, safetyPrompt],
        };
      }
      return {
        bin: this.codexBin(),
        args: ["--search", "exec", ...common, safetyPrompt],
      };
    }

    const args = [
      "-p",
      prompt,
      "--model",
      LENS_MODEL,
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
    return { bin: this.claudeBin(), args };
  }

  private engineName(engine: AgentEngine): string {
    return engine === "codex" ? "Codex" : "Claude Code";
  }

  private describeAgentExit(engine: AgentEngine, code: number | null, stderr: string): string {
    const detail = stderr.trim().slice(-2000);
    const lower = detail.toLowerCase();
    if (lower.includes("rate limit") || lower.includes("spend limit") || lower.includes("quota")) {
      return `${this.engineName(engine)} quota/rate limit hit. Open ${engine === "codex" ? "Codex" : "Claude Code"} in Terminal to resolve it, then rerun this lens.${detail ? `\n\n${detail}` : ""}`;
    }
    if (lower.includes("login") || lower.includes("auth") || lower.includes("unauthorized")) {
      const command = engine === "codex" ? "codex login" : "claude";
      return `${this.engineName(engine)} needs authentication. Run \`${command}\` in Terminal, finish login, then rerun this lens.${detail ? `\n\n${detail}` : ""}`;
    }
    const command = engine === "codex" ? "codex doctor" : "claude";
    return detail || `${this.engineName(engine)} exited with code ${code ?? "unknown"}. Run \`${command}\` in Terminal to check auth and setup, then rerun this lens.`;
  }

  private async runDeterministicIfAvailable(tab: ResearchTab): Promise<boolean> {
    if (!this.deterministicRunner) return false;
    this.deterministicRunning.add(tab.id);
    try {
      const output = await this.deterministicRunner(tab);
      if (!output) return false;
      for (const [file, data] of Object.entries(output)) {
        const target = path.join(this.tabDir(tab.id), file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(
          target,
          typeof data === "string" ? data : JSON.stringify(data, null, 2),
        );
      }
      tab.runCount += 1;
      tab.lastRunStatus = "ok";
      tab.lastError = null;
      if (!tab.sessionId) tab.sessionId = `deterministic:${tab.type}`;
      this.persist(tab);
      this.onEvent?.({ tabId: tab.id, kind: "activity", text: "computed deterministic lattice…" });
      this.onEvent?.({ tabId: tab.id, kind: "run-finished" });
      this.onEvent?.({ tabId: tab.id, kind: "findings-updated" });
      this.onProposalsMaybeChanged?.(tab.id);
      return true;
    } catch (err) {
      tab.lastRunStatus = "error";
      tab.lastError = String(err);
      this.persist(tab);
      this.onEvent?.({ tabId: tab.id, kind: "run-error", text: tab.lastError });
      this.onEvent?.({ tabId: tab.id, kind: "run-finished" });
      return true;
    } finally {
      this.deterministicRunning.delete(tab.id);
    }
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

  private codexBin(): string {
    const candidates = [
      path.join(os.homedir(), ".local", "bin", "codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
    ];
    for (const candidate of candidates) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
    return "codex";
  }

  private handleStreamEvent(tab: ResearchTab, ev: any) {
    if (tab.engine === "codex") {
      this.handleCodexStreamEvent(tab, ev);
      return;
    }
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

  private handleCodexStreamEvent(tab: ResearchTab, ev: any) {
    if (ev.thread_id && tab.sessionId !== ev.thread_id) {
      tab.sessionId = ev.thread_id;
      this.persist(tab);
    }
    if (ev.type === "item.completed") {
      const item = ev.item ?? {};
      if (item.type === "agent_message" && item.text?.trim()) {
        this.onEvent?.({
          tabId: tab.id,
          kind: "activity",
          text: String(item.text).trim().slice(0, 500),
        });
      } else if (item.type === "tool_call" || item.type === "command") {
        const label = item.name ?? item.command ?? item.type;
        this.onEvent?.({ tabId: tab.id, kind: "activity", text: `Codex: ${label}` });
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
