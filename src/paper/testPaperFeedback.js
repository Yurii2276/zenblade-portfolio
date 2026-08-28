import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyFeedbackToManifest,
  evaluatePaperFeedback,
  runPaperFeedback,
  summarizeApprovalPaperPerformance,
} from "./paperFeedback.js";

function approval(id, approvedAt = "2026-07-20T00:00:00.000Z") {
  return {
    approvalId: `paper:${id}`,
    approvedAt,
    parentExperimentFingerprint: id,
    candidateId: `candidate-${id}`,
    strategyId: "trendMomentum",
    strategyName: "Trend Momentum",
    symbol: "ETH-USDT",
    timeframe: "5m",
    strategyParameters: {
      emaFast: 12,
      emaSlow: 26,
      minRsiForLong: 45,
      maxRsiForLong: 65,
      minVolumeFactor: 1.05,
      atrStopMultiplier: 1.2,
      atrTakeMultiplier: 2.2,
      useHtfFilter: false,
    },
    graduationPolicy: {
      minClosedTrades: 50,
      minDays: 21,
      requiresManualLiveApproval: true,
    },
    riskPolicy: {
      riskPerTrade: 0.0025,
      maxPositionValuePct: 0.1,
      maxOpenPositionsPerCandidate: 1,
      maxTotalOpenPositions: 3,
      maxDailyLossPct: 1,
      maxPaperDrawdownPct: 5,
    },
    mode: "paper",
    liveTradingAllowed: false,
  };
}

function makeTrades(approvalId, pnls, startDay = 1) {
  return pnls.map((pnl, index) => ({
    id: `${approvalId}:${index}`,
    approvalId,
    status: "CLOSED",
    strategyId: "trendMomentum",
    symbol: "ETH-USDT",
    netPnlUSDT: pnl,
    feesUSDT: 0.05,
    closedAt: new Date(Date.UTC(2026, 7, startDay + index, 12, 0, 0)).toISOString(),
    marketRegimeAtEntry: {
      key: index % 2 === 0 ? "bull_normal_vol" : "sideways_low_vol",
    },
  }));
}

const now = new Date("2026-08-28T12:00:00.000Z");
const watchApproval = approval("watch");
const demotedApproval = approval("demoted");
const provenApproval = approval("proven");

const watchTrades = makeTrades(watchApproval.approvalId, [1, -0.5, 1.2, -0.4, 0.8], 20);
const demotedTrades = makeTrades(demotedApproval.approvalId, Array(12).fill(-2), 1);
const provenPnls = Array.from({ length: 50 }, (_, index) =>
  index % 5 === 4 ? -1 : 2
);
const provenTrades = makeTrades(provenApproval.approvalId, provenPnls, 1);

const watchStats = summarizeApprovalPaperPerformance({
  approval: watchApproval,
  trades: watchTrades,
  initialBalance: 1000,
  now,
});
const watchVerdict = evaluatePaperFeedback({ approval: watchApproval, stats: watchStats });
assert.equal(watchVerdict.status, "paper_watch");
assert.equal(watchVerdict.microLiveCandidate, false);

const demotedStats = summarizeApprovalPaperPerformance({
  approval: demotedApproval,
  trades: demotedTrades,
  initialBalance: 1000,
  now,
});
const demotedVerdict = evaluatePaperFeedback({
  approval: demotedApproval,
  stats: demotedStats,
});
assert.equal(demotedVerdict.status, "paper_demoted");
assert.ok(demotedVerdict.reasons.includes("loss_streak_limit"));

const provenStats = summarizeApprovalPaperPerformance({
  approval: provenApproval,
  trades: provenTrades,
  initialBalance: 1000,
  now,
});
const provenVerdict = evaluatePaperFeedback({
  approval: provenApproval,
  stats: provenStats,
});
assert.equal(provenStats.closedTrades, 50);
assert.ok(provenStats.returnPct > 1);
assert.ok(provenStats.profitFactor > 1.25);
assert.equal(provenVerdict.status, "paper_proven");
assert.equal(provenVerdict.microLiveCandidate, true);
assert.equal(provenVerdict.requiresManualLiveApproval, true);

const safeManifest = applyFeedbackToManifest(
  {
    schemaVersion: 1,
    mode: "paper-only",
    liveTradingAllowed: false,
    approvals: [watchApproval, demotedApproval, provenApproval],
  },
  [
    { approval: watchApproval, stats: watchStats, verdict: watchVerdict, updatedAt: now.toISOString() },
    { approval: demotedApproval, stats: demotedStats, verdict: demotedVerdict, updatedAt: now.toISOString() },
    { approval: provenApproval, stats: provenStats, verdict: provenVerdict, updatedAt: now.toISOString() },
  ]
);
assert.equal(safeManifest.liveTradingAllowed, false);
assert.equal(safeManifest.approvals.length, 2);
assert.equal(
  safeManifest.approvals.some((item) => item.approvalId === demotedApproval.approvalId),
  false
);
assert.equal(
  safeManifest.approvals.find((item) => item.approvalId === provenApproval.approvalId)
    .paperFeedback.microLiveCandidate,
  true
);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paper-feedback-v1-"));
try {
  const manifestFile = path.join(tempDir, "paper-approved.json");
  const tradesFile = path.join(tempDir, "paper-trades.json");
  const stateFile = path.join(tempDir, "paper-state.json");
  const feedbackFile = path.join(tempDir, "paper-feedback.json");
  const experimentsFile = path.join(tempDir, "experiments.ndjson");

  fs.writeFileSync(
    manifestFile,
    JSON.stringify({
      schemaVersion: 1,
      mode: "paper-only",
      liveTradingAllowed: false,
      approvals: [watchApproval, demotedApproval, provenApproval],
    }),
    "utf8"
  );
  fs.writeFileSync(
    tradesFile,
    JSON.stringify([...watchTrades, ...demotedTrades, ...provenTrades]),
    "utf8"
  );
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ initialBalance: 1000, mode: "paper-only", liveTradingAllowed: false }),
    "utf8"
  );

  const result = runPaperFeedback({
    manifestFile,
    tradesFile,
    stateFile,
    feedbackFile,
    now,
    experimentStoreOptions: { filePath: experimentsFile },
  });

  assert.equal(result.status, "success");
  assert.equal(result.watch, 1);
  assert.equal(result.demoted, 1);
  assert.equal(result.proven, 1);
  assert.equal(result.activeApprovals, 2);
  assert.equal(fs.existsSync(feedbackFile), true);
  assert.equal(fs.existsSync(experimentsFile), true);

  const persistedManifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  assert.equal(persistedManifest.liveTradingAllowed, false);
  assert.equal(persistedManifest.approvals.length, 2);

  const experiments = fs
    .readFileSync(experimentsFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(experiments.length, 3);
  assert.ok(experiments.some((item) => item.status === "paper_demoted"));
  assert.ok(experiments.some((item) => item.status === "paper_proven"));
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("Paper Feedback / Auto-Demotion v1 tests passed.");
