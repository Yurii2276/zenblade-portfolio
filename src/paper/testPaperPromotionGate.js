import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_PAPER_GATE_POLICY,
  buildPaperApproval,
  evaluatePaperPromotion,
  selectPaperCandidates,
  writePaperManifest,
} from "./paperPromotionGate.js";
import { loadPaperManifest } from "./autonomousPaperEngine.js";

function experiment(overrides = {}) {
  return {
    fingerprint: overrides.fingerprint ?? "wf-good-1",
    createdAt: overrides.createdAt ?? "2026-08-27T12:00:00.000Z",
    experimentType: "strategy_lab_walk_forward",
    stage: "research",
    status: "validated",
    strategyId: "trendMomentum",
    strategyName: "Trend Momentum",
    market: "ETH-USDT",
    timeframe: "5m",
    parameters: {
      candidateId: "trendMomentum-0001",
      emaFast: 20,
      emaSlow: 50,
      minRsiForLong: 45,
      maxRsiForLong: 65,
      minVolumeFactor: 1.05,
      atrStopMultiplier: 1.2,
      atrTakeMultiplier: 1.8,
      useHtfFilter: false,
      folds: 4,
      validation: "expanding-window chronological walk-forward",
    },
    metrics: {
      score: 62,
      aggregate: {
        folds: 4,
        profitableFolds: 4,
        profitableFoldRatio: 1,
        totalTrades: 48,
        totalReturnPct: 4.2,
        medianReturnPct: 0.9,
        medianProfitFactor: 1.42,
        maxDrawdownPct: 5.5,
        worstFoldReturnPct: 0.1,
      },
    },
    ...overrides,
  };
}

const good = experiment();
const verdict = evaluatePaperPromotion(good);
assert.equal(verdict.approved, true);
assert.equal(verdict.reasons.length, 0);

const approval = buildPaperApproval({ experiment: good, verdict });
assert.equal(approval.liveTradingAllowed, false);
assert.equal(approval.mode, "paper");
assert.equal(approval.riskPolicy.riskPerTrade, 0.0025);
assert.equal(approval.riskPolicy.maxPositionValuePct, 0.1);
assert.equal(approval.graduationPolicy.requiresManualLiveApproval, true);
assert.equal(approval.strategyParameters.folds, undefined);
assert.equal(approval.strategyParameters.emaFast, 20);

const badDrawdown = experiment({
  fingerprint: "wf-bad-dd",
  metrics: {
    score: 70,
    aggregate: {
      folds: 4,
      profitableFolds: 4,
      profitableFoldRatio: 1,
      totalTrades: 60,
      totalReturnPct: 5,
      medianReturnPct: 1,
      medianProfitFactor: 1.5,
      maxDrawdownPct: 11,
      worstFoldReturnPct: 0.2,
    },
  },
});
const badVerdict = evaluatePaperPromotion(badDrawdown);
assert.equal(badVerdict.approved, false);
assert.ok(badVerdict.reasons.includes("walk_forward_drawdown_too_high"));

const olderDuplicate = experiment({
  fingerprint: "wf-old",
  createdAt: "2026-08-26T12:00:00.000Z",
});
const selected = selectPaperCandidates([olderDuplicate, good, badDrawdown], {
  ...DEFAULT_PAPER_GATE_POLICY,
  maxApprovedCandidates: 2,
});
assert.equal(selected.length, 1);
assert.equal(selected[0].experiment.fingerprint, "wf-good-1");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paper-gate-"));
try {
  const manifestFile = path.join(tempDir, "paper-approved.json");
  writePaperManifest([approval], manifestFile);
  const loaded = loadPaperManifest(manifestFile);
  assert.equal(loaded.liveTradingAllowed, false);
  assert.equal(loaded.approvals.length, 1);

  const unsafeFile = path.join(tempDir, "unsafe.json");
  fs.writeFileSync(
    unsafeFile,
    JSON.stringify({ mode: "paper-only", liveTradingAllowed: true, approvals: [] }),
    "utf8"
  );
  assert.throws(() => loadPaperManifest(unsafeFile), /unsafe_manifest/);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("Paper promotion gate tests passed.");
