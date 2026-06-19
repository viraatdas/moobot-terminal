import { fmtMoney } from "../../lib/client";

// Presentational 2x2 grid of equity-history summary stats shown above the chart.
interface Props {
  startEquity: number;
  endEquity: number;
  high: number;
  low: number;
  rangeLabel: string;
}

export function PortfolioStatGrid({ startEquity, endEquity, high, low, rangeLabel }: Props) {
  return (
    <div className="mb-2 grid grid-cols-2 gap-2 text-[11px]">
      <div className="rounded-sm border border-hairline bg-panel-2 px-3 py-1.5">
        <div className="text-ink-faint">start</div>
        <div className="font-data text-[15px]">{fmtMoney(startEquity)}</div>
      </div>
      <div className="rounded-sm border border-hairline bg-panel-2 px-3 py-1.5">
        <div className="text-ink-faint">end</div>
        <div className="font-data text-[15px]">{fmtMoney(endEquity)}</div>
      </div>
      <div className="rounded-sm border border-hairline bg-panel-2 px-3 py-1.5">
        <div className="text-ink-faint">high / low</div>
        <div className="font-data text-[15px]">
          {fmtMoney(high)} / {fmtMoney(low)}
        </div>
      </div>
      <div className="rounded-sm border border-hairline bg-panel-2 px-3 py-1.5">
        <div className="text-ink-faint">range</div>
        <div className="font-data text-[15px]">{rangeLabel}</div>
      </div>
    </div>
  );
}
