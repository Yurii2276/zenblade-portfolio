import assert from "node:assert/strict";
import { classifyMarketRegime, summarizeTradeRegimes } from "./regimeDetector.js";

function candlesFromCloses(closes) {
  return closes.map((close, index) => ({
    time: 1_700_000_000_000 + index * 300_000,
    open: close,
    high: close * 1.001,
    low: close * 0.999,
    close,
    volume: 1000 + index,
  }));
}

const bullCloses = Array.from({ length: 180 }, (_, index) =>
  100 + index * 0.12 + Math.sin(index / 8) * 0.08
);
const bullCandles = candlesFromCloses(bullCloses);
const bull = classifyMarketRegime(bullCandles);
assert.equal(bull.trend, "bull");
assert.ok(["low_vol", "normal_vol", "high_vol"].includes(bull.volatility));
assert.ok(bull.confidence > 0);

const bearCloses = Array.from({ length: 180 }, (_, index) =>
  130 - index * 0.12 + Math.sin(index / 7) * 0.08
);
const bear = classifyMarketRegime(candlesFromCloses(bearCloses));
assert.equal(bear.trend, "bear");

const sidewaysCloses = Array.from({ length: 180 }, (_, index) =>
  100 + Math.sin(index / 3) * 0.45
);
const sidewaysCandles = candlesFromCloses(sidewaysCloses);
const sideways = classifyMarketRegime(sidewaysCandles);
assert.equal(sideways.trend, "sideways");

const early = classifyMarketRegime(bullCandles, 20);
assert.equal(early.key, "unknown");

const trades = [
  {
    entryTime: bullCandles[100].time,
    exitTime: bullCandles[105].time,
    netPnl: 4,
    fees: 0.2,
  },
  {
    entryTime: bullCandles[120].time,
    exitTime: bullCandles[125].time,
    netPnl: 3,
    fees: 0.2,
  },
  {
    entryTime: bullCandles[140].time,
    exitTime: bullCandles[145].time,
    netPnl: -1,
    fees: 0.2,
  },
];

const summary = summarizeTradeRegimes(bullCandles, trades);
assert.ok(summary.regimesObserved >= 1);
assert.equal(summary.unknownTrades, 0);
assert.ok(summary.bestRegime);
const totalBucketTrades = Object.values(summary.byRegime)
  .reduce((sum, item) => sum + item.trades, 0);
assert.equal(totalBucketTrades, 3);
assert.ok(summary.profitableRegimes.length >= 1);

console.log("Market Regime Detector v1 tests passed.");
