import { useEffect, useState } from "react";

interface MktState {
  label: string; // OPEN / CLOSED / PRE / AFTER
  open: boolean;
  time: string; // HH:MM:SS ET
}

function marketState(): MktState {
  // Render the current time in US Eastern, then judge regular session 9:30–16:00 Mon–Fri.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wd = get("weekday");
  let hh = Number(get("hour"));
  if (hh === 24) hh = 0; // some runtimes emit 24 for midnight
  const mm = Number(get("minute"));
  const ss = get("second");
  const mins = hh * 60 + mm;
  const weekend = wd === "Sat" || wd === "Sun";
  const time = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${ss}`;
  if (weekend) return { label: "CLOSED", open: false, time };
  if (mins >= 570 && mins < 960) return { label: "OPEN", open: true, time }; // 9:30–16:00
  if (mins >= 240 && mins < 570) return { label: "PRE", open: false, time }; // 4:00–9:30
  if (mins >= 960 && mins < 1200) return { label: "AFTER", open: false, time }; // 16:00–20:00
  return { label: "CLOSED", open: false, time };
}

export function MarketClock() {
  const [s, setS] = useState<MktState>(marketState);
  useEffect(() => {
    const t = setInterval(() => setS(marketState()), 1000);
    return () => clearInterval(t);
  }, []);
  const color = s.open ? "text-pos" : s.label === "CLOSED" ? "text-ink-faint" : "text-amber";
  const dot = s.open ? "bg-pos live-ping" : s.label === "CLOSED" ? "bg-ink-faint" : "bg-amber";
  return (
    <div className="flex items-center gap-2" data-tauri-drag-region title="US market hours (ET)">
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      <span className={`text-[10px] font-semibold tracking-[0.14em] uppercase ${color}`}>
        {s.label}
      </span>
      <span className="font-data text-[10px] text-ink-faint">{s.time} ET</span>
    </div>
  );
}
