// Scratch: momentum/trend variants vs the verification gate. node sidecar/strategy-lab.ts
import { MarketData } from "./src/market-data.ts";
import { loadStrategyBars } from "./src/strategy-bars.ts";
import { verifyStrategy } from "./src/verify.ts";
import { parseSpec, type Bar } from "./src/backtest.ts";

const md = new MarketData();
const SUPERSET = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","JPM","XOM","WMT","UNH","TSLA","AMD","AVGO","COST","HD","NFLX"];
console.log("Fetching 5y/1d for", SUPERSET.length, "symbols + SPY…");
const all = await loadStrategyBars(md, SUPERSET, { minBars: 250, sequential: true });
const spy = (await loadStrategyBars(md, ["SPY"], { sequential: true })).get("SPY") ?? [];
console.log(`have ${[...all.keys()].length} symbols | SPY ${spy.length} bars\n`);

function sub(u: string[]): Map<string, Bar[]> {
  const m = new Map<string, Bar[]>();
  for (const s of u) { const b = all.get(s.toUpperCase()); if (b) m.set(s.toUpperCase(), b); }
  return m;
}
const MEGA = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","JPM","XOM","WMT","UNH"];
const VOL = ["NVDA","AMD","TSLA","AVGO","META","NFLX","AMZN","GOOGL"];

const variants: { name: string; universe: string[]; spec: any }[] = [
  { name: "M1 close x>SMA50 (in uptrend), exit x<SMA50 or trail12", universe: MEGA,
    spec: { entry:{ all:[{lhs:{price:"close"},op:">",rhs:{sma:200}},{lhs:{price:"close"},op:"crossesAbove",rhs:{sma:50}}] }, exit:{ any:[{lhs:{price:"close"},op:"crossesBelow",rhs:{sma:50}},{trailingStop:12}] }, sizing:{type:"equityPct",value:25}, maxPositions:4 } },
  { name: "M2 SMA20 x>SMA50 cross, exit cross-down", universe: MEGA,
    spec: { entry:{ lhs:{sma:20},op:"crossesAbove",rhs:{sma:50} }, exit:{ lhs:{sma:20},op:"crossesBelow",rhs:{sma:50} }, sizing:{type:"equityPct",value:25}, maxPositions:4 } },
  { name: "M3 20d mom>5% + SMA100, exit x<SMA20", universe: VOL,
    spec: { entry:{ all:[{lhs:{price:"close"},op:">",rhs:{sma:100}},{lhs:{returns:20},op:">",rhs:5}] }, exit:{ lhs:{price:"close"},op:"<",rhs:{sma:20} }, sizing:{type:"equityPct",value:25}, maxPositions:6 } },
  { name: "M4 50d mom>10% + SMA200, exit x<SMA50 or trail15", universe: VOL,
    spec: { entry:{ all:[{lhs:{price:"close"},op:">",rhs:{sma:200}},{lhs:{returns:50},op:">",rhs:10}] }, exit:{ any:[{lhs:{price:"close"},op:"crossesBelow",rhs:{sma:50}},{trailingStop:15}] }, sizing:{type:"equityPct",value:25}, maxPositions:6 } },
  { name: "M5 EMA20 x>EMA50 + SMA200 filter, trail10", universe: VOL,
    spec: { entry:{ all:[{lhs:{price:"close"},op:">",rhs:{sma:200}},{lhs:{ema:20},op:"crossesAbove",rhs:{ema:50}}] }, exit:{ any:[{lhs:{ema:20},op:"crossesBelow",rhs:{ema:50}},{trailingStop:10}] }, sizing:{type:"equityPct",value:25}, maxPositions:6 } },
];

console.log("variant".padEnd(50), "grade".padEnd(9), "trades", "ret%", "spy%", "beats", "permP");
console.log("-".repeat(94));
for (const v of variants) {
  const parsed = parseSpec({ version:1, universe:v.universe, direction:"long", cooldownBars:1, llmGate:null, ...v.spec });
  if ("error" in parsed) { console.log(v.name.padEnd(50), "SPEC ERR", parsed.error); continue; }
  const r = verifyStrategy(parsed, sub(v.universe), spy, { iterations: 200, variantsTried: 1 });
  if (!r.ok) { console.log(v.name.padEnd(50), "ERR", r.error); continue; }
  console.log(
    v.name.padEnd(50), r.grade.padEnd(9),
    String(r.tradeCount).padStart(5),
    String(r.baseline.ownUniverseReturnPct?.toFixed(0) ?? "?").padStart(5),
    String(r.baseline.spyReturnPct?.toFixed(0) ?? "?").padStart(5),
    String(r.baseline.beatsSpy).padStart(6),
    (r.permutationP == null ? "n/a" : r.permutationP.toFixed(3)).padStart(6),
  );
}
