import assert from "node:assert/strict";
import {
  buildRegimeEvidenceFromWalkForward,
  rankApprovalsForRegime,
  regimeCompatibility,
} from "./metaSelector.js";

const walkForwardExperiment = {
  metrics: {
    folds: [
      {
        test: {
          regimeSummary: {
            byRegime: {
              bull_normal_vol: {
                trades: 6,
                netPnlUSDT: 8,
                profitFactor: 1.5,
              },
              sideways_normal_vol: {
                trades: 4,
                netPnlUSDT: -2,
                profitFactor: 0.8,
              },
            },
          },
        },
      },
      {
        test: {
          regimeSummary: {
            byRegime: {
              bull_normal_vol: {
                trades: 7,
                netPnlUSDT: 6,
                profitFactor: 1.35,
              },
              sideways_normal_vol: {
                trades: 5,
                netPnlUSDT: -3,
                profitFactor: 0.7,
              },
            },
          },
        },
      },
    ],
  },
};

const evidence = buildRegimeEvidenceFromWalkForward(walkForwardExperiment);
assert.equal(evidence.byRegime.bull_normal_vol.foldsObserved, 2);
assert.equal(evidence.byRegime.bull_normal_vol.trades, 13);
assert.equal(evidence.byRegime.bull_normal_vol.netPnlUSDT, 14);
assert.equal(evidence.byRegime.bull_normal_vol.positiveFoldRatio, 1);
assert.equal(evidence.byRegime.sideways_normal_vol.netPnlUSDT, -5);

const supportiveApproval = {
  approvalId: "paper:supportive",
  strategyId: "trendMomentum",
  symbol: "ETH-USDT",
  researchEvidence: {
    rankScore: 80,
    regimeEvidence: evidence,
  },
};
const neutralApproval = {
  approvalId: "paper:neutral",
  strategyId: "trendPullback",
  symbol: "ETH-USDT",
  researchEvidence: {
    rankScore: 90,
    regimeEvidence: { byRegime: {} },
  },
};

const supportive = regimeCompatibility(supportiveApproval, "bull_normal_vol");
assert.equal(supportive.status, "supportive");
assert.ok(supportive.scoreAdjustment > 0);

const adverse = regimeCompatibility(supportiveApproval, "sideways_normal_vol");
assert.equal(adverse.status, "adverse");
assert.ok(adverse.scoreAdjustment < 0);

const rankedBull = rankApprovalsForRegime(
  [neutralApproval, supportiveApproval],
  {
    "ETH-USDT": {
      key: "bull_normal_vol",
      trend: "bull",
      volatility: "normal_vol",
    },
  }
);
assert.equal(rankedBull[0].approval.approvalId, "paper:supportive");
assert.equal(rankedBull[0].compatibility.status, "supportive");

const rankedUnknown = rankApprovalsForRegime(
  [neutralApproval, supportiveApproval],
  {}
);
assert.equal(rankedUnknown[0].approval.approvalId, "paper:neutral");
assert.equal(rankedUnknown[0].compatibility.status, "neutral");

console.log("Meta Selector v1 tests passed.");
