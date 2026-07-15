import fs from "node:fs";
import path from "node:path";
import { config as baseConfig } from "../config.js";
import { fetchHistoricalCandles } from "../okxClient.js";
import { closeResearchTrade } from "./tradeAccounting.js";

const STRATEGY_ID = "intraday-scalper-1d";
const STRATEGY_NAME = "ZenBlade Intraday Scalper 1D";
const DEFAULT_SYMBOLS = [
  "BTC-USDT",
  "ETH-USDT",
  "SOL-USDT",
  "NEAR-USDT",
  "TIA-USDT",
  "AR-USDT",
  "ORDI-USDT",
];

const BAR_LIST = (process.env.INTRADAY_SCALPER_BARS ?? process.env.INTRADAY_SCALPER_BAR ?? "5m")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const SYMBOLS = (process.env.INTRADAY_SCALPER_SYMBOLS ?? DEFAULT_SYMBOLS.join(","))
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const TARGET_CANDLES = Number.parseInt(process.env.INTRADAY_SCALPER_CANDLES ?? "6000", 10);
const INITIAL_BALANCE = Number.parseFloat(process.env.INTRADAY_SCALPER_INITIAL_BALANCE ?? `${baseConfig.initialBalance ?? 1000}`);
const FEE_RATE = Number.parseFloat(process.env.INTRADAY_SCALPER_FEE_RATE ?? `${baseConfig.feeRate ?? 0.0008}`);
const SLIPPAGE_PCT = Number.parseFloat(process.env.INTRADAY_SCALPER_SLIPPAGE_PCT ?? "0.0002");

const SCENARIOS = [
  {
    key: "base_ema20_50_pullback",
    label: "Base EMA20/50 pullback scalper",
    emaFast: 20,
    emaSlow: 50,
    volumePeriod: 20,
    atrPeriod: 14,
    pullbackLookback: 4,
    pullbackTolerancePct: 0.0018,
    maxEntryDistanceFromEmaPct: 0.45,
    minVolumeSpike: 1.2,
    minImpulseBodyPct: 0.08,
    minAtrPct: 0.08,
    maxAtrPct: 1.2,
    maxCandleRangePct: 1.4,
    takeProfitPct: 0.005,
    stopLossPct: 0.0035,
    maxHoldMinutes: 60,
    cooldownCandles: 4,
    maxTradesPerDay: 8,
    maxDailyLossUSDT: 18,
    riskPerTrade: 0.005,
    maxPositionValuePct: 0.25,
    allowLong: true,
    allowShort: true,
  },
  {
    key: "fast_more_trades",
    label: "Fast higher-frequency pullback scalper",
    emaFast: 20,
    emaSlow: 50,
    volumePeriod: 20,
    atrPeriod: 14,
    pullbackLookback: 5,
    pullbackTolerancePct: 0.0025,
    maxEntryDistanceFromEmaPct: 0.6,
    minVolumeSpike: 1.05,
    minImpulseBodyPct: 0.06,
    minAtrPct: 0.06,
    maxAtrPct: 1.4,
    maxCandleRangePct: 1.8,
    takeProfitPct: 0.0035,
    stopLossPct: 0.0025,
    maxHoldMinutes: 45,
    cooldownCandles: 3,
    maxTradesPerDay: 12,
    maxDailyLossUSDT: 20,
    riskPerTrade: 0.004,
    maxPositionValuePct: 0.22,
    allowLong: true,
    allowShort: true,
  },
  {
    key: "strict_quality",
    label: "Strict quality pullback scalper",
    emaFast: 20,
    emaSlow: 50,
    volumePeriod: 20,
    atrPeriod: 14,
    pullbackLookback: 4,
    pullbackTolerancePct: 0.0015,
    maxEntryDistanceFromEmaPct: 0.35,
    minVolumeSpike: 1.35,
    minImpulseBodyPct: 0.1,
    minAtrPct: 0.1,
    maxAtrPct: 1.0,
    maxCandleRangePct: 1.2,
    takeProfitPct: 0.006,
    stopLossPct: 0.0035,
    maxHoldMinutes: 90,
    cooldownCandles: 5,
    maxTradesPerDay: 6,
    maxDailyLossUSDT: 16,
    riskPerTrade: 0.005,
    maxPositionValuePct: 0.25,
    allowLong: true,
    allowShort: true,
  },
];

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function dateKey(time) {
  return new Date(time).toISOString().slice(0, 10);
}

function hourKey(time) {
  return new Date(time).getUTCHours();
}

function minutesForBar(bar) {
  const match = String(bar).match(/^(\d+)([mHD])$/);
  if (!match) return 5;
  const value = Number.parseInt(match[1], 10);
  const unit = match[2];
  if (unit === "m") return value;
  if (unit === "H") return value * 60;
  return value * 24 * 60;
}

function calculateEmaSeries(values, period) {
  const series = Array(values.length).fill(null);
  if (values.length < period) return series;

  let emaValue = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  series[period - 1] = emaValue;

  const multiplier = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    emaValue = values[i] * multiplier + emaValue * (1 - multiplier);
    series[i] = emaValue;
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

  let atrValue = trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  series[period] = atrValue;

  for (let rangeIndex = period; rangeIndex < trueRanges.length; rangeIndex++) {
    atrValue = (atrValue * (period - 1) + trueRanges[rangeIndex]) / period;
    series[rangeIndex + 1] = atrValue;
  }

  return series;
}

function calculateVolumeSmaSeries(candles, period) {
  const series = Array(candles.length).fill(null);
  let rollingVolume = 0;

  for (let i = 0; i < candles.length; i++) {
    rollingVolume += candles[i].volume;
    if (i >= period) rollingVolume -= candles[i - period].volume;
    if (i >= period - 1) series[i] = rollingVolume / period;
  }

  return series;
}

function calculateVwapSeries(candles) {
  const series = Array(candles.length).fill(null);
  let currentDay = null;
  let cumulativePv = 0;
  let cumulativeVolume = 0;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const day = dateKey(candle.time);
    if (day !== currentDay) {
      currentDay = day;
      cumulativePv = 0;
      cumulativeVolume = 0;
    }

    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    cumulativePv += typicalPrice * candle.volume;
    cumulativeVolume += candle.volume;
    series[i] = cumulativeVolume > 0 ? cumulativePv / cumulativeVolume : null;
  }

  return series;
}

function prepareSeries(candles, scenario) {
  const closes = candles.map((candle) => candle.close);
  return {
    emaFast: calculateEmaSeries(closes, scenario.emaFast),
    emaSlow: calculateEmaSeries(closes, scenario.emaSlow),
    atr: calculateAtrSeries(candles, scenario.atrPeriod),
    volumeSma: calculateVolumeSmaSeries(candles, scenario.volumePeriod),
    vwap: calculateVwapSeries(candles),
  };
}

function hasRecentLongPullback({ candles, series, index, scenario }) {
  const start = Math.max(0, index - scenario.pullbackLookback + 1);
  for (let i = start; i <= index; i++) {
    const emaFast = series.emaFast[i];
    const vwap = series.vwap[i];
    if (!Number.isFinite(emaFast) || !Number.isFinite(vwap)) continue;
    if (candles[i].low <= emaFast * (1 + scenario.pullbackTolerancePct)) return true;
    if (candles[i].low <= vwap * (1 + scenario.pullbackTolerancePct)) return true;
  }
  return false;
}

function hasRecentShortPullback({ candles, series, index, scenario }) {
  const start = Math.max(0, index - scenario.pullbackLookback + 1);
  for (let i = start; i <= index; i++) {
    const emaFast = series.emaFast[i];
    const vwap = series.vwap[i];
    if (!Number.isFinite(emaFast) || !Number.isFinite(vwap)) continue;
    if (candles[i].high >= emaFast * (1 - scenario.pullbackTolerancePct)) return true;
    if (candles[i].high >= vwap * (1 - scenario.pullbackTolerancePct)) return true;
  }
  return false;
}

function getEntrySignal({ candles, series, index, scenario }) {
  const candle = candles[index];
  const previous = candles[index - 1];
  const emaFast = series.emaFast[index];
  const emaSlow = series.emaSlow[index];
  const atr = series.atr[index];
  const volumeSma = series.volumeSma[index];

  if (
    !candle ||
    !previous ||
    !Number.isFinite(emaFast) ||
    !Number.isFinite(emaSlow) ||
    !Number.isFinite(atr) ||
    !Number.isFinite(volumeSma) ||
    volumeSma <= 0 ||
    candle.close <= 0
  ) {
    return null;
  }

  const atrPct = (atr / candle.close) * 100;
  const candleRangePct = ((candle.high - candle.low) / candle.close) * 100;
  if (atrPct < scenario.minAtrPct || atrPct > scenario.maxAtrPct) return null;
  if (candleRangePct > scenario.maxCandleRangePct) return null;

  const volumeRatio = candle.volume / volumeSma;
  const bodyPct = Math.abs(candle.close - candle.open) / candle.open * 100;
  const longConfirmation = candle.close > candle.open && candle.close > previous.close;
  const shortConfirmation = candle.close < candle.open && candle.close < previous.close;
  const hasConfirmation = volumeRatio >= scenario.minVolumeSpike || bodyPct >= scenario.minImpulseBodyPct;
  if (!hasConfirmation) return null;

  const distanceFromEmaPct = Math.abs((candle.close - emaFast) / emaFast) * 100;
  if (distanceFromEmaPct > scenario.maxEntryDistanceFromEmaPct) return null;

  const longTrend = scenario.allowLong && emaFast > emaSlow && candle.close > emaFast;
  const shortTrend = scenario.allowShort && emaFast < emaSlow && candle.close < emaFast;

  if (
    longTrend &&
    longConfirmation &&
    hasRecentLongPullback({ candles, series, index, scenario })
  ) {
    return {
      side: "LONG",
      atrPct: round(atrPct, 4),
      volumeRatio: round(volumeRatio, 4),
      bodyPct: round(bodyPct, 4),
      emaFast: round(emaFast, 8),
      emaSlow: round(emaSlow, 8),
    };
  }

  if (
    shortTrend &&
    shortConfirmation &&
    hasRecentShortPullback({ candles, series, index, scenario })
  ) {
    return {
      side: "SHORT",
      atrPct: round(atrPct, 4),
      volumeRatio: round(volumeRatio, 4),
      bodyPct: round(bodyPct, 4),
      emaFast: round(emaFast, 8),
      emaSlow: round(emaSlow, 8),
    };
  }

  return null;
}

function applyEntrySlippage(price, side, slippagePct) {
  return side === "SHORT"
    ? price * (1 - slippagePct)
    : price * (1 + slippagePct);
}

function applyExitSlippage(price, side, slippagePct) {
  return side === "SHORT"
    ? price * (1 + slippagePct)
    : price * (1 - slippagePct);
}

function buildPosition({ symbol, bar, scenario, candle, signal, balance, index }) {
  const entryPrice = applyEntrySlippage(candle.close, signal.side, SLIPPAGE_PCT);
  const stopPrice = signal.side === "SHORT"
    ? entryPrice * (1 + scenario.stopLossPct)
    : entryPrice * (1 - scenario.stopLossPct);
  const takePrice = signal.side === "SHORT"
    ? entryPrice * (1 - scenario.takeProfitPct)
    : entryPrice * (1 + scenario.takeProfitPct);

  const riskPerUnit = Math.abs(entryPrice - stopPrice);
  if (riskPerUnit <= 0) return null;

  const riskAmount = balance * scenario.riskPerTrade;
  const maxPositionValue = balance * scenario.maxPositionValuePct;
  const riskSize = riskAmount / riskPerUnit;
  const maxSize = maxPositionValue / entryPrice;
  const size = Math.min(riskSize, maxSize);

  if (!Number.isFinite(size) || size <= 0) return null;

  return {
    strategyId: STRATEGY_ID,
    scenario: scenario.key,
    symbol,
    bar,
    side: signal.side,
    entryIndex: index,
    entryTime: candle.time,
    entryDate: dateKey(candle.time),
    entryHour: hourKey(candle.time),
    entryPrice: round(entryPrice, 8),
    stopPrice: round(stopPrice, 8),
    takePrice: round(takePrice, 8),
    size: round(size, 8),
    positionValue: round(size * entryPrice, 2),
    riskAmount: round(riskAmount, 4),
    signal,
  };
}

function indexDistance(candle, position) {
  if (!Number.isInteger(candle.index) || !Number.isInteger(position.entryIndex)) return 0;
  return candle.index - position.entryIndex;
}

function getExit({ candle, position, scenario, barMinutes, isLast = false }) {
  if (position.side === "LONG") {
    const hitStop = candle.low <= position.stopPrice;
    const hitTake = candle.high >= position.takePrice;
    if (hitStop || hitTake) {
      const price = hitStop ? position.stopPrice : position.takePrice;
      return {
        reason: hitStop ? "STOP_LOSS" : "TAKE_PROFIT",
        price: applyExitSlippage(price, position.side, SLIPPAGE_PCT),
      };
    }
  } else {
    const hitStop = candle.high >= position.stopPrice;
    const hitTake = candle.low <= position.takePrice;
    if (hitStop || hitTake) {
      const price = hitStop ? position.stopPrice : position.takePrice;
      return {
        reason: hitStop ? "STOP_LOSS" : "TAKE_PROFIT",
        price: applyExitSlippage(price, position.side, SLIPPAGE_PCT),
      };
    }
  }

  const holdMinutes = (candle.time - position.entryTime) / 60000;
  if (holdMinutes >= scenario.maxHoldMinutes) {
    return {
      reason: "MAX_HOLD",
      price: applyExitSlippage(candle.close, position.side, SLIPPAGE_PCT),
    };
  }

  if (isLast) {
    return {
      reason: "END_OF_TEST",
      price: applyExitSlippage(candle.close, position.side, SLIPPAGE_PCT),
    };
  }

  const maxHoldCandles = Math.ceil(scenario.maxHoldMinutes / barMinutes);
  if (indexDistance(candle, position) >= maxHoldCandles) {
    return {
      reason: "MAX_HOLD_CANDLES",
      price: applyExitSlippage(candle.close, position.side, SLIPPAGE_PCT),
    };
  }

  return null;
}

function updateDailyAfterTrade(dailyState, trade) {
  const key = trade.entryDate;
  if (!dailyState.has(key)) {
    dailyState.set(key, { trades: 0, netPnl: 0 });
  }
  const day = dailyState.get(key);
  day.trades += 1;
  day.netPnl = round(day.netPnl + trade.netPnl, 4);
}

function canOpenNewTrade({ dailyState, day, scenario, lastExitIndex, index }) {
  const stats = dailyState.get(day) ?? { trades: 0, netPnl: 0 };
  if (stats.trades >= scenario.maxTradesPerDay) return false;
  if (stats.netPnl <= -scenario.maxDailyLossUSDT) return false;
  if (lastExitIndex !== null && index - lastExitIndex < scenario.cooldownCandles) return false;
  return true;
}

function backtestSymbol({ symbol, bar, candles, scenario }) {
  const indexedCandles = candles.map((candle, index) => ({ ...candle, index }));
  const series = prepareSeries(indexedCandles, scenario);
  const barMinutes = minutesForBar(bar);
  const minIndex = Math.max(scenario.emaSlow, scenario.atrPeriod, scenario.volumePeriod) + scenario.pullbackLookback + 2;

  let balance = INITIAL_BALANCE;
  let openPosition = null;
  let lastExitIndex = null;
  const dailyState = new Map();
  const trades = [];
  const equity = [INITIAL_BALANCE];

  for (let i = minIndex; i < indexedCandles.length; i++) {
    const candle = indexedCandles[i];
    const isLast = i === indexedCandles.length - 1;

    if (openPosition) {
      const exit = getExit({ candle, position: openPosition, scenario, barMinutes, isLast });
      if (exit) {
        openPosition.closeTime = candle.time;
        const closed = closeResearchTrade({
          position: openPosition,
          closePrice: round(exit.price, 8),
          closeReason: exit.reason,
          balance,
          feeRate: FEE_RATE,
        });
        balance = closed.balance;
        const holdMinutes = round((candle.time - openPosition.entryTime) / 60000, 1);
        const trade = {
          ...closed.trade,
          strategyId: STRATEGY_ID,
          scenario: scenario.key,
          symbol,
          bar,
          entryDate: openPosition.entryDate,
          entryHour: openPosition.entryHour,
          holdMinutes,
          grossPnl: round(closed.trade.grossPnl, 4),
          fees: round(closed.trade.fees, 4),
          netPnl: round(closed.trade.netPnl, 4),
          positionValue: openPosition.positionValue,
          riskAmount: openPosition.riskAmount,
          atrPct: openPosition.signal.atrPct,
          volumeRatio: openPosition.signal.volumeRatio,
          bodyPct: openPosition.signal.bodyPct,
        };
        trades.push(trade);
        equity.push(balance);
        updateDailyAfterTrade(dailyState, trade);
        openPosition = null;
        lastExitIndex = i;
      }
      continue;
    }

    const day = dateKey(candle.time);
    if (!canOpenNewTrade({ dailyState, day, scenario, lastExitIndex, index: i })) continue;

    const signal = getEntrySignal({ candles: indexedCandles, series, index: i, scenario });
    if (!signal) continue;

    const position = buildPosition({ symbol, bar, scenario, candle, signal, balance, index: i });
    if (position) openPosition = position;
  }

  return {
    symbol,
    bar,
    scenario: scenario.key,
    trades,
    equity,
    dayCount: new Set(indexedCandles.map((candle) => dateKey(candle.time))).size,
  };
}

function calcMaxDrawdown(equityCurve) {
  let peak = equityCurve[0] ?? INITIAL_BALANCE;
  let maxDrawdown = 0;
  for (const value of equityCurve) {
    if (value > peak) peak = value;
    maxDrawdown = Math.max(maxDrawdown, peak - value);
  }
  return round(maxDrawdown, 4);
}

function summarizeTrades(trades, dayCount) {
  const wins = trades.filter((trade) => trade.netPnl > 0);
  const losses = trades.filter((trade) => trade.netPnl < 0);
  const grossPnl = trades.reduce((sum, trade) => sum + trade.grossPnl, 0);
  const fees = trades.reduce((sum, trade) => sum + trade.fees, 0);
  const netPnl = trades.reduce((sum, trade) => sum + trade.netPnl, 0);
  const winPnl = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
  const lossPnl = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnl, 0));

  return {
    totalTrades: trades.length,
    tradesPerDay: dayCount > 0 ? round(trades.length / dayCount, 2) : 0,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? round((wins.length / trades.length) * 100, 1) : 0,
    grossPnl: round(grossPnl, 4),
    fees: round(fees, 4),
    netPnl: round(netPnl, 4),
    profitFactor: lossPnl > 0 ? round(winPnl / lossPnl, 2) : wins.length > 0 ? null : 0,
    avgHoldMinutes: trades.length > 0
      ? round(trades.reduce((sum, trade) => sum + trade.holdMinutes, 0) / trades.length, 1)
      : 0,
  };
}

function groupTrades(trades, getKey) {
  const groups = new Map();
  for (const trade of trades) {
    const key = getKey(trade);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trade);
  }
  return [...groups.entries()].map(([key, groupTradesForKey]) => ({
    key,
    ...summarizeTrades(groupTradesForKey, new Set(groupTradesForKey.map((trade) => trade.entryDate)).size),
  }));
}

function summarizeScenario({ bar, scenario, symbolResults }) {
  const allTrades = symbolResults.flatMap((result) => result.trades);
  const allDays = new Set(symbolResults.flatMap((result) => result.trades.map((trade) => trade.entryDate)));
  const equity = [INITIAL_BALANCE];
  let cumulative = INITIAL_BALANCE;
  for (const trade of [...allTrades].sort((a, b) => a.closeTime - b.closeTime)) {
    cumulative = round(cumulative + trade.netPnl, 4);
    equity.push(cumulative);
  }

  const summary = summarizeTrades(allTrades, allDays.size);
  const bySymbol = groupTrades(allTrades, (trade) => trade.symbol)
    .sort((a, b) => b.netPnl - a.netPnl);
  const byHour = groupTrades(allTrades, (trade) => String(trade.entryHour).padStart(2, "0"))
    .sort((a, b) => b.netPnl - a.netPnl);

  return {
    strategyId: STRATEGY_ID,
    strategyName: STRATEGY_NAME,
    bar,
    scenario: scenario.key,
    label: scenario.label,
    parameters: scenario,
    summary: {
      ...summary,
      maxDrawdown: calcMaxDrawdown(equity),
      candidate: (
        summary.totalTrades >= 50 &&
        summary.netPnl > 0 &&
        (summary.profitFactor === null || summary.profitFactor >= 1.1) &&
        bySymbol.filter((item) => item.netPnl > 0).length >= 2
      ),
    },
    bestSymbols: bySymbol.slice(0, 5),
    worstSymbols: [...bySymbol].sort((a, b) => a.netPnl - b.netPnl).slice(0, 5),
    bestHours: byHour.slice(0, 8),
    worstHours: [...byHour].sort((a, b) => a.netPnl - b.netPnl).slice(0, 8),
    bySymbol,
    byHour,
    trades: allTrades,
  };
}

function csvCell(value) {
  const text = value === null || value === undefined ? "N/A" : String(value);
  return `"${text.replaceAll("\"", "\"\"")}"`;
}

function writeReports(results) {
  fs.mkdirSync("reports", { recursive: true });

  const jsonPath = path.join("reports", "intraday-scalper-research.json");
  const csvPath = path.join("reports", "intraday-scalper-research.csv");

  const generatedAt = new Date().toISOString();
  fs.writeFileSync(jsonPath, JSON.stringify({
    generatedAt,
    mode: "research / paper only",
    safety: {
      realOrders: false,
      okxApiKeysRequired: false,
      liveTrading: false,
    },
    assumptions: {
      feeRate: FEE_RATE,
      slippagePct: SLIPPAGE_PCT,
      targetCandles: TARGET_CANDLES,
      symbols: SYMBOLS,
      bars: BAR_LIST,
    },
    results,
  }, null, 2));

  const columns = [
    "bar",
    "scenario",
    "label",
    "totalTrades",
    "tradesPerDay",
    "winRate",
    "grossPnl",
    "fees",
    "netPnl",
    "profitFactor",
    "maxDrawdown",
    "avgHoldMinutes",
    "candidate",
    "bestSymbol",
    "worstSymbol",
    "bestHour",
    "worstHour",
  ];

  const rows = [
    columns.join(","),
    ...results.map((result) => {
      const bestSymbol = result.bestSymbols[0]?.key ?? "N/A";
      const worstSymbol = result.worstSymbols[0]?.key ?? "N/A";
      const bestHour = result.bestHours[0]?.key ?? "N/A";
      const worstHour = result.worstHours[0]?.key ?? "N/A";
      const row = {
        bar: result.bar,
        scenario: result.scenario,
        label: result.label,
        ...result.summary,
        bestSymbol,
        worstSymbol,
        bestHour,
        worstHour,
      };
      return columns.map((column) => csvCell(row[column])).join(",");
    }),
  ];

  fs.writeFileSync(csvPath, `${rows.join("\n")}\n`);
  return { jsonPath, csvPath };
}

function printScenarioResult(result) {
  const s = result.summary;
  console.log(
    `${result.bar} | ${result.scenario} | trades ${s.totalTrades} | ` +
    `perDay ${s.tradesPerDay} | win ${s.winRate}% | gross ${s.grossPnl} | ` +
    `fees ${s.fees} | net ${s.netPnl} | PF ${s.profitFactor ?? "N/A"} | ` +
    `DD ${s.maxDrawdown} | avgHold ${s.avgHoldMinutes}m | candidate ${s.candidate}`
  );
  console.log(`  best symbols: ${result.bestSymbols.slice(0, 3).map((item) => `${item.key}:${item.netPnl}`).join(" | ") || "N/A"}`);
  console.log(`  worst symbols: ${result.worstSymbols.slice(0, 3).map((item) => `${item.key}:${item.netPnl}`).join(" | ") || "N/A"}`);
  console.log(`  best hours UTC: ${result.bestHours.slice(0, 3).map((item) => `${item.key}:00=${item.netPnl}`).join(" | ") || "N/A"}`);
  console.log(`  worst hours UTC: ${result.worstHours.slice(0, 3).map((item) => `${item.key}:00=${item.netPnl}`).join(" | ") || "N/A"}`);
}

export async function runIntradayScalperResearch() {
  console.log(`=== ${STRATEGY_NAME} Research ===`);
  console.log("Mode: research / paper only");
  console.log("Safety: no real orders, no OKX API keys, no live trading");
  console.log(`Symbols: ${SYMBOLS.join(", ")}`);
  console.log(`Bars: ${BAR_LIST.join(", ")}`);
  console.log(`Target candles per symbol/bar: ${TARGET_CANDLES}`);
  console.log(`Fee rate: ${FEE_RATE} | Slippage: ${SLIPPAGE_PCT}`);
  console.log("");

  const results = [];

  for (const bar of BAR_LIST) {
    console.log(`Loading ${bar} candles...`);
    const candlesBySymbol = {};

    for (const symbol of SYMBOLS) {
      const candles = await fetchHistoricalCandles({
        symbol,
        bar,
        targetLimit: TARGET_CANDLES,
      });
      candlesBySymbol[symbol] = candles;
      console.log(`  ${symbol}: ${candles.length} candles`);
    }

    for (const scenario of SCENARIOS) {
      const symbolResults = [];

      for (const symbol of SYMBOLS) {
        const candles = candlesBySymbol[symbol] ?? [];
        if (candles.length === 0) {
          console.log(`  ${bar} ${scenario.key} ${symbol}: skipped, no candles`);
          continue;
        }
        symbolResults.push(backtestSymbol({ symbol, bar, candles, scenario }));
      }

      const result = summarizeScenario({ bar, scenario, symbolResults });
      results.push(result);
      printScenarioResult(result);
    }

    console.log("");
  }

  const reports = writeReports(results);
  const bestCandidate = results
    .filter((result) => result.summary.candidate)
    .sort((a, b) => b.summary.netPnl - a.summary.netPnl)[0] ?? null;

  console.log("Reports:");
  console.log(`- ${reports.jsonPath}`);
  console.log(`- ${reports.csvPath}`);

  console.log("");
  if (bestCandidate) {
    console.log(`Best candidate: ${bestCandidate.bar} ${bestCandidate.scenario} net ${bestCandidate.summary.netPnl}, PF ${bestCandidate.summary.profitFactor}`);
  } else {
    console.log("No candidate passed first-pass criteria. Do not integrate into paper loop.");
  }

  return { results, bestCandidate, reports };
}

const isDirectRun =
  process.argv[1] && import.meta.url === "file://" + process.argv[1];

if (isDirectRun) {
  runIntradayScalperResearch().catch((error) => {
    console.error("Intraday scalper research failed:", error);
    process.exitCode = 1;
  });
}
