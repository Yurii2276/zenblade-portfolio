import fs from "node:fs";
import path from "node:path";
import { config as baseConfig } from "../config.js";
import { fetchHistoricalCandles } from "../okxClient.js";
import { getSignal } from "../strategy.js";
import { calculateLongTrade } from "../riskManager.js";
import { validateCandles } from "../lab/backtestEvaluator.js";

const MANIFEST_PATH = path.resolve(
  process.env.PAPER_APPROVED_MANIFEST || "data/brain/paper-approved.json"
);
const STATE_PATH = path.resolve(
  process.env.AUTONOMOUS_PAPER_STATE || "data/brain/autonomous-paper-state.json"
);
const TRADES_PATH = path.resolve(
  process.env.AUTONOMOUS_PAPER_TRADES || "data/brain/autonomous-paper-trades.json"
);

const SUPPORTED_PAPER_STRATEGIES = new Set([
  "trendMomentum",
  "trendPullback",
  "breakoutRetest",
]);

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return structuredClone(fallback);
  }
}

function writeJson(filePath, value) {
  ensureParent(filePath);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

export function loadPaperManifest(filePath = MANIFEST_PATH) {
  const manifest = readJson(filePath, null);
  if (!manifest) throw new Error(`paper_manifest_not_found:${filePath}`);
  if (manifest.liveTradingAllowed !== false || manifest.mode !== "paper-only") {
    throw new Error("unsafe_manifest_live_trading_not_explicitly_disabled");
  }
  if (!Array.isArray(manifest.approvals)) {
    throw new Error("invalid_paper_manifest");
  }
  return manifest;
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

export function createInitialPaperState(initialBalance = baseConfig.initialBalance ?? 1000) {
  return {
    schemaVersion: 1,
    mode: "paper-only",
    liveTradingAllowed: false,
    initialBalance,
    balance: initialBalance,
    peakBalance: initialBalance,
    day: todayUtc(),
    dayStartBalance: initialBalance,
    openPositions: [],
    lastProcessedCandleByApproval: {},
    pausedReason: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function refreshDay(state) {
  const day = todayUtc();
  if (state.day !== day) {
    state.day = day;
    state.dayStartBalance = state.balance;
    if (state.pausedReason === "daily_loss_limit") state.pausedReason = null;
  }
}

export function calculatePaperRiskState(state, approvals) {
  const policies = approvals.map((approval) => approval.riskPolicy ?? {});
  const maxDailyLossPct = Math.min(
    ...policies.map((policy) => Number(policy.maxDailyLossPct ?? 1))
  );
  const maxPaperDrawdownPct = Math.min(
    ...policies.map((policy) => Number(policy.maxPaperDrawdownPct ?? 5))
  );
  const maxTotalOpenPositions = Math.min(
    ...policies.map((policy) => Number(policy.maxTotalOpenPositions ?? 3))
  );

  const dayLossPct = state.dayStartBalance > 0
    ? ((state.dayStartBalance - state.balance) / state.dayStartBalance) * 100
    : 0;
  const drawdownPct = state.peakBalance > 0
    ? ((state.peakBalance - state.balance) / state.peakBalance) * 100
    : 0;

  let pausedReason = null;
  if (dayLossPct >= maxDailyLossPct) pausedReason = "daily_loss_limit";
  if (drawdownPct >= maxPaperDrawdownPct) pausedReason = "paper_drawdown_limit";

  return {
    dayLossPct: round(dayLossPct, 3),
    drawdownPct: round(drawdownPct, 3),
    maxDailyLossPct,
    maxPaperDrawdownPct,
    maxTotalOpenPositions,
    pausedReason,
  };
}

function closeLongPosition(position, closePrice, closeReason, balance) {
  const grossPnl = (closePrice - position.entryPrice) * position.size;
  const fees =
    (position.entryPrice + closePrice) * position.size * position.feeRate;
  const netPnl = grossPnl - fees;
  const nextBalance = balance + netPnl;

  return {
    nextBalance,
    trade: {
      ...position,
      status: "CLOSED",
      closePrice: round(closePrice, 8),
      closeReason,
      grossPnlUSDT: round(grossPnl, 4),
      feesUSDT: round(fees, 4),
      netPnlUSDT: round(netPnl, 4),
      closedAt: new Date().toISOString(),
      balanceAfterCloseUSDT: round(nextBalance, 4),
    },
  };
}

export function evaluatePositionExit(position, candle) {
  if (candle.low <= position.stopPrice) {
    return { closePrice: position.stopPrice, closeReason: "STOP_LOSS" };
  }
  if (candle.high >= position.takePrice) {
    return { closePrice: position.takePrice, closeReason: "TAKE_PROFIT" };
  }
  return null;
}

function countOpenForApproval(state, approvalId) {
  return state.openPositions.filter(
    (position) => position.approvalId === approvalId && position.status === "OPEN"
  ).length;
}

export function planPaperEntry({ approval, signal, state, candle }) {
  if (!SUPPORTED_PAPER_STRATEGIES.has(approval.strategyId)) return null;
  if (signal?.action !== "BUY" || !signal.indicators) return null;

  const riskPolicy = approval.riskPolicy ?? {};
  const testConfig = {
    ...baseConfig,
    ...(approval.strategyParameters ?? {}),
    activeStrategy: approval.strategyId,
    riskPerTrade: Math.min(Number(riskPolicy.riskPerTrade ?? 0.0025), 0.0025),
    maxPositionValuePct: Math.min(
      Number(riskPolicy.maxPositionValuePct ?? 0.1),
      0.1
    ),
    mode: "paper",
    paperOnly: true,
    telegramEnabled: false,
  };

  const entryPrice = Number(signal.indicators.lastClose ?? candle.close);
  const atr = Number(signal.indicators.atr14);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;
  if (!Number.isFinite(atr) || atr <= 0) return null;

  const planned = calculateLongTrade({
    balance: state.balance,
    entryPrice,
    atr,
    config: testConfig,
  });
  if (!Number.isFinite(planned.size) || planned.size <= 0) return null;

  return {
    id: `${approval.approvalId}:${candle.time}`,
    approvalId: approval.approvalId,
    parentExperimentFingerprint: approval.parentExperimentFingerprint,
    candidateId: approval.candidateId,
    strategyId: approval.strategyId,
    strategyName: approval.strategyName,
    symbol: approval.symbol,
    timeframe: approval.timeframe,
    side: "LONG",
    status: "OPEN",
    entryTime: candle.time,
    openedAt: new Date().toISOString(),
    entryPrice: planned.entryPrice,
    stopPrice: planned.stopPrice,
    takePrice: planned.takePrice,
    size: planned.size,
    positionValueUSDT: planned.positionValue,
    riskAmountUSDT: planned.riskAmount,
    feeRate: testConfig.feeRate,
    signalReason: signal.reason,
    signalIndicators: signal.indicators,
  };
}

async function loadApprovalMarketData(approval) {
  const candles = await fetchHistoricalCandles({
    symbol: approval.symbol,
    bar: approval.timeframe ?? baseConfig.bar,
    targetLimit: 400,
  });
  const quality = validateCandles(candles);
  if (!quality.ok) throw new Error(`${approval.symbol}:${quality.reason}`);

  const useHtfFilter = approval.strategyParameters?.useHtfFilter === true;
  const htfCandles = useHtfFilter
    ? await fetchHistoricalCandles({
        symbol: approval.symbol,
        bar: baseConfig.htfBar,
        targetLimit: Math.max(baseConfig.htfCandlesLimit ?? 500, 500),
      })
    : null;

  return { candles, htfCandles };
}

function buildSignalConfig(approval) {
  const riskPolicy = approval.riskPolicy ?? {};
  return {
    ...baseConfig,
    ...(approval.strategyParameters ?? {}),
    symbol: approval.symbol,
    symbols: [approval.symbol],
    bar: approval.timeframe ?? baseConfig.bar,
    activeStrategy: approval.strategyId,
    riskPerTrade: Math.min(Number(riskPolicy.riskPerTrade ?? 0.0025), 0.0025),
    maxPositionValuePct: Math.min(
      Number(riskPolicy.maxPositionValuePct ?? 0.1),
      0.1
    ),
    paperOnly: true,
    mode: "paper",
    telegramEnabled: false,
  };
}

export async function runAutonomousPaperOnce(options = {}) {
  const manifest = options.manifest ?? loadPaperManifest(options.manifestFile);
  const approvals = manifest.approvals.filter(
    (approval) =>
      approval.liveTradingAllowed === false &&
      approval.mode === "paper" &&
      SUPPORTED_PAPER_STRATEGIES.has(approval.strategyId)
  );

  const stateFile = options.stateFile ?? STATE_PATH;
  const tradesFile = options.tradesFile ?? TRADES_PATH;
  const marketLoader = options.marketLoader ?? loadApprovalMarketData;
  const initialBalance = baseConfig.initialBalance ?? 1000;
  const state = readJson(stateFile, createInitialPaperState(initialBalance));
  const trades = readJson(tradesFile, []);

  if (state.liveTradingAllowed !== false || state.mode !== "paper-only") {
    throw new Error("unsafe_paper_state");
  }

  refreshDay(state);
  state.peakBalance = Math.max(Number(state.peakBalance ?? 0), state.balance);

  const marketCache = new Map();
  const getMarket = async (approval) => {
    const key = `${approval.symbol}:${approval.timeframe}`;
    if (!marketCache.has(key)) marketCache.set(key, await marketLoader(approval));
    return marketCache.get(key);
  };

  // Close existing paper positions before considering new entries.
  const stillOpen = [];
  for (const position of state.openPositions) {
    const approval = approvals.find((item) => item.approvalId === position.approvalId);
    if (!approval) {
      stillOpen.push(position);
      continue;
    }
    const { candles } = await getMarket(approval);
    const lastCandle = candles.at(-1);
    const exit = evaluatePositionExit(position, lastCandle);
    if (!exit) {
      stillOpen.push(position);
      continue;
    }

    const closed = closeLongPosition(
      position,
      exit.closePrice,
      exit.closeReason,
      state.balance
    );
    state.balance = closed.nextBalance;
    trades.push(closed.trade);
  }
  state.openPositions = stillOpen;
  state.peakBalance = Math.max(state.peakBalance, state.balance);

  let riskState = calculatePaperRiskState(state, approvals);
  if (riskState.pausedReason) state.pausedReason = riskState.pausedReason;

  for (const approval of approvals) {
    if (state.pausedReason) break;
    if (state.openPositions.length >= riskState.maxTotalOpenPositions) break;

    const maxPerCandidate = Number(
      approval.riskPolicy?.maxOpenPositionsPerCandidate ?? 1
    );
    if (countOpenForApproval(state, approval.approvalId) >= maxPerCandidate) continue;

    const { candles, htfCandles } = await getMarket(approval);
    const lastCandle = candles.at(-1);
    const approvedAtMs = new Date(approval.approvedAt).getTime();
    if (Number.isFinite(approvedAtMs) && lastCandle.time <= approvedAtMs) continue;

    const previousProcessed = Number(
      state.lastProcessedCandleByApproval[approval.approvalId] ?? 0
    );
    if (lastCandle.time <= previousProcessed) continue;

    state.lastProcessedCandleByApproval[approval.approvalId] = lastCandle.time;

    const signal = getSignal({
      candles,
      htfCandles,
      config: buildSignalConfig(approval),
    });
    const position = planPaperEntry({ approval, signal, state, candle: lastCandle });
    if (position) state.openPositions.push(position);
  }

  riskState = calculatePaperRiskState(state, approvals);
  if (riskState.pausedReason) state.pausedReason = riskState.pausedReason;
  state.balance = round(state.balance, 4);
  state.peakBalance = round(Math.max(state.peakBalance, state.balance), 4);
  state.updatedAt = new Date().toISOString();

  writeJson(stateFile, state);
  writeJson(tradesFile, trades);

  return {
    approvals: approvals.length,
    state,
    trades,
    riskState,
  };
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  runAutonomousPaperOnce()
    .then((result) => {
      console.log("=== Autonomous Paper Engine v1 ===");
      console.log("Mode: PAPER ONLY — no exchange order endpoints exist in this engine");
      console.log(`Approved strategies: ${result.approvals}`);
      console.log(`Balance: ${result.state.balance} USDT`);
      console.log(`Open positions: ${result.state.openPositions.length}`);
      console.log(`Closed trades: ${result.trades.length}`);
      console.log(`Drawdown: ${result.riskState.drawdownPct}%`);
      console.log(`Daily loss: ${result.riskState.dayLossPct}%`);
      console.log(`Paused: ${result.state.pausedReason ?? "no"}`);
    })
    .catch((error) => {
      console.error("Autonomous paper engine failed:", error);
      process.exitCode = 1;
    });
}
