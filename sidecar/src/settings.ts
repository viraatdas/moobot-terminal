import fs from "node:fs";
import { SETTINGS_FILE } from "./config.ts";
import { writeJsonFileAtomic } from "./json-store.ts";

export interface Settings {
  /** When true, approvals are simulated against live quotes instead of sent to Robinhood. */
  paperMode: boolean;
  /** When true, agents wake on material events (price moves, new filings), not just the timer. */
  eventTriggers: boolean;
  /** When true, live-strategy proposals are auto-approved WITHOUT human review. Honored
   * ONLY in paper mode — autonomous approval can never reach real money here. */
  autoApprove: boolean;
}

const DEFAULTS: Settings = {
  paperMode: false,
  eventTriggers: true,
  autoApprove: false,
};

export class SettingsStore {
  private settings: Settings = { ...DEFAULTS };
  onChanged?: (settings: Settings) => void;

  constructor() {
    try {
      const loaded = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
      this.settings = { ...DEFAULTS, ...(loaded && typeof loaded === "object" ? loaded : {}) };
    } catch {
      this.settings = { ...DEFAULTS };
    }
  }

  get(): Settings {
    return { ...this.settings };
  }

  isPaper(): boolean {
    return this.settings.paperMode === true;
  }

  eventTriggersOn(): boolean {
    return this.settings.eventTriggers === true;
  }

  /** Auto-approval is paper-only by construction: it returns true only when BOTH the
   * flag is set AND we're in paper mode, so real money can never be auto-approved. */
  autoApproveOn(): boolean {
    return this.settings.autoApprove === true && this.settings.paperMode === true;
  }

  set(patch: Partial<Settings>): Settings {
    if (typeof patch.paperMode === "boolean") this.settings.paperMode = patch.paperMode;
    if (typeof patch.eventTriggers === "boolean") this.settings.eventTriggers = patch.eventTriggers;
    if (typeof patch.autoApprove === "boolean") this.settings.autoApprove = patch.autoApprove;
    try {
      writeJsonFileAtomic(SETTINGS_FILE, this.settings);
    } catch (err) {
      console.error(`[settings] persist failed: ${err}`);
    }
    this.onChanged?.(this.get());
    return this.get();
  }
}
