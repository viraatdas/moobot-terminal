import { motion } from "framer-motion";

const positions = [
  { sym: "NVDA", qty: "42", px: "1,042.18", pl: "+18.4%", up: true },
  { sym: "PLTR", qty: "120", px: "61.30", pl: "+6.1%", up: true },
  { sym: "CCJ", qty: "85", px: "54.02", pl: "+2.9%", up: true },
  { sym: "TSLA", qty: "10", px: "228.45", pl: "-3.2%", up: false },
  { sym: "AAPL", qty: "30", px: "243.90", pl: "+0.8%", up: true },
];

const feed = [
  { t: "09:31:04", line: "scanning SEC EDGAR · 3 new 13F filings reference NVDA" },
  { t: "09:31:47", line: "HBM supply note from SK Hynix: capacity sold out through Q2 '27" },
  { t: "09:32:13", line: "options flow: call/put ratio 2.4, skew steepening into earnings" },
  { t: "09:33:02", line: "revising thesis → hyperscaler capex guides intact, demand > supply" },
  { t: "09:33:40", line: "conviction 6 → 7 · updating findings.md" },
  { t: "09:34:11", line: "drafting proposal: BUY 10 NVDA @ limit 1,042.00" },
];

const fadeUp = {
  hidden: { opacity: 0, y: 10 },
  show: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: 0.9 + i * 0.45, duration: 0.5 },
  }),
};

export function TerminalMock() {
  return (
    <div className="h-full w-full flex flex-col font-mono text-[10px] md:text-[11px] leading-relaxed select-none">
      {/* title bar */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-hair bg-panel shrink-0">
        <span className="size-2.5 rounded-full bg-[#ff5f57]" />
        <span className="size-2.5 rounded-full bg-[#febc2e]" />
        <span className="size-2.5 rounded-full bg-[#28c840]" />
        <span className="ml-3 text-faint tracking-widest uppercase text-[9px]">
          moobot terminal
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-moo text-[9px]">
          <span className="size-1.5 rounded-full bg-moo animate-pulse-dot" />
          robinhood connected
        </span>
      </div>

      {/* ticker strip */}
      <div className="border-b border-hair overflow-hidden py-1.5 bg-panel/60 shrink-0">
        <div className="flex w-max animate-marquee gap-8 px-4 text-[9px]">
          {[...Array(2)].map((_, k) => (
            <div key={k} className="flex gap-8 shrink-0">
              <span className="text-faint">SPX <span className="text-moo">+0.62%</span></span>
              <span className="text-faint">NDX <span className="text-moo">+1.14%</span></span>
              <span className="text-faint">NVDA <span className="text-moo">+2.41%</span></span>
              <span className="text-faint">TSLA <span className="text-down">-1.08%</span></span>
              <span className="text-faint">PLTR <span className="text-moo">+3.30%</span></span>
              <span className="text-faint">U3O8 <span className="text-moo">+0.95%</span></span>
              <span className="text-faint">BTC <span className="text-down">-0.44%</span></span>
              <span className="text-faint">VIX <span className="text-down">-2.10%</span></span>
            </div>
          ))}
        </div>
      </div>

      {/* three panes */}
      <div className="flex-1 grid grid-cols-[1fr_1.4fr_1fr] min-h-0">
        {/* portfolio */}
        <div className="border-r border-hair p-3 md:p-4 flex flex-col gap-3 min-h-0 overflow-hidden">
          <div className="text-dim uppercase tracking-[0.2em] text-[8px]">Portfolio</div>
          <div>
            <div className="text-ink text-base md:text-xl">$128,440.12</div>
            <div className="text-moo text-[9px]">+$2,114.08 (1.67%) today</div>
          </div>
          <Sparkline />
          <div className="flex flex-col gap-1.5 mt-1">
            {positions.map((p) => (
              <div key={p.sym} className="flex items-center justify-between border-b border-hair/70 pb-1.5">
                <span className="text-ink">{p.sym}</span>
                <span className="text-dim hidden md:inline">{p.qty}</span>
                <span className={p.up ? "text-moo" : "text-down"}>{p.pl}</span>
              </div>
            ))}
          </div>
        </div>

        {/* research */}
        <div className="border-r border-hair p-3 md:p-4 flex flex-col gap-2.5 min-h-0 overflow-hidden relative">
          <div className="flex items-center gap-2">
            <div className="text-dim uppercase tracking-[0.2em] text-[8px]">Research</div>
            <span className="ml-auto rounded-full border border-moo/40 text-moo px-2 py-0.5 text-[8px] uppercase tracking-wider">
              bullish · 7/10
            </span>
          </div>
          <div className="flex gap-1.5 text-[8px]">
            <span className="rounded-full bg-ink/10 text-ink px-2 py-0.5">nvda-earnings</span>
            <span className="rounded-full border border-hair text-dim px-2 py-0.5">uranium</span>
            <span className="rounded-full border border-hair text-dim px-2 py-0.5">ai-capex</span>
          </div>
          <div className="flex flex-col gap-2 mt-1">
            {feed.map((f, i) => (
              <motion.div
                key={f.t}
                custom={i}
                variants={fadeUp}
                initial="hidden"
                whileInView="show"
                viewport={{ once: true, margin: "-20%" }}
                className="flex gap-2"
              >
                <span className="text-dim shrink-0">{f.t}</span>
                <span className="text-faint">{f.line}</span>
              </motion.div>
            ))}
            <motion.span
              initial={{ opacity: 0 }}
              whileInView={{ opacity: 1 }}
              viewport={{ once: true }}
              transition={{ delay: 0.9 + feed.length * 0.45 }}
              className="text-moo"
            >
              ▮<span className="animate-blink">_</span>
            </motion.span>
          </div>
          {/* scanline */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-transparent via-moo/[0.04] to-transparent animate-scan" />
        </div>

        {/* proposals */}
        <div className="p-3 md:p-4 flex flex-col gap-3 min-h-0 overflow-hidden">
          <div className="flex items-center gap-2">
            <div className="text-dim uppercase tracking-[0.2em] text-[8px]">Proposals</div>
            <span className="ml-auto size-1.5 rounded-full bg-moo animate-pulse-dot" />
          </div>
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-20%" }}
            transition={{ delay: 3.4, duration: 0.6 }}
            className="rounded-lg border border-moo/30 bg-moo/[0.04] p-3 flex flex-col gap-2"
          >
            <div className="flex items-baseline justify-between">
              <span className="text-moo">BUY</span>
              <span className="text-ink">10 NVDA</span>
            </div>
            <div className="text-faint">limit 1,042.00 · day</div>
            <div className="text-dim text-[8px] leading-relaxed">
              thesis: HBM constraint + intact hyperscaler capex. risk: earnings
              IV crush. conviction 7/10.
            </div>
            <div className="flex gap-1.5 mt-1">
              <span className="flex-1 text-center rounded bg-moo text-[#021a01] py-1 font-medium">
                approve
              </span>
              <span className="flex-1 text-center rounded border border-hair text-dim py-1">
                dismiss
              </span>
            </div>
          </motion.div>
          <div className="text-dim text-[8px] mt-auto">
            awaiting your approval. nothing executes without it
          </div>
        </div>
      </div>
    </div>
  );
}

function Sparkline() {
  return (
    <svg viewBox="0 0 200 44" className="w-full h-9" preserveAspectRatio="none">
      <defs>
        <linearGradient id="sparkfill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#00c805" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#00c805" stopOpacity="0" />
        </linearGradient>
      </defs>
      <motion.path
        d="M0 36 L14 33 L26 35 L40 28 L54 30 L66 24 L80 26 L94 18 L108 22 L122 14 L136 17 L150 10 L164 13 L178 7 L200 4"
        fill="none"
        stroke="#00c805"
        strokeWidth="1.5"
        initial={{ pathLength: 0 }}
        whileInView={{ pathLength: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 1.6, ease: "easeInOut", delay: 0.4 }}
      />
      <path
        d="M0 36 L14 33 L26 35 L40 28 L54 30 L66 24 L80 26 L94 18 L108 22 L122 14 L136 17 L150 10 L164 13 L178 7 L200 4 L200 44 L0 44 Z"
        fill="url(#sparkfill)"
      />
    </svg>
  );
}
