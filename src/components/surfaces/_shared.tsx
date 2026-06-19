import { openTicker } from "../../lib/cashtags";

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center text-[13px] text-ink-faint">
      {children}
    </div>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 text-[10px] tracking-[0.16em] uppercase text-ink-faint">{children}</div>
  );
}

/** A clickable $TICKER pill that opens the options chain. */
export function Ticker({ sym }: { sym: string }) {
  const s = cleanSymbol(sym);
  if (!s) return <span className="text-ink-faint">n/a</span>;
  return (
    <button className="cashtag" onClick={() => openTicker(s)}>
      ${s}
    </button>
  );
}

export function cleanSymbol(value: unknown): string {
  return String(value ?? "")
    .replace(/^\$/, "")
    .trim()
    .toUpperCase();
}

export function sourceLabel(s: any): string {
  if (s?.title) return String(s.title).slice(0, 44);
  try {
    return new URL(String(s?.url)).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
}
