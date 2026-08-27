import { runLongBacktest } from "./backtestEvaluator.js";

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function buildWalkForwardWindows({
  candleCount,
  folds = 4,
  minTrainCandles = 600,
  minTestCandles = 150,
}) {
  if (!Number.isInteger(candleCount) || candleCount <= 0) {
    throw new Error("candleCount must be a positive integer");
  }
  if (!Number.isInteger(folds) || folds < 2) {
    throw new Error("folds must be an integer >= 2");
  }
  if (candleCount < minTrainCandles + minTestCandles * folds) {
    throw new Error(
      `not_enough_candles_for_walk_forward:${candleCount}<${minTrainCandles + minTestCandles * folds}`
    );
  }

  const availableForTests = candleCount - minTrainCandles;
  const testSize = Math.floor(availableForTests / folds);
  if (testSize < minTestCandles) {
    throw new Error(`walk_forward_test_window_too_small:${testSize}`);
  }

  const windows = [];
  for (let index = 0; index < folds; index += 1) {
    const trainEnd = minTrainCandles + testSize * index;
    const testStart = trainEnd;
    const testEnd = index === folds - 1
      ? candleCount
      : Math.min(candleCount, testStart + testSize);

    windows.push({
      fold: index + 1,
      trainStart: 0,
      trainEnd,
      testStart,
      testEnd,
      trainCandles: trainEnd,
      testCandles: testEnd - testStart,
    });
  }

  return windows;
}

export function aggregateWalkForward(foldResults) {
  if (!Array.isArray(foldResults) || foldResults.length === 0) {
    throw new Error("foldResults required");
  }

  const testMetrics = foldResults.map((item) => item.testMetrics);
  const returns = testMetrics.map((metrics) => Number(metrics.returnPct) || 0);
  const profitFactors = testMetrics.map((metrics) => Number(metrics.profitFactor) || 0);
  const drawdowns = testMetrics.map((metrics) => Number(metrics.maxDrawdownPct) || 0);
  const trades = testMetrics.map((metrics) => Number(metrics.totalTrades) || 0);
  const profitableFolds = returns.filter((value) => value > 0).length;
  const losingFolds = returns.filter((value) => value < 0).length;
  const totalTrades = trades.reduce((sum, value) => sum + value, 0);
  const totalReturnPct = returns.reduce((sum, value) => sum + value, 0);

  return {
    folds: foldResults.length,
    profitableFolds,
    losingFolds,
    profitableFoldRatio: round(profitableFolds / foldResults.length, 3),
    totalTrades,
    totalReturnPct: round(totalReturnPct, 3),
    averageReturnPct: round(totalReturnPct / foldResults.length, 3),
    medianReturnPct: round(median(returns), 3),
    worstFoldReturnPct: round(Math.min(...returns), 3),
    bestFoldReturnPct: round(Math.max(...returns), 3),
    medianProfitFactor: round(median(profitFactors), 3),
    worstProfitFactor: round(Math.min(...profitFactors), 3),
    maxDrawdownPct: round(Math.max(...drawdowns), 3),
    minTradesPerFold: Math.min(...trades),
  };
}

export function scoreWalkForward(aggregate) {
  const reasons = [];

  if (aggregate.folds < 3) reasons.push("too_few_folds");
  if (aggregate.totalTrades < 20) reasons.push("walk_forward_sample_too_small");
  if (aggregate.profitableFoldRatio < 0.6) reasons.push("too_few_profitable_folds");
  if (aggregate.medianReturnPct <= 0) reasons.push("median_fold_not_profitable");
  if (aggregate.totalReturnPct <= 0) reasons.push("walk_forward_total_not_profitable");
  if (aggregate.medianProfitFactor < 1.1) reasons.push("median_profit_factor_weak");
  if (aggregate.maxDrawdownPct > 12) reasons.push("walk_forward_drawdown_too_high");
  if (aggregate.worstFoldReturnPct < -5) reasons.push("catastrophic_fold_loss");

  const score =
    aggregate.totalReturnPct * 3 +
    aggregate.medianReturnPct * 5 +
    Math.min(aggregate.medianProfitFactor, 3) * 15 +
    aggregate.profitableFoldRatio * 30 +
    Math.min(aggregate.totalTrades, 80) * 0.25 -
    aggregate.maxDrawdownPct * 2 -
    Math.abs(Math.min(aggregate.worstFoldReturnPct, 0)) * 2;

  let status = "rejected";
  if (
    reasons.length === 0 &&
    aggregate.profitableFoldRatio >= 0.75 &&
    aggregate.totalTrades >= 30 &&
    aggregate.medianProfitFactor >= 1.2 &&
    aggregate.totalReturnPct > 1
  ) {
    status = "validated";
  } else if (
    aggregate.totalReturnPct > 0 &&
    aggregate.medianReturnPct >= 0 &&
    aggregate.profitableFoldRatio >= 0.5 &&
    aggregate.maxDrawdownPct <= 15 &&
    aggregate.totalTrades >= 15
  ) {
    status = "watch";
  }

  return {
    status,
    score: round(score, 2),
    reasons,
  };
}

export function runWalkForwardCandidate({
  candles,
  htfCandles,
  testConfig,
  initialBalance = 1000,
  folds = 4,
  minTrainCandles = 600,
  minTestCandles = 150,
}) {
  const windows = buildWalkForwardWindows({
    candleCount: candles.length,
    folds,
    minTrainCandles,
    minTestCandles,
  });

  const foldResults = windows.map((window) => {
    const trainCandles = candles.slice(0, window.trainEnd);
    const testHistory = candles.slice(0, window.testEnd);

    const train = runLongBacktest({
      candles: trainCandles,
      htfCandles,
      testConfig,
      initialBalance,
    });

    const test = runLongBacktest({
      candles: testHistory,
      htfCandles,
      testConfig,
      initialBalance,
      allowEntriesFromIndex: window.testStart,
    });

    return {
      ...window,
      period: {
        trainFrom: new Date(candles[0].time).toISOString(),
        trainTo: new Date(candles[window.trainEnd - 1].time).toISOString(),
        testFrom: new Date(candles[window.testStart].time).toISOString(),
        testTo: new Date(candles[window.testEnd - 1].time).toISOString(),
      },
      trainMetrics: train.metrics,
      testMetrics: test.metrics,
    };
  });

  const aggregate = aggregateWalkForward(foldResults);
  const verdict = scoreWalkForward(aggregate);

  return {
    foldResults,
    aggregate,
    verdict,
  };
}
