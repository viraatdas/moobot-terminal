import type { LensType, ResearchTab, StrategySpec } from "../lib/client";
import { StrategySurface } from "./StrategySurface";
import { ChatSurface } from "./surfaces/ChatSurface";
import { PulseSurface } from "./surfaces/PulseSurface";
import { ScoutSurface } from "./surfaces/ScoutSurface";
import { ThesisSurface } from "./surfaces/ThesisSurface";
import { ExposureSurface } from "./surfaces/ExposureSurface";
import { TradeSurface } from "./surfaces/TradeSurface";
import { LatticeSurface } from "./surfaces/lattice/LatticeSurface";

interface Props {
  type: LensType;
  lens: Record<string, any>;
  tabId: string;
  tab?: ResearchTab;
  onChanged?: () => void;
}

export function LensSurface({ type, lens, tabId, tab, onChanged }: Props) {
  switch (type) {
    case "chat":
      return tab ? (
        <ChatSurface tab={tab} markdown={lens["chat.md"] ?? ""} onChanged={onChanged ?? (() => {})} />
      ) : null;
    case "pulse":
      return <PulseSurface items={lens["pulse.json"] ?? []} />;
    case "scout":
      return <ScoutSurface items={lens["scout.json"] ?? []} />;
    case "thesis":
      return <ThesisSurface data={lens["thesis.json"]} />;
    case "exposure":
      return <ExposureSurface data={lens["exposure.json"]} />;
    case "lattice":
      return <LatticeSurface data={lens["lattice.json"]} />;
    case "trade":
      return <TradeSurface markdown={lens["trade.md"] ?? ""} />;
    case "strategy":
      return (
        <StrategySurface
          tabId={tabId}
          spec={(lens["strategy.json"] as StrategySpec | null) ?? null}
          markdown={(lens["strategy.md"] as string | null) ?? null}
        />
      );
    default:
      return null;
  }
}
