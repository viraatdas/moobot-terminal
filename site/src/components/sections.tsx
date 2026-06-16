import { useState } from "react";
import { motion } from "framer-motion";

/* ---------- nav ---------- */

export function Nav() {
  return (
    <motion.nav
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.8, ease: "easeOut" }}
      className="fixed top-0 inset-x-0 z-50 backdrop-blur-xl bg-bg/60 border-b border-hair"
    >
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        <a href="#" className="font-display italic text-2xl tracking-tight">
          moobot<span className="not-italic text-moo">.</span>
        </a>
        <div className="flex items-center gap-6 text-sm text-faint">
          <a
            href="https://github.com/viraatdas/moobot-terminal"
            className="hover:text-ink transition-colors hidden sm:block"
          >
            Source
          </a>
          <a
            href="#install"
            className="rounded-full border border-hair px-4 py-1.5 text-ink hover:border-moo hover:text-moo transition-colors"
          >
            Install
          </a>
        </div>
      </div>
    </motion.nav>
  );
}

/* ---------- shared reveal helpers ---------- */

const reveal = {
  initial: { opacity: 0, y: 36 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "-15%" },
  transition: { duration: 0.9, ease: [0.21, 0.6, 0.35, 1] as const },
};

function Eyebrow({ n, children }: { n: string; children: React.ReactNode }) {
  return (
    <div className="font-mono text-[11px] tracking-[0.25em] uppercase text-dim flex items-center gap-3">
      <span className="text-moo">{n}</span>
      <span className="h-px w-8 bg-hair" />
      {children}
    </div>
  );
}

/* ---------- feature sections ---------- */

export function Feature({
  n,
  eyebrow,
  title,
  body,
  flip,
  visual,
}: {
  n: string;
  eyebrow: string;
  title: React.ReactNode;
  body: string;
  flip?: boolean;
  visual: React.ReactNode;
}) {
  return (
    <section className="max-w-6xl mx-auto px-6 py-28 md:py-40 grid md:grid-cols-2 gap-12 md:gap-20 items-center">
      <motion.div {...reveal} className={flip ? "md:order-2" : ""}>
        <Eyebrow n={n}>{eyebrow}</Eyebrow>
        <h2 className="font-display text-4xl md:text-6xl leading-[1.05] mt-6">
          {title}
        </h2>
        <p className="text-faint text-base md:text-lg leading-relaxed mt-6 max-w-md">
          {body}
        </p>
      </motion.div>
      <motion.div
        {...reveal}
        transition={{ ...reveal.transition, delay: 0.15 }}
        className={flip ? "md:order-1" : ""}
      >
        {visual}
      </motion.div>
    </section>
  );
}

/* ---------- big interstitial statement, word-by-word ---------- */

export function Statement({ words }: { words: string }) {
  const split = words.split(" ");
  return (
    <section className="py-32 md:py-48 px-6">
      <motion.h2
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, margin: "-25%" }}
        transition={{ staggerChildren: 0.12 }}
        className="font-display italic text-center text-4xl md:text-7xl leading-tight max-w-4xl mx-auto"
      >
        {split.map((w, i) => (
          <motion.span
            key={i}
            variants={{
              hidden: { opacity: 0.08, filter: "blur(4px)" },
              show: {
                opacity: 1,
                filter: "blur(0px)",
                transition: { duration: 0.6 },
              },
            }}
            className="inline-block mr-[0.28em]"
          >
            {w}
          </motion.span>
        ))}
      </motion.h2>
    </section>
  );
}

/* ---------- robinhood connection visual ---------- */

export function RobinhoodVisual() {
  return (
    <div className="relative rounded-2xl border border-hair bg-panel p-8 md:p-12 overflow-hidden">
      <div className="absolute inset-0 gridlines" />
      <div className="relative flex items-center justify-between gap-4">
        <Node label="moobot">
          <span className="font-display italic text-2xl md:text-3xl">
            m<span className="not-italic text-moo">.</span>
          </span>
        </Node>

        {/* animated link */}
        <div className="flex-1 relative h-px bg-hair mx-2">
          <motion.div
            className="absolute top-1/2 -translate-y-1/2 size-1.5 rounded-full bg-moo shadow-[0_0_12px_#00c805]"
            animate={{ left: ["0%", "100%"], opacity: [0, 1, 1, 0] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
          />
          <motion.div
            className="absolute top-1/2 -translate-y-1/2 size-1.5 rounded-full bg-ink/60"
            animate={{ left: ["100%", "0%"], opacity: [0, 1, 1, 0] }}
            transition={{
              duration: 1.8,
              repeat: Infinity,
              ease: "easeInOut",
              delay: 0.9,
            }}
          />
          <div className="absolute -top-7 inset-x-0 text-center font-mono text-[9px] tracking-[0.2em] uppercase text-dim">
            MCP · OAuth
          </div>
        </div>

        <Node label="robinhood">
          <FeatherIcon className="h-7 md:h-9 w-auto text-moo" />
        </Node>
      </div>
      <div className="relative mt-10 font-mono text-[10px] text-dim leading-relaxed">
        <span className="text-faint">~/Library/Application Support/MoobotTerminal/rh-oauth.json</span>
        <br />
        tokens live on your Mac. no middleman servers, no custody, no keys in
        the cloud.
      </div>
    </div>
  );
}

function Node({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 shrink-0">
      <div className="size-20 md:size-24 rounded-2xl border border-hair bg-bg flex items-center justify-center">
        {children}
      </div>
      <span className="font-mono text-[9px] tracking-[0.25em] uppercase text-dim">
        {label}
      </span>
    </div>
  );
}

export function FeatherIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-label="Robinhood">
      <path d="M20.8 1.6c-5.6.5-10 2.5-12.9 6.1C5.3 11 3.9 15.3 3.6 20.5c0 .6.2 1.1.7 1.5.4.4 1 .5 1.6.4 2-.4 3.8-1 5.4-2-1.6-.3-2.9-.9-3.9-1.8 2.7-.1 5.1-.8 7.1-2.2-1.8-.2-3.3-.7-4.5-1.6 2.9-.4 5.3-1.5 7.1-3.4-1.7 0-3.1-.3-4.3-1 2.7-.9 4.8-2.5 6.3-4.9.7-1.1 1.3-2.4 1.7-3.9z" />
    </svg>
  );
}

/* ---------- proposal approval visual ---------- */

export function ApprovalVisual() {
  return (
    <div className="relative rounded-2xl border border-hair bg-panel p-8 md:p-12 overflow-hidden">
      <div className="absolute inset-0 gridlines" />
      <div className="relative max-w-sm mx-auto font-mono text-[11px]">
        <div className="rounded-xl border border-moo/30 bg-bg p-5 flex flex-col gap-3 shadow-[0_30px_60px_-30px_rgb(0_200_5/0.15)]">
          <div className="flex items-center justify-between">
            <span className="text-dim uppercase tracking-[0.2em] text-[9px]">
              proposal #014
            </span>
            <span className="flex items-center gap-1.5 text-moo text-[9px]">
              <span className="size-1.5 rounded-full bg-moo animate-pulse-dot" />
              pending
            </span>
          </div>
          <div className="flex items-baseline justify-between text-base">
            <span className="text-moo">BUY</span>
            <span>10 × NVDA</span>
          </div>
          <div className="text-faint">limit $1,042.00 · day order</div>
          <div className="text-dim text-[10px] leading-relaxed border-t border-hair pt-3">
            agent: nvda-earnings · conviction 7/10
            <br />
            review_equity_order → place_equity_order
          </div>
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.97 }}
            className="rounded-lg bg-moo text-[#021a01] py-2.5 font-medium tracking-wide cursor-pointer"
          >
            approve trade
          </motion.button>
          <button className="rounded-lg border border-hair text-dim py-2 cursor-pointer">
            dismiss
          </button>
        </div>
        <div className="text-center text-dim text-[9px] mt-5 tracking-wide">
          the only code path that places an order is this button
        </div>
      </div>
    </div>
  );
}

/* ---------- research visual ---------- */

const researchLines = [
  ["news", "Reuters: hyperscaler capex guides raised across the board"],
  ["edgar", "13F: two new mega-fund positions disclosed in NVDA"],
  ["x", "supply-chain checks point to HBM allocation through 2027"],
  ["price", "consolidating above the 50-day on declining volume"],
  ["thesis", "demand outpaces supply into the next two quarters → bullish"],
] as const;

export function ResearchVisual() {
  return (
    <div className="relative rounded-2xl border border-hair bg-panel p-6 md:p-8 overflow-hidden">
      <div className="absolute inset-0 gridlines" />
      <div className="relative font-mono text-[10px] md:text-[11px]">
        <div className="flex items-center gap-2 mb-5">
          <span className="rounded-full bg-ink/10 px-3 py-1">nvda-earnings</span>
          <span className="rounded-full border border-hair text-dim px-3 py-1">
            uranium-miners
          </span>
          <span className="rounded-full border border-hair text-dim px-3 py-1">
            + new tab
          </span>
        </div>
        <div className="flex flex-col gap-3">
          {researchLines.map(([src, line], i) => (
            <motion.div
              key={src}
              initial={{ opacity: 0, x: -14 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true, margin: "-20%" }}
              transition={{ delay: 0.3 + i * 0.18, duration: 0.5 }}
              className="flex gap-3 items-baseline"
            >
              <span className="text-moo w-12 shrink-0 text-right uppercase text-[9px] tracking-wider">
                {src}
              </span>
              <span className="text-faint leading-relaxed">{line}</span>
            </motion.div>
          ))}
        </div>
        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ delay: 1.4 }}
          className="mt-6 border-t border-hair pt-4 flex items-center justify-between"
        >
          <span className="text-dim">findings.md · updated 12s ago</span>
          <span className="rounded-full border border-moo/40 text-moo px-3 py-1 text-[9px] uppercase tracking-wider">
            bullish · conviction 7/10
          </span>
        </motion.div>
      </div>
    </div>
  );
}

/* ---------- principles strip ---------- */

const principles = [
  ["Native Mac", "Built for Apple Silicon. A real app, not a browser tab."],
  ["Local-first", "Your tokens, your research, your machine. Nothing phones home."],
  ["Your sources", "Web, SEC EDGAR, market data, social sentiment. Configured per tab."],
  ["Open source", "Read every line that touches your money."],
] as const;

export function Principles() {
  return (
    <section className="max-w-6xl mx-auto px-6 py-24 grid grid-cols-2 md:grid-cols-4 gap-px bg-hair border border-hair rounded-2xl overflow-hidden">
      {principles.map(([t, d], i) => (
        <motion.div
          key={t}
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-10%" }}
          transition={{ delay: i * 0.1, duration: 0.7 }}
          className="bg-bg p-7 md:p-9"
        >
          <div className="font-mono text-[10px] tracking-[0.2em] uppercase text-moo">
            {t}
          </div>
          <p className="text-faint text-sm leading-relaxed mt-3">{d}</p>
        </motion.div>
      ))}
    </section>
  );
}

/* ---------- install ---------- */

export function Install() {
  const [copied, setCopied] = useState(false);
  const cmd = "brew install --cask viraatdas/tap/moobot-terminal";

  const copy = () => {
    navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <section id="install" className="max-w-4xl mx-auto px-6 py-32 md:py-44 text-center">
      <motion.div {...reveal}>
        <h2 className="font-display text-5xl md:text-7xl">
          Get the <span className="italic">desk</span>
          <span className="text-moo">.</span>
        </h2>
        <button
          onClick={copy}
          className="group mt-12 w-full max-w-2xl mx-auto flex items-center justify-between gap-4 rounded-2xl border border-hair bg-panel px-6 py-5 font-mono text-xs md:text-sm text-left cursor-pointer hover:border-moo/50 transition-colors"
        >
          <span>
            <span className="text-dim select-none">$ </span>
            <span className="text-ink">{cmd}</span>
          </span>
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.2em] text-dim group-hover:text-moo transition-colors">
            {copied ? "copied" : "copy"}
          </span>
        </button>
        <p className="text-dim text-sm mt-8 leading-relaxed">
          Apple Silicon · requires{" "}
          <a
            href="https://claude.com/claude-code"
            className="text-faint underline underline-offset-4 hover:text-ink transition-colors"
          >
            Claude Code
          </a>{" "}
          for the research engine · bring your own Robinhood account
        </p>
      </motion.div>
    </section>
  );
}

/* ---------- footer ---------- */

export function Footer() {
  return (
    <footer className="border-t border-hair">
      <div className="max-w-6xl mx-auto px-6 py-10 flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-dim">
        <span className="font-display italic text-lg text-faint">
          moobot<span className="not-italic text-moo">.</span>
        </span>
        <span className="font-mono text-[10px] tracking-wide">
          not investment advice · markets are risk · you hold the trigger
        </span>
        <span>
          built by{" "}
          <a href="https://viraat.dev" className="text-faint hover:text-ink transition-colors">
            Viraat Das
          </a>{" "}
          ·{" "}
          <a
            href="https://github.com/viraatdas/moobot-terminal"
            className="text-faint hover:text-ink transition-colors"
          >
            source
          </a>
        </span>
      </div>
    </footer>
  );
}
