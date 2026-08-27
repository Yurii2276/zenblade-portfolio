import assert from "node:assert/strict";
import {
  aggregateWalkForward,
  buildWalkForwardWindows,
  runWalkForwardCandidate,
  scoreWalkForward,
} from "./walkForwardValidator.js";
import { selectHoldoutCandidates } from "./walkForwardLab.js";

const windows = buildWalkForwardWindows({
  candleCount: 1400,
  folds: 4,
  minTrainCandles: 600,
  minTestCandles: 150,
});
assert.equal(windows.length, 4);
assert.deepEqual(windows.map((item) => item.testCandles), [200, 200, 200, 200]);
assert.equal(windows[0].testStart, 600);
assert.equal(windows.at(-1).testEnd, 1400);

const goodFolds = [
  { testMetrics: { returnPct: 1.2, profitFactor: 1.35, maxDrawdownPct: 3, totalTrades: 9 } },
  { testMetrics: { returnPct: 0.8, profitFactor: 1.25, maxDrawdownPct: 4, totalTrades: 8 } },
  { testMetrics: { returnPct: -0.2, profitFactor: 0.95, maxDrawdownPct: 5, totalTrades: 7 } },
  { testMetrics: { returnPct: 1.5, profitFactor: 1.5, maxDrawdownPct: 3.5, totalTrades: 10 } },
];
const aggregate = aggregateWalkForward(goodFolds);
assert.equal(aggregate.profitableFolds, 3);
assert.equal(aggregate.totalTrades, 34);
assert.equal(aggregate.profitableFoldRatio, 0.75);
assert.equal(scoreWalkForward(aggregate).status, "validated");

const badAggregate = aggregateWalkForward([
  { testMetrics: { returnPct: -4, profitFactor: 0.6, maxDrawdownPct: 8, totalTrades: 7 } },
  { testMetrics: { returnPct: -6, profitFactor: 0.5, maxDrawdownPct: 13, totalTrades: 6 } },
  { testMetrics: { returnPct: 0.2, profitFactor: 1.05, maxDrawdownPct: 3, totalTrades: 5 } },
  { testMetrics: { returnPct: -1, profitFactor: 0.8, maxDrawdownPct: 5, totalTrades: 6 } },
]);
const badVerdict = scoreWalkForward(badAggregate);
assert.equal(badVerdict.status, "rejected");
assert.ok(badVerdict.reasons.includes("catastrophic_fold_loss"));

const experiments = [
  {
    experimentType: "strategy_lab_holdout",
    status: "candidate",
    strategyId: "trendMomentum",
    market: "ETH-USDT",
    createdAt: "2026-08-27T10:00:00Z",
    parameters: { candidateId: "old", emaFast: 9, emaSlow: 21, split: "70/30" },
  },
  {
    experimentType: "strategy_lab_holdout",
    status: "candidate",
    strategyId: "trendMomentum",
    market: "ETH-USDT",
    createdAt: "2026-08-27T11:00:00Z",
    parameters: { candidateId: "new", emaFast: 9, emaSlow: 21, split: "70/30" },
  },
  {
    experimentType: "strategy_lab_holdout",
    status: "watch",
    strategyId: "trendPullback",
    market: "BTC-USDT",
    createdAt: "2026-08-27T12:00:00Z",
    parameters: { candidateId: "watch", emaFast: 20, emaSlow: 50, split: "70/30" },
  },
];
const selected = selectHoldoutCandidates(experiments, { maxCandidates: 10 });
assert.equal(selected.length, 1);
assert.equal(selected[0].parameters.candidateId, "new");

const candles = Array.from({ length: 1400 }, (_, index) => {
  const trend = 100 + index * 0.04;
  const wave = Math.sin(index / 8) * 0.7;
  const close = trend + wave;
  const open = close - Math.sin(index / 5) * 0.15;
  return {
    time: 1_700_000_000_000 + index * 300_000,
    open,
    high: Math.max(open, close) + 0.45,
    low: Math.min(open, close) - 0.45,
    close,
    volume: 1200 + (index % 10) * 20,
  };
});

const result = runWalkForwardCandidate({
  candles,
  htfCandles: null,
  testConfig: {
    activeStrategy: "trendMomentum",
    riskPerTrade: 0.01,
    maxPositionValuePct: 0.3,
    feeRate: 0.0008,
    emaFast: 9,
    emaSlow: 21,
    rsiPeriod: 14,
    atrPeriod: 14,
    volumePeriod: 20,
    minRsiForLong: 0,
    maxRsiForLong: 100,
    minVolumeFactor: 0.9,
    maxVolumeFactor: null,
    atrStopMultiplier: 1.2,
    atrTakeMultiplier: 1.8,
    useHtfFilter: false,
    htfEmaFast: 20,
    htfEmaSlow: 50,
  },
  initialBalance: 1000,
  folds: 4,
  minTrainCandles: 600,
  minTestCandles: 150,
});
assert.equal(result.foldResults.length, 4);
assert.equal(result.aggregate.folds, 4);
assert.ok(Number.isFinite(result.verdict.score));
assert.ok(["validated", "watch", "rejected"].includes(result.verdict.status));

console.log("Walk-forward validator tests passed.");
