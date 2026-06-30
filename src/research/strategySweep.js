import fs from "fs";
import path from "path";
import { config } from "../config.js";
import { fetchHistoricalCandles } from "../okxClient.js";
import { calculateLongTrade } from "../riskManager.js";

const SYMBOL_SETS = [
  ["BTC-USDT", "ETH-USDT", "SOL-USDT"],
  ["BTC-USDT", "ETH-USDT"],
  ["ETH-USDT"],
  ["BTC-USDT"],
];

const RSI_RANGES = [
  { min: 42, max: 55 },
  { min: 45, max: 55 },
  { min: 45, max: 58 },
  { min: 48, max: 58 },
  { min: 50, max: 60 },
];

const VOLUME_RULES = [
  { min: 0.8, max: 1.2 },
  { min: 0.8, max: 1.5 },
  { min: 1.0, max: 1.5 },
  { min: 1.0, max: null },
  { min: 1.2, max: null },
];

const ATR_RULES = [
  { stop: 1.0, take: 1.5 },
  { stop: 1.0, take: 2.0 },
  { stop: 1.2, take: 1.8 },
  { stop: 1.5, take: 2.5 },
];

const EMA_RULES = [
  { fast: 9, slow: 21 },
  { fast: 20, slow: 50 },
  { fast: 30, slow: 100 },
];

const PNL_SIGN_MISMATCH_PENALTY = 10;

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function calculateEmaSeries(values, period) {
  const series = Array(values.length).fill(null);
  if (values.length < period) return series;

  let emaValue = values
    .slice(0, period)
    .reduce((sum, value) => sum + value, 0) / period;
  series[period - 1] = round(emaValue);

  const multiplier = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    emaValue = values[i] * multiplier + emaValue * (1 - multiplier);
    series[i] = round(emaValue);
  }

  return series;
}

function rsiValue(avgGain, avgLoss) {
  if (avgLoss === 0) return 100;
  const relativeStrength = avgGain / avgLoss;
  return round(100 - 100 / (1 + relativeStrength));
}

function calculateRsiSeries(values, period) {
  const series = Array(values.length).fill(null);
  if (values.length < period + 1) return series;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const difference = values[i] - values[i - 1];
    if (difference >= 0) gains += difference;
    else losses += Math.abs(difference);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  series[period] = rsiValue(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const difference = values[i] - values[i - 1];
    const gain = difference >= 0 ? difference : 0;
    const loss = difference < 0 ? Math.abs(difference) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    series[i] = rsiValue(avgGain, avgLoss);
  }

  return series;
}

function calculateAtrSeries(candles, period) {
  const series = Array(candles.length).fill(null);
  if (candles.length < period + 1) return series;

  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const candle = candles[i];
    const previousClose = candles[i - 1].close;
    trueRanges.push(Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose)
    ));
  }

  let atrValue = trueRanges
    .slice(0, period)
    .reduce((sum, value) => sum + value, 0) / period;
  series[period] = round(atrValue);

  for (let rangeIndex = period; rangeIndex < trueRanges.length; rangeIndex++) {
    atrValue = (
      atrValue * (period - 1) +
      trueRanges[rangeIndex]
    ) / period;
    series[rangeIndex + 1] = round(atrValue);
  }

  return series;
}

function calculateVolumeSmaSeries(candles, period) {
  const series = Array(candles.length).fill(null);
  let rollingVolume = 0;

  for (let i = 0; i < candles.length; i++) {
    rollingVolume += candles[i].volume;
    if (i >= period) rollingVolume -= candles[i - period].volume;
    if (i >= period - 1) series[i] = round(rollingVolume / period);
  }

  return series;
}

function buildHtfTrendSeries(candles, htfCandles, sweepConfig) {
  const htfCloses = htfCandles.map((candle) => candle.close);
  const fastSeries = calculateEmaSeries(htfCloses, sweepConfig.htfEmaFast);
  const slowSeries = calculateEmaSeries(htfCloses, sweepConfig.htfEmaSlow);
  const minimumCandles = sweepConfig.htfEmaSlow + 5;
  const trendSeries = Array(candles.length).fill(false);
  let htfIndex = -1;

  for (let i = 0; i < candles.length; i++) {
    while (
      htfIndex + 1 < htfCandles.length &&
      htfCandles[htfIndex + 1].time <= candles[i].time
    ) {
      htfIndex++;
    }

    if (htfIndex + 1 < minimumCandles) continue;

    const htfFast = fastSeries[htfIndex];
    const htfSlow = slowSeries[htfIndex];
    const htfLastClose = htfCandles[htfIndex].close;
    trendSeries[i] =
      htfFast !== null &&
      htfSlow !== null &&
      htfFast > htfSlow &&
      htfLastClose > htfFast;
  }

  return trendSeries;
}

function prepareSegment(candles, htfCandles, sweepConfig) {
  const closes = candles.map((candle) => candle.close);
  const emaPeriods = [...new Set(
    EMA_RULES.flatMap((rule) => [rule.fast, rule.slow])
  )];
  const emaSeries = Object.fromEntries(
    emaPeriods.map((period) => [
      period,
      calculateEmaSeries(closes, period),
    ])
  );

  return {
    candles,
    emaSeries,
    rsiSeries: calculateRsiSeries(closes, sweepConfig.rsiPeriod),
    atrSeries: calculateAtrSeries(candles, sweepConfig.atrPeriod),
    volumeSmaSeries: calculateVolumeSmaSeries(
      candles,
      sweepConfig.volumePeriod
    ),
    htfTrendSeries: buildHtfTrendSeries(candles, htfCandles, sweepConfig),
  };
}

function hasEntrySignal(segment, index, sweepConfig) {
  if (index < 60) return false;

  const candle = segment.candles[index];
  const emaFast = segment.emaSeries[sweepConfig.emaFast][index];
  const emaSlow = segment.emaSeries[sweepConfig.emaSlow][index];
  const rsi14 = segment.rsiSeries[index];
  const atr14 = segment.atrSeries[index];
  const volumeSma20 = segment.volumeSmaSeries[index];

  if (
    emaFast === null ||
    emaSlow === null ||
    rsi14 === null ||
    atr14 === null ||
    volumeSma20 === null
  ) {
    return false;
  }

  if (
    sweepConfig.useHtfFilter === true &&
    segment.htfTrendSeries[index] !== true
  ) {
    return false;
  }

  if (
    sweepConfig.maxVolumeFactor != null &&
    candle.volume > volumeSma20 * sweepConfig.maxVolumeFactor
  ) {
    return false;
  }

  const commonConditions =
    emaFast > emaSlow &&
    candle.close > emaFast &&
    rsi14 >= sweepConfig.minRsiForLong &&
    rsi14 <= sweepConfig.maxRsiForLong &&
    candle.volume >= volumeSma20 * sweepConfig.minVolumeFactor &&
    atr14 > 0;

  if (!commonConditions) return false;
  if (sweepConfig.activeStrategy === "trendMomentum") return true;

  const lookbackStart = Math.max(
    0,
    index - (sweepConfig.pullbackLookback || 8) + 1
  );
  const pullbackTolerancePct = sweepConfig.pullbackTolerancePct ?? 0.002;
  let pullbackDetected = false;
  for (let i = lookbackStart; i <= index; i++) {
    if (
      segment.candles[i].low <=
      emaFast * (1 + pullbackTolerancePct)
    ) {
      pullbackDetected = true;
      break;
    }
  }

  const bullishConfirmation =
    candle.close > candle.open &&
    candle.close > segment.candles[index - 1].close;

  return pullbackDetected && bullishConfirmation;
}

function calcMaxDrawdown(equityCurve, initialBalance) {
  let peak = equityCurve[0] ?? initialBalance;
  let maxDrawdown = 0;

  for (const value of equityCurve) {
    if (value > peak) peak = value;
    maxDrawdown = Math.max(maxDrawdown, peak - value);
  }

  return round(maxDrawdown);
}

function closePosition(position, exitPrice, balance, feeRate) {
  const grossPnl = round(
    (exitPrice - position.entryPrice) * position.size
  );
  const fees = round(
    (position.entryPrice + exitPrice) * position.size * feeRate
  );
  const netPnl = round(grossPnl - fees);

  return {
    balance: round(balance + netPnl),
    netPnl,
  };
}

function backtestSegment(segment, sweepConfig) {
  let balance = sweepConfig.initialBalance;
  let openPosition = null;
  const equity = [balance];
  const tradePnls = [];

  for (let i = 60; i < segment.candles.length; i++) {
    const candle = segment.candles[i];

    if (openPosition) {
      const hitStop = candle.low <= openPosition.stopPrice;
      const hitTake = candle.high >= openPosition.takePrice;

      if (hitStop || hitTake) {
        const exitPrice = hitStop
          ? openPosition.stopPrice
          : openPosition.takePrice;
        const closed = closePosition(
          openPosition,
          exitPrice,
          balance,
          sweepConfig.feeRate
        );
        balance = closed.balance;
        tradePnls.push(closed.netPnl);
        equity.push(balance);
        openPosition = null;
      }
      continue;
    }

    if (!hasEntrySignal(segment, i, sweepConfig)) continue;

    const plannedTrade = calculateLongTrade({
      balance,
      entryPrice: candle.close,
      atr: segment.atrSeries[i],
      config: sweepConfig,
    });

    if (plannedTrade.size > 0 && plannedTrade.positionValue > 0) {
      openPosition = {
        entryPrice: plannedTrade.entryPrice,
        stopPrice: plannedTrade.stopPrice,
        takePrice: plannedTrade.takePrice,
        size: plannedTrade.size,
      };
    }
  }

  if (openPosition && segment.candles.length > 0) {
    const exitPrice = segment.candles[segment.candles.length - 1].close;
    const closed = closePosition(
      openPosition,
      exitPrice,
      balance,
      sweepConfig.feeRate
    );
    balance = closed.balance;
    tradePnls.push(closed.netPnl);
    equity.push(balance);
  }

  const wins = tradePnls.filter((pnl) => pnl > 0);
  const losses = tradePnls.filter((pnl) => pnl < 0);
  return {
    trades: tradePnls.length,
    wins: wins.length,
    losses: losses.length,
    netPnl: round(tradePnls.reduce((sum, pnl) => sum + pnl, 0)),
    totalWinPnl: round(wins.reduce((sum, pnl) => sum + pnl, 0)),
    totalLossPnl: round(Math.abs(
      losses.reduce((sum, pnl) => sum + pnl, 0)
    )),
    maxDrawdown: calcMaxDrawdown(equity, sweepConfig.initialBalance),
  };
}

function aggregateMetrics(metrics) {
  const aggregate = metrics.reduce((result, metric) => ({
    trades: result.trades + metric.trades,
    wins: result.wins + metric.wins,
    losses: result.losses + metric.losses,
    netPnl: result.netPnl + metric.netPnl,
    totalWinPnl: result.totalWinPnl + metric.totalWinPnl,
    totalLossPnl: result.totalLossPnl + metric.totalLossPnl,
    maxDrawdown: Math.max(result.maxDrawdown, metric.maxDrawdown),
  }), {
    trades: 0,
    wins: 0,
    losses: 0,
    netPnl: 0,
    totalWinPnl: 0,
    totalLossPnl: 0,
    maxDrawdown: 0,
  });

  return {
    ...aggregate,
    netPnl: round(aggregate.netPnl),
    winRate: aggregate.trades > 0
      ? round((aggregate.wins / aggregate.trades) * 100)
      : 0,
    profitFactor: aggregate.totalLossPnl > 0
      ? round(aggregate.totalWinPnl / aggregate.totalLossPnl)
      : null,
  };
}

function qualificationProfitFactor(metrics) {
  if (metrics.profitFactor !== null) return metrics.profitFactor;
  return metrics.wins > 0 && metrics.losses === 0
    ? Number.POSITIVE_INFINITY
    : 0;
}

function calculateScore(train, test) {
  const signsDiffer =
    (train.netPnl > 0 && test.netPnl < 0) ||
    (train.netPnl < 0 && test.netPnl > 0);
  const penalty = signsDiffer ? PNL_SIGN_MISMATCH_PENALTY : 0;

  return round(
    test.netPnl * 2 +
    (test.profitFactor ?? 0) * 10 -
    test.maxDrawdown +
    (train.profitFactor ?? 0) * 5 -
    penalty
  );
}

function isCandidate(train, test) {
  return (
    train.trades >= 10 &&
    qualificationProfitFactor(train) > 1 &&
    train.netPnl > 0 &&
    test.trades >= 3 &&
    qualificationProfitFactor(test) >= 0.9 &&
    test.netPnl >= -2
  );
}

function csvCell(value) {
  const text = value === null || value === undefined ? "N/A" : String(value);
  return `"${text.replaceAll("\"", "\"\"")}"`;
}

function writeSweepReports({
  results,
  candidates,
  topResults,
  warnings,
  reportsDir = "reports",
}) {
  const outputDir = path.resolve(reportsDir);
  fs.mkdirSync(outputDir, { recursive: true });

  const jsonPath = path.join(outputDir, "strategy-sweep-results.json");
  const csvPath = path.join(outputDir, "strategy-sweep-summary.csv");
  const generatedAt = new Date().toISOString();

  fs.writeFileSync(jsonPath, JSON.stringify({
    generatedAt,
    trainRatio: 0.7,
    testRatio: 0.3,
    totalCombinationsTested: results.length,
    candidatesFound: candidates.length,
    bestRobustCandidate: candidates[0] ?? null,
    top10ByScore: topResults,
    warnings,
    results,
  }, null, 2));

  const columns = [
    "strategy",
    "symbols",
    "emaFast",
    "emaSlow",
    "minRsi",
    "maxRsi",
    "minVolumeFactor",
    "maxVolumeFactor",
    "atrStop",
    "atrTake",
    "trainTrades",
    "trainNetPnl",
    "trainPF",
    "trainWinRate",
    "trainMaxDD",
    "testTrades",
    "testNetPnl",
    "testPF",
    "testWinRate",
    "testMaxDD",
    "score",
    "candidate",
  ];
  const csvRows = [
    columns.join(","),
    ...results.map((result) =>
      columns.map((column) => csvCell(result[column])).join(",")
    ),
  ];
  fs.writeFileSync(csvPath, `${csvRows.join("\n")}\n`);

  return { jsonPath, csvPath };
}

export async function runStrategySweep({ onProgress = () => {} } = {}) {
  const warnings = [
    "Sweep is exploratory: do not use results for real trading.",
    "Train/test split is chronological but limited to the available candle sample.",
    `PnL sign mismatch penalty: ${PNL_SIGN_MISMATCH_PENALTY} score points.`,
  ];
  const symbolData = {};

  for (const symbol of config.symbols) {
    onProgress(`Loading ${symbol} ${config.bar} and ${config.htfBar} candles...`);
    const candles = await fetchHistoricalCandles({
      symbol,
      bar: config.bar,
      targetLimit: config.backtestCandlesLimit,
    });
    const htfCandles = await fetchHistoricalCandles({
      symbol,
      bar: config.htfBar,
      targetLimit: config.htfCandlesLimit,
    });

    if (candles.length === 0 || htfCandles.length === 0) {
      throw new Error(
        `${symbol}: insufficient candles (${candles.length} 5m, ${htfCandles.length} 1H)`
      );
    }

    const splitIndex = Math.floor(candles.length * 0.7);
    const trainCandles = candles.slice(0, splitIndex);
    const testCandles = candles.slice(splitIndex);
    symbolData[symbol] = {
      train: prepareSegment(trainCandles, htfCandles, config),
      test: prepareSegment(testCandles, htfCandles, config),
    };
    onProgress(
      `${symbol}: train ${trainCandles.length} | test ${testCandles.length} | HTF ${htfCandles.length}`
    );
  }

  const enabledStrategies = Object.entries(config.strategies)
    .filter(([, strategy]) => strategy.enabled === true)
    .map(([strategyName]) => strategyName);
  const results = [];

  for (const strategyName of enabledStrategies) {
    onProgress(`Sweeping ${strategyName}...`);
    for (const rsiRange of RSI_RANGES) {
      for (const volumeRule of VOLUME_RULES) {
        for (const atrRule of ATR_RULES) {
          for (const emaRule of EMA_RULES) {
            const sweepConfig = {
              ...config,
              activeStrategy: strategyName,
              emaFast: emaRule.fast,
              emaSlow: emaRule.slow,
              minRsiForLong: rsiRange.min,
              maxRsiForLong: rsiRange.max,
              minVolumeFactor: volumeRule.min,
              maxVolumeFactor: volumeRule.max,
              atrStopMultiplier: atrRule.stop,
              atrTakeMultiplier: atrRule.take,
              useHtfFilter: true,
            };
            const perSymbol = {};

            for (const symbol of config.symbols) {
              perSymbol[symbol] = {
                train: backtestSegment(
                  symbolData[symbol].train,
                  sweepConfig
                ),
                test: backtestSegment(
                  symbolData[symbol].test,
                  sweepConfig
                ),
              };
            }

            for (const symbols of SYMBOL_SETS) {
              const train = aggregateMetrics(
                symbols.map((symbol) => perSymbol[symbol].train)
              );
              const test = aggregateMetrics(
                symbols.map((symbol) => perSymbol[symbol].test)
              );
              const candidate = isCandidate(train, test);

              results.push({
                strategy: strategyName,
                symbols: symbols.join("+"),
                emaFast: emaRule.fast,
                emaSlow: emaRule.slow,
                minRsi: rsiRange.min,
                maxRsi: rsiRange.max,
                minVolumeFactor: volumeRule.min,
                maxVolumeFactor: volumeRule.max,
                atrStop: atrRule.stop,
                atrTake: atrRule.take,
                trainTrades: train.trades,
                trainNetPnl: train.netPnl,
                trainPF: train.profitFactor,
                trainWinRate: train.winRate,
                trainMaxDD: train.maxDrawdown,
                testTrades: test.trades,
                testNetPnl: test.netPnl,
                testPF: test.profitFactor,
                testWinRate: test.winRate,
                testMaxDD: test.maxDrawdown,
                score: calculateScore(train, test),
                candidate,
              });
            }
          }
        }
      }
    }
  }

  const topResults = [...results]
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  const candidates = results
    .filter((result) => result.candidate)
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {
    warnings.push("No robust candidate found");
  }

  const reports = writeSweepReports({
    results,
    candidates,
    topResults,
    warnings,
  });

  return {
    results,
    candidates,
    topResults,
    bestRobustCandidate: candidates[0] ?? null,
    warnings,
    reports,
  };
}
