import { motion } from "framer-motion";
import { ContainerScroll } from "@/components/ui/container-scroll-animation";
import { TerminalMock } from "@/components/TerminalMock";
import {
  Nav,
  Feature,
  Statement,
  ResearchVisual,
  RobinhoodVisual,
  ApprovalVisual,
  FeatherIcon,
  Principles,
  Install,
  Footer,
} from "@/components/sections";

export default function App() {
  return (
    <div className="grain bg-bg text-ink min-h-screen">
      <Nav />

      {/* hero */}
      <div className="relative">
        <div className="absolute inset-0 gridlines" />
        <div
          className="absolute inset-x-0 top-0 h-[60vh] pointer-events-none"
          style={{
            background:
              "radial-gradient(ellipse 60% 50% at 50% 0%, rgb(0 200 5 / 0.08), transparent 70%)",
          }}
        />
        <div className="flex flex-col overflow-hidden relative">
          <ContainerScroll
            titleComponent={
              <>
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.8, delay: 0.1 }}
                  className="font-mono text-[11px] tracking-[0.3em] uppercase text-dim"
                >
                  a trading terminal for the mac
                </motion.div>
                <motion.h1
                  initial={{ opacity: 0, y: 24 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.9, delay: 0.25 }}
                  className="mt-6 text-3xl md:text-5xl font-light text-faint"
                >
                  The market has a research desk now.
                  <br />
                  <span className="font-display italic text-6xl md:text-[9rem] font-normal mt-2 leading-none text-ink inline-block">
                    moobot<span className="not-italic text-moo">.</span>
                  </span>
                </motion.h1>
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.9, delay: 0.5 }}
                  className="mt-8 mb-10 text-faint text-base md:text-lg max-w-xl mx-auto leading-relaxed"
                >
                  Continuous AI research agents working every thesis you care
                  about. Trades through Robinhood. Every order approved by you.
                </motion.p>
              </>
            }
          >
            <TerminalMock />
          </ContainerScroll>
        </div>
      </div>

      <Statement words="Open a tab. Name a thesis. An agent starts working it — and never stops." />

      <Feature
        n="01"
        eyebrow="research desk"
        title={
          <>
            Research that <span className="italic">never sleeps</span>
            <span className="text-moo">.</span>
          </>
        }
        body="Each tab is a standing assignment — “NVDA earnings setup”, “uranium miners”. An agent works it continuously: news, filings, price action, sentiment — distilled into a living thesis with a sentiment and a conviction score, not a chat log you have to scroll."
        visual={<ResearchVisual />}
      />

      <Feature
        n="02"
        eyebrow="execution"
        flip
        title={
          <>
            Trades go through{" "}
            <span className="inline-flex items-baseline gap-3">
              <FeatherIcon className="h-8 md:h-12 w-auto text-moo self-center translate-y-1" />
              <span className="italic">Robinhood</span>
            </span>
            <span className="text-moo">.</span>
          </>
        }
        body="Moobot speaks directly to Robinhood's trading MCP with its own OAuth, so your tokens never leave your Mac. One connection can view your Robinhood accounts and route approved trades, with execution limited to the agentic account."
        visual={<RobinhoodVisual />}
      />

      <Feature
        n="03"
        eyebrow="the trigger"
        title={
          <>
            Nothing executes <span className="italic">without you</span>
            <span className="text-moo">.</span>
          </>
        }
        body="Agents can read the market, but they cannot touch it. When the evidence supports a trade they file a proposal — thesis, risk, conviction. Every order requires your explicit click, then a confirm. By design, with the guardrails enforced in code."
        visual={<ApprovalVisual />}
      />

      <Statement words="Agents propose. You are the only one with the trigger." />

      <Principles />
      <Install />
      <Footer />
    </div>
  );
}
