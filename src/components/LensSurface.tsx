import type { LensType, StrategySpec } from "../lib/client";
import { StrategySurface } from "./StrategySurface";
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
}

export function LensSurface({ type, lens, tabId }: Props) {
  switch (type) {
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
