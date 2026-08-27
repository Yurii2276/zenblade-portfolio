import assert from "node:assert/strict";
import { generateCandidates } from "./candidateGenerator.js";
import { runLongBacktest, validateCandles } from "./backtestEvaluator.js";
import { scoreCandidate } from "./strategyScorer.js";

const first = generateCandidates({
  strategies: ["trendMomentum", "trendPullback"],
  candidatesPerStrategy: 4,
  seed: "test-seed",
});
const second = generateCandidates({
  strategies: ["trendMomentum", "trendPullback"],
  candidatesPerStrategy: 4,
  seed: "test-seed",
});

assert.equal(first.length, 8);
assert.deepEqual(first, second);
assert.equal(new Set(first.map((candidate) => JSON.stringify(candidate))).size, 8);

const candles = Array.from({ length: 180 }, (_, index) => {
  const close = 100 + index * 0.2;
  return {
    time: 1_700_000_000_000 + index * 300_000,
    open: close - 0.1,
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: 1000 + index,
  };
});
assert.equal(validateCandles(candles).ok, true);

const syntheticBacktest = runLongBacktest({
  candles,
  testConfig: {
    activeStrategy: "trendMomentum",
    emaFast: 9,
    emaSlow: 21,
    rsiPeriod: 14,
    atrPeriod: 14,
    volumePeriod: 20,
    useHtfFilter: false,
    minRsiForLong: 0,
    maxRsiForLong: 100,
    minVolumeFactor: 0.5,
    maxVolumeFactor: null,
    riskPerTrade: 0.01,
    maxPositionValuePct: 0.3,
    atrStopMultiplier: 1,
    atrTakeMultiplier: 1.5,
    feeRate: 0.0008,
  },
});
assert.ok(syntheticBacktest.metrics.totalTrades > 0);
assert.ok(syntheticBacktest.metrics.totalFeesUSDT > 0);
assert.ok(Number.isFinite(syntheticBacktest.metrics.finalBalanceUSDT));

const good = scoreCandidate({
  trainMetrics: {
    totalTrades: 30,
    returnPct: 4.2,
    profitFactor: 1.45,
  },
  testMetrics: {
    totalTrades: 14,
    returnPct: 1.8,
    profitFactor: 1.35,
    maxDrawdownPct: 3.5,
    winRatePct: 57,
  },
});
assert.equal(good.status, "candidate");

const bad = scoreCandidate({
  trainMetrics: {
    totalTrades: 30,
    returnPct: 5,
    profitFactor: 1.5,
  },
  testMetrics: {
    totalTrades: 8,
    returnPct: -2,
    profitFactor: 0.7,
    maxDrawdownPct: 9,
    winRatePct: 40,
  },
});
assert.equal(bad.status, "rejected");
assert.ok(bad.reasons.includes("test_not_profitable"));

console.log("Strategy Lab unit tests passed.");
