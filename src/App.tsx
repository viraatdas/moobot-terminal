import { useCallback, useEffect, useMemo, useState } from "react";
import { client, type ResearchEvent, type ResearchTab, type TradeProposal } from "./lib/client";
import { TitleBar } from "./components/TitleBar";
import { PortfolioRail } from "./components/PortfolioRail";
import { ResearchBoard } from "./components/ResearchBoard";
import { ProposalsRail } from "./components/ProposalsRail";

export interface FeedLine {
  id: number;
  tabId: string;
  text: string;
  at: number;
}

let feedSeq = 0;

export default function App() {
  const [sidecarUp, setSidecarUp] = useState(false);
  const [rhAuthed, setRhAuthed] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [accountNumber, setAccountNumber] = useState<string | null>(
    () => localStorage.getItem("moobot.account") || null,
  );
  const [portfolio, setPortfolio] = useState<any>(null);
  const [positions, setPositions] = useState<any[]>([]);
  const [tabs, setTabs] = useState<ResearchTab[]>([]);
  const [proposals, setProposals] = useState<TradeProposal[]>([]);
  const [feed, setFeed] = useState<FeedLine[]>([]);

  const refreshResearch = useCallback(async () => {
    try {
      setTabs(await client.request("research.list"));
    } catch {}
  }, []);

  const refreshProposals = useCallback(async () => {
    try {
      setProposals(await client.request("proposals.list"));
    } catch {}
  }, []);

  const refreshAccountData = useCallback(async (acct: string) => {
    try {
      const [pf, pos] = await Promise.all([
        client.request("rh.call", { tool: "get_portfolio", args: { account_number: acct } }),
        client.request("rh.call", { tool: "get_equity_positions", args: { account_number: acct } }),
      ]);
      setPortfolio(pf);
      setPositions(Array.isArray(pos) ? pos : (pos?.positions ?? pos?.results ?? []));
    } catch (err) {
      console.error("portfolio refresh failed", err);
    }
  }, []);

  const bootRobinhood = useCallback(async () => {
    try {
      const status = await client.request("rh.status");
      if (!status.hasStoredTokens && !status.authenticated) return;
      await client.request("rh.connect");
      setRhAuthed(true);
      setAuthUrl(null);
    } catch (err) {
      console.error("rh boot failed", err);
    }
  }, []);

  // sidecar connection lifecycle
  useEffect(() => {
    client.start();
    const offConn = client.onConnection((up) => {
      setSidecarUp(up);
      if (up) {
        void bootRobinhood();
        void refreshResearch();
        void refreshProposals();
      }
    });
    const offEvent = client.onEvent((event, payload) => {
      if (event === "rh.auth-url") setAuthUrl(payload.url);
      if (event === "proposals.changed") setProposals(payload.proposals);
      if (event === "research") {
        const ev = payload as ResearchEvent;
        if (ev.kind === "activity" && ev.text) {
          setFeed((f) =>
            [{ id: feedSeq++, tabId: ev.tabId, text: ev.text!, at: Date.now() }, ...f].slice(
              0,
              120,
            ),
          );
        }
        if (ev.kind !== "activity") void refreshResearch();
      }
    });
    return () => {
      offConn();
      offEvent();
    };
  }, [bootRobinhood, refreshProposals, refreshResearch]);

  // once authed, load accounts
  useEffect(() => {
    if (!rhAuthed) return;
    (async () => {
      try {
        const res = await client.request("rh.call", { tool: "get_accounts" });
        const list = Array.isArray(res) ? res : (res?.accounts ?? res?.results ?? []);
        setAccounts(list);
        if (!accountNumber && list.length > 0) {
          // Prefer the agentic-enabled account (the only one agents can trade in),
          // then Robinhood's default, then the first.
          const preferred =
            list.find((a: any) => a?.agentic_allowed) ??
            list.find((a: any) => a?.is_default) ??
            list[0];
          const num =
            preferred?.account_number ?? preferred?.accountNumber ?? preferred?.number ?? null;
          if (num) {
            setAccountNumber(String(num));
            localStorage.setItem("moobot.account", String(num));
          }
        }
      } catch (err) {
        console.error("accounts load failed", err);
      }
    })();
  }, [rhAuthed]);

  // portfolio polling
  useEffect(() => {
    if (!rhAuthed || !accountNumber) return;
    void refreshAccountData(accountNumber);
    const t = setInterval(() => void refreshAccountData(accountNumber), 30_000);
    return () => clearInterval(t);
  }, [rhAuthed, accountNumber, refreshAccountData]);

  const connectRobinhood = useCallback(async () => {
    try {
      await client.request("rh.connect");
      setRhAuthed(true);
      setAuthUrl(null);
    } catch (err) {
      console.error("rh connect failed", err);
    }
  }, []);

  const selectAccount = useCallback((num: string) => {
    setAccountNumber(num);
    localStorage.setItem("moobot.account", num);
  }, []);

  const pendingCount = useMemo(
    () => proposals.filter((p) => p.status === "pending").length,
    [proposals],
  );

  return (
    <div className="flex h-full flex-col">
      <TitleBar
        sidecarUp={sidecarUp}
        rhAuthed={rhAuthed}
        accounts={accounts}
        accountNumber={accountNumber}
        onSelectAccount={selectAccount}
        onConnect={connectRobinhood}
        authUrl={authUrl}
        pendingCount={pendingCount}
      />
      <div className="grid min-h-0 flex-1 grid-cols-[300px_1fr_340px] gap-px bg-hairline">
        <PortfolioRail portfolio={portfolio} positions={positions} rhAuthed={rhAuthed} />
        <ResearchBoard tabs={tabs} feed={feed} onTabsChanged={refreshResearch} />
        <ProposalsRail
          proposals={proposals}
          accountNumber={accountNumber}
          onChanged={refreshProposals}
        />
      </div>
    </div>
  );
}
