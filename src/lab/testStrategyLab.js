import assert from "node:assert/strict";
import { generateCandidates } from "./candidateGenerator.js";
import { validateCandles } from "./backtestEvaluator.js";
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

const candles = Array.from({ length: 120 }, (_, index) => ({
  time: 1_700_000_000_000 + index * 300_000,
  open: 100 + index * 0.1,
  high: 101 + index * 0.1,
  low: 99 + index * 0.1,
  close: 100.5 + index * 0.1,
  volume: 1000 + index,
}));
assert.equal(validateCandles(candles).ok, true);

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
