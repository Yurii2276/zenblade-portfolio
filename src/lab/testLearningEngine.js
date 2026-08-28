import assert from "node:assert/strict";
import { candidateParameterKey } from "./candidateGenerator.js";
import {
  cleanStrategyParameters,
  generateLearningCandidates,
  isEligibleParent,
  mutateParentParameters,
  selectLearningParents,
} from "./learningEngine.js";

const baseParameters = {
  candidateId: "parent-1",
  emaFast: 12,
  emaSlow: 26,
  minRsiForLong: 45,
  maxRsiForLong: 65,
  minVolumeFactor: 1.05,
  atrStopMultiplier: 1.2,
  atrTakeMultiplier: 2.2,
  useHtfFilter: true,
  split: "70/30 chronological holdout",
  learning: { origin: "exploration" },
};

const strategyParameters = cleanStrategyParameters(baseParameters);

const strongWatch = {
  id: "holdout-watch",
  fingerprint: "fp-watch",
  experimentType: "strategy_lab_holdout",
  strategyId: "trendMomentum",
  market: "SOL-USDT",
  status: "watch",
  createdAt: "2026-08-28T08:00:00Z",
  parameters: baseParameters,
  metrics: {
    score: 42,
    test: {
      returnPct: 0.83,
      profitFactor: 1.63,
      totalTrades: 21,
      maxDrawdownPct: 0.41,
    },
  },
};

const validatedWalkForward = {
  id: "wf-validated",
  fingerprint: "fp-wf",
  experimentType: "strategy_lab_walk_forward",
  strategyId: "trendMomentum",
  market: "ETH-USDT",
  status: "validated",
  createdAt: "2026-08-28T09:00:00Z",
  parameters: {
    ...baseParameters,
    candidateId: "wf-parent",
    folds: 4,
    validation: "expanding-window chronological walk-forward",
    parentHoldoutStatus: "candidate",
  },
  metrics: {
    score: 70,
    aggregate: {
      totalReturnPct: 2.4,
      medianProfitFactor: 1.38,
      totalTrades: 34,
      maxDrawdownPct: 4.2,
    },
  },
};

const paperProven = {
  id: "paper-proven",
  fingerprint: "fp-paper-proven",
  experimentType: "paper_feedback",
  strategyId: "trendMomentum",
  market: "BTC-USDT",
  status: "paper_proven",
  createdAt: "2026-08-28T10:00:00Z",
  parameters: {
    approvalId: "paper:fp-paper-proven",
    parentExperimentFingerprint: "fp-parent-wf",
    strategyParameters,
  },
  metrics: {
    closedTrades: 55,
    returnPct: 3.1,
    profitFactor: 1.48,
    maxDrawdownPct: 2.2,
  },
};

const paperDemoted = {
  id: "paper-demoted",
  fingerprint: "fp-paper-demoted",
  experimentType: "paper_feedback",
  strategyId: "trendMomentum",
  market: "BTC-USDT",
  status: "paper_demoted",
  createdAt: "2026-08-28T10:30:00Z",
  parameters: {
    approvalId: "paper:fp-paper-demoted",
    strategyParameters,
  },
  metrics: {
    closedTrades: 18,
    returnPct: -2.1,
    profitFactor: 0.55,
    maxDrawdownPct: 2.8,
  },
};

const rejected = {
  id: "rejected",
  fingerprint: "fp-rejected",
  experimentType: "strategy_lab_holdout",
  strategyId: "trendMomentum",
  market: "BTC-USDT",
  status: "rejected",
  parameters: baseParameters,
  metrics: {
    score: 100,
    test: {
      returnPct: 5,
      profitFactor: 2,
      totalTrades: 20,
      maxDrawdownPct: 2,
    },
  },
};

assert.equal(isEligibleParent(strongWatch), true);
assert.equal(isEligibleParent(validatedWalkForward), true);
assert.equal(isEligibleParent(paperProven), true);
assert.equal(isEligibleParent(paperDemoted), false);
assert.equal(isEligibleParent(rejected), false);

const cleaned = cleanStrategyParameters(validatedWalkForward.parameters);
assert.equal(cleaned.candidateId, undefined);
assert.equal(cleaned.folds, undefined);
assert.equal(cleaned.validation, undefined);
assert.equal(cleaned.parentHoldoutStatus, undefined);
assert.equal(cleaned.learning, undefined);
assert.equal(cleaned.emaFast, 12);

const parents = selectLearningParents(
  [strongWatch, validatedWalkForward, paperProven, paperDemoted, rejected],
  "trendMomentum",
  { maxParents: 5 }
);
assert.equal(parents.length, 3);
assert.equal(parents[0].experiment.id, "paper-proven");
assert.equal(parents[0].parameters.emaFast, 12);
assert.equal(parents.some((item) => item.experiment.id === "paper-demoted"), false);

const mutation = mutateParentParameters(
  "trendMomentum",
  cleanStrategyParameters(baseParameters),
  "deterministic-test"
);
assert.notDeepEqual(mutation, cleanStrategyParameters(baseParameters));
assert.ok(Number.isFinite(mutation.emaFast));
assert.ok(Number.isFinite(mutation.emaSlow));

const learned = generateLearningCandidates({
  experiments: [strongWatch, validatedWalkForward, paperProven, paperDemoted, rejected],
  strategies: ["trendMomentum"],
  candidatesPerStrategy: 8,
  explorationFraction: 0.25,
  seed: "learning-engine-test",
});
assert.equal(learned.length, 8);
assert.equal(learned.filter((item) => item.origin === "exploration").length, 2);
assert.equal(learned.filter((item) => item.origin === "learned").length, 6);
assert.ok(
  learned
    .filter((item) => item.origin === "learned")
    .every((item) => item.lineage?.parentFingerprint)
);
assert.ok(
  learned.some(
    (item) =>
      item.origin === "learned" &&
      item.lineage?.parentExperimentType === "paper_feedback"
  )
);

const uniqueKeys = new Set(
  learned.map((item) => candidateParameterKey(item.strategyName, item.parameters))
);
assert.equal(uniqueKeys.size, learned.length);

const coldStart = generateLearningCandidates({
  experiments: [],
  strategies: ["trendPullback"],
  candidatesPerStrategy: 5,
  explorationFraction: 0.25,
  seed: "cold-start-test",
});
assert.equal(coldStart.length, 5);
assert.ok(coldStart.every((item) => item.origin === "exploration"));

console.log("Learning Engine v1 tests passed.");
