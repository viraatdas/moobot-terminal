import { useCallback, useEffect, useMemo, useState } from "react";
import {
  client,
  type AccountSnapshot,
  type ResearchEvent,
  type ResearchTab,
  type RestStatus,
  type TradeProposal,
} from "./lib/client";
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
    () => localStorage.getItem("moobot.account.v2") || null,
  );
  const [agenticBuyingPower, setAgenticBuyingPower] = useState<number | null>(null);
  const [restStatus, setRestStatus] = useState<RestStatus>({
    connected: false,
    hasToken: false,
    expired: false,
  });
  const [snapshot, setSnapshot] = useState<AccountSnapshot | null>(null);
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

  // Full-account snapshot (all positions: equities/options/crypto) via the REST layer.
  const refreshSnapshot = useCallback(async () => {
    try {
      const status: RestStatus = await client.request("rhrest.status");
      setRestStatus(status);
      if (!status.connected) return;
      const snap: AccountSnapshot = await client.request("account.snapshot", {});
      setSnapshot(snap);
      setRestStatus(await client.request("rhrest.status"));
    } catch (err) {
      console.error("snapshot refresh failed", err);
      try {
        setRestStatus(await client.request("rhrest.status"));
      } catch {}
    }
  }, []);

  // Buying power on the agentic (tradeable) account, via the MCP.
  const refreshAgenticBp = useCallback(async (acct: string) => {
    try {
      const pf: any = await client.request("rh.call", {
        tool: "get_portfolio",
        args: { account_number: acct },
      });
      const bp = Number(pf?.buying_power?.buying_power ?? pf?.buying_power);
      setAgenticBuyingPower(Number.isFinite(bp) ? bp : null);
    } catch {
      setAgenticBuyingPower(null);
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
        void refreshSnapshot();
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
  }, [bootRobinhood, refreshProposals, refreshResearch, refreshSnapshot]);

  // poll the full-account snapshot
  useEffect(() => {
    if (!sidecarUp) return;
    const t = setInterval(() => void refreshSnapshot(), 30_000);
    return () => clearInterval(t);
  }, [sidecarUp, refreshSnapshot]);

  // once authed, load accounts
  useEffect(() => {
    if (!rhAuthed) return;
    (async () => {
      try {
        const res = await client.request("rh.call", { tool: "get_accounts" });
        const list = Array.isArray(res) ? res : (res?.accounts ?? res?.results ?? []);
        setAccounts(list);
        if (!accountNumber && list.length > 0) {
          // Default the VIEW to Robinhood's default account (your real holdings),
          // not the agentic trading account — that one is usually empty and would
          // show a wall of $0. Trading is routed separately (see tradeAccount).
          const preferred =
            list.find((a: any) => a?.is_default) ??
            list.find((a: any) => Number(a?.total_value) > 0) ??
            list[0];
          const num =
            preferred?.account_number ?? preferred?.accountNumber ?? preferred?.number ?? null;
          if (num) {
            setAccountNumber(String(num));
            localStorage.setItem("moobot.account.v2", String(num));
          }
        }
      } catch (err) {
        console.error("accounts load failed", err);
      }
    })();
  }, [rhAuthed]);

  // Robinhood only permits agent order placement on agentic_allowed accounts, so
  // trades always route there regardless of which account is being viewed.
  const tradeAccount = useMemo(() => {
    const agentic = accounts.find((a: any) => a?.agentic_allowed);
    const num = agentic?.account_number ?? agentic?.accountNumber ?? agentic?.number;
    return num ? String(num) : accountNumber;
  }, [accounts, accountNumber]);

  // poll agentic buying power (the tradeable balance)
  useEffect(() => {
    if (!rhAuthed || !tradeAccount) return;
    void refreshAgenticBp(tradeAccount);
    const t = setInterval(() => void refreshAgenticBp(tradeAccount), 30_000);
    return () => clearInterval(t);
  }, [rhAuthed, tradeAccount, refreshAgenticBp]);

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
    localStorage.setItem("moobot.account.v2", num);
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
        <PortfolioRail
          snapshot={snapshot}
          restStatus={restStatus}
          agenticBuyingPower={agenticBuyingPower}
          onConnected={refreshSnapshot}
        />
        <ResearchBoard tabs={tabs} feed={feed} onTabsChanged={refreshResearch} />
        <ProposalsRail
          proposals={proposals}
          accountNumber={tradeAccount}
          tradeAccountAgentic={accounts.some((a: any) => a?.agentic_allowed)}
          onChanged={refreshProposals}
        />
      </div>
    </div>
  );
}
