import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  calculatePaperRiskState,
  createInitialPaperState,
  evaluatePositionExit,
  planPaperEntry,
  runAutonomousPaperOnce,
} from "./autonomousPaperEngine.js";

const approval = {
  approvalId: "paper:test",
  approvedAt: "2026-01-01T00:00:00.000Z",
  parentExperimentFingerprint: "wf-test",
  candidateId: "trendMomentum-0001",
  strategyId: "trendMomentum",
  strategyName: "Trend Momentum",
  symbol: "ETH-USDT",
  timeframe: "5m",
  strategyParameters: {
    atrStopMultiplier: 1.2,
    atrTakeMultiplier: 1.8,
    useHtfFilter: false,
  },
  riskPolicy: {
    riskPerTrade: 0.01,
    maxPositionValuePct: 0.5,
    maxOpenPositionsPerCandidate: 1,
    maxTotalOpenPositions: 3,
    maxDailyLossPct: 1,
    maxPaperDrawdownPct: 5,
  },
  mode: "paper",
  liveTradingAllowed: false,
};

const state = createInitialPaperState(1000);
const signal = {
  action: "BUY",
  reason: "test signal",
  indicators: {
    lastClose: 100,
    atr14: 2,
  },
};
const candle = {
  time: Date.now(),
  open: 99,
  high: 101,
  low: 98,
  close: 100,
  volume: 1000,
};

const position = planPaperEntry({ approval, signal, state, candle });
assert.ok(position);
assert.equal(position.side, "LONG");
assert.ok(position.riskAmountUSDT <= 2.5);
assert.ok(position.positionValueUSDT <= 100);
assert.equal(position.feeRate, 0.0008);

assert.deepEqual(
  evaluatePositionExit(
    { stopPrice: 95, takePrice: 105 },
    { low: 94, high: 106 }
  ),
  { closePrice: 95, closeReason: "STOP_LOSS" }
);
assert.deepEqual(
  evaluatePositionExit(
    { stopPrice: 95, takePrice: 105 },
    { low: 96, high: 106 }
  ),
  { closePrice: 105, closeReason: "TAKE_PROFIT" }
);

const losingState = {
  ...createInitialPaperState(1000),
  balance: 989,
  dayStartBalance: 1000,
  peakBalance: 1000,
};
const risk = calculatePaperRiskState(losingState, [approval]);
assert.equal(risk.pausedReason, "daily_loss_limit");
assert.equal(risk.maxDailyLossPct, 1);

const drawdownState = {
  ...createInitialPaperState(1000),
  balance: 940,
  dayStartBalance: 940,
  peakBalance: 1000,
};
const ddRisk = calculatePaperRiskState(drawdownState, [approval]);
assert.equal(ddRisk.pausedReason, "paper_drawdown_limit");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-paper-"));
try {
  const stateFile = path.join(tempDir, "state.json");
  const tradesFile = path.join(tempDir, "trades.json");
  const emptyManifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: "paper-only",
    liveTradingAllowed: false,
    approvals: [],
  };

  const result = await runAutonomousPaperOnce({
    manifest: emptyManifest,
    stateFile,
    tradesFile,
  });
  assert.equal(result.approvals, 0);
  assert.equal(result.state.liveTradingAllowed, false);
  assert.equal(result.state.mode, "paper-only");
  assert.equal(result.trades.length, 0);
  assert.equal(fs.existsSync(stateFile), true);
  assert.equal(fs.existsSync(tradesFile), true);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("Autonomous paper engine tests passed.");
