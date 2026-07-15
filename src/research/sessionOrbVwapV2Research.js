import fs from "node:fs";
import path from "node:path";
import { config as baseConfig } from "../config.js";
import { fetchHistoricalCandles } from "../okxClient.js";
import { closeResearchTrade } from "./tradeAccounting.js";

/**
 * ZenBlade Session ORB + VWAP Reclaim v2 focused research script.
 *
 * Research only:
 * - no Railway loop integration
 * - no live trading
 * - no OKX API keys
 * - no real orders
 *
 * Why v2:
 * The broad Session ORB + VWAP v1 did not pass first-pass criteria, but
 * the VWAP reclaim after sweep scenario had positive gross PnL before fees.
 * This script isolates that setup and tests stricter, lower-frequency variants.
 */

const STRATEGY_ID = "session-orb-vwap-v2";
const STRATEGY_NAME = "ZenBlade Session ORB + VWAP Reclaim v2";

const DEFAULT_SYMBOLS = ["ETH-USDT", "BTC-USDT"];
const SYMBOLS = (process.env.SESSION_ORB_VWAP_V2_SYMBOLS ?? DEFAULT_SYMBOLS.join(","))
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const BAR = process.env.SESSION_ORB_VWAP_V2_BAR ?? "5m";
const TARGET_CANDLES = Number.parseInt(process.env.SESSION_ORB_VWAP_V2_CANDLES ?? "6000", 10);
const INITIAL_BALANCE = Number.parseFloat(
  process.env.RESEARCH_INITIAL_BALANCE ?? String(baseConfig.initialBalance ?? 1000)
);
const FEE_RATE = Number.parseFloat(
  process.env.RESEARCH_FEE_RATE ?? String(baseConfig.feeRate ?? 0.0008)
);
const SLIPPAGE_PCT = Number.parseFloat(process.env.RESEARCH_SLIPPAGE_PCT ?? "0.0002");

const REPORT_JSON = "reports/session-orb-vwap-v2-research.json";
const REPORT_CSV = "reports/session-orb-vwap-v2-research.csv";

const SESSION_US = {
  id: "us_open",
  label: "US open risk window",
  startMinuteUtc: 13 * 60 + 30,
  openingRangeMinutes: 30,
  tradeWindowMinutes: 180,
};

const SESSION_LATE_US = {
  id: "late_us",
  label: "Late US crypto window",
  startMinuteUtc: 20 * 60,
  openingRangeMinutes: 30,
  tradeWindowMinutes: 150,
};

const SCENARIOS = [
  {
    id: "eth_btc_reclaim_quality",
    description: "Focused sweep -> VWAP reclaim/rejection on ETH/BTC with stricter confirmation and wider reward.",
    sessions: [SESSION_US, SESSION_LATE_US],
    maxTradesPerDay: 1,
    maxTradesPerSession: 1,
    maxDailyLossUSDT: 10,
    minRangePct: 0.002,
    maxRangePct: 0.018,
    minAtrPct: 0.0007,
    maxAtrPct: 0.018,
    minVolumeSpike: 1.25,
    minImpulsePct: 0.0011,
    maxCandleRangePct: 0.018,
    sweepBufferPct: 0.001,
    reclaimBufferPct: 0.0007,
    stopBufferPct: 0.0018,
    minStopPct: 0.0028,
    maxStopPct: 0.009,
    rewardR: 1.65,
    maxHoldMinutes: 90,
    cooldownDaysAfterLoss: 1,
    riskPerTrade: 0.005,
    maxPositionValuePct: 0.22,
    allowLong: true,
    allowShort: true,
    allowedHoursUtc: null,
  },
  {
    id: "eth_only_reclaim_quality",
    description: "ETH-only sweep -> VWAP reclaim/rejection, testing whether ETH carried the small v1 gross edge.",
    sessions: [SESSION_US, SESSION_LATE_US],
    symbols: ["ETH-USDT"],
    maxTradesPerDay: 1,
    maxTradesPerSession: 1,
    maxDailyLossUSDT: 10,
    minRangePct: 0.002,
    maxRangePct: 0.018,
    minAtrPct: 0.0007,
    maxAtrPct: 0.018,
    minVolumeSpike: 1.15,
    minImpulsePct: 0.0009,
    maxCandleRangePct: 0.018,
    sweepBufferPct: 0.001,
    reclaimBufferPct: 0.0005,
    stopBufferPct: 0.0015,
    minStopPct: 0.0025,
    maxStopPct: 0.009,
    rewardR: 1.75,
    maxHoldMinutes: 105,
    cooldownDaysAfterLoss: 1,
    riskPerTrade: 0.005,
    maxPositionValuePct: 0.22,
    allowLong: true,
    allowShort: true,
    allowedHoursUtc: null,
  },
  {
    id: "late_us_reclaim_only",
    description: "Late US only, because v1 ORB/retest often improved near 20:00 while US open was weaker.",
    sessions: [SESSION_LATE_US],
    maxTradesPerDay: 1,
    maxTradesPerSession: 1,
    maxDailyLossUSDT: 8,
    minRangePct: 0.002,
    maxRangePct: 0.018,
    minAtrPct: 0.0007,
    maxAtrPct: 0.018,
    minVolumeSpike: 1.1,
    minImpulsePct: 0.0008,
    maxCandleRangePct: 0.018,
    sweepBufferPct: 0.001,
    reclaimBufferPct: 0.0005,
    stopBufferPct: 0.0015,
    minStopPct: 0.0025,
    maxStopPct: 0.009,
    rewardR: 1.6,
    maxHoldMinutes: 75,
    cooldownDaysAfterLoss: 1,
    riskPerTrade: 0.0045,
    maxPositionValuePct: 0.2,
    allowLong: true,
    allowShort: true,
    allowedHoursUtc: [20, 21],
  },
  {
    id: "long_only_reclaim",
    description: "Long-only reclaim after low sweep, to check whether short rejections are hurting net edge.",
    sessions: [SESSION_US, SESSION_LATE_US],
    maxTradesPerDay: 1,
    maxTradesPerSession: 1,
    maxDailyLossUSDT: 8,
    minRangePct: 0.002,
    maxRangePct: 0.018,
    minAtrPct: 0.0007,
    maxAtrPct: 0.018,
    minVolumeSpike: 1.15,
    minImpulsePct: 0.0009,
    maxCandleRangePct: 0.018,
    sweepBufferPct: 0.001,
    reclaimBufferPct: 0.0005,
    stopBufferPct: 0.0015,
    minStopPct: 0.0025,
    maxStopPct: 0.009,
    rewardR: 1.7,
    maxHoldMinutes: 90,
    cooldownDaysAfterLoss: 1,
    riskPerTrade: 0.0045,
    maxPositionValuePct: 0.2,
    allowLong: true,
    allowShort: false,
    allowedHoursUtc: null,
  },
  {
    id: "short_only_rejection",
    description: "Short-only rejection after high sweep, to check whether short side has standalone edge.",
    sessions: [SESSION_US, SESSION_LATE_US],
    maxTradesPerDay: 1,
    maxTradesPerSession: 1,
    maxDailyLossUSDT: 8,
    minRangePct: 0.002,
    maxRangePct: 0.018,
    minAtrPct: 0.0007,
    maxAtrPct: 0.018,
    minVolumeSpike: 1.15,
    minImpulsePct: 0.0009,
    maxCandleRangePct: 0.018,
    sweepBufferPct: 0.001,
    reclaimBufferPct: 0.0005,
    stopBufferPct: 0.0015,
    minStopPct: 0.0025,
    maxStopPct: 0.009,
    rewardR: 1.7,
    maxHoldMinutes: 90,
    cooldownDaysAfterLoss: 1,
    riskPerTrade: 0.0045,
    maxPositionValuePct: 0.2,
    allowLong: false,
    allowShort: true,
    allowedHoursUtc: null,
  },
];

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function dateKeyUtc(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function minuteOfDayUtc(timestamp) {
  const date = new Date(timestamp);
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

function hourKeyUtc(timestamp) {
  const date = new Date(timestamp);
  return `${String(date.getUTCHours()).padStart(2, "0")}:00`;
}

function hourNumberUtc(timestamp) {
  return new Date(timestamp).getUTCHours();
}

function typicalPrice(candle) {
  return (candle.high + candle.low + candle.close) / 3;
}

function calculateVwapByDay(candles) {
  const output = [];
  let currentDay = null;
  let pvSum = 0;
  let volumeSum = 0;

  for (const candle of candles) {
    const day = dateKeyUtc(candle.time);
    if (day !== currentDay) {
      currentDay = day;
      pvSum = 0;
      volumeSum = 0;
    }

    const volume = Math.max(candle.volume ?? 0, 0);
    pvSum += typicalPrice(candle) * volume;
    volumeSum += volume;

    output.push(volumeSum > 0 ? pvSum / volumeSum : null);
  }

  return output;
}

function calculateAtr(candles, period = 14) {
  const tr = candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const prevClose = candles[index - 1].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - prevClose),
      Math.abs(candle.low - prevClose)
    );
  });

  return tr.map((_, index) => {
    if (index < period - 1) return null;
    const slice = tr.slice(index - period + 1, index + 1);
    return slice.reduce((sum, value) => sum + value, 0) / period;
  });
}

function calculateVolumeSma(candles, period = 20) {
  return candles.map((_, index) => {
    if (index < period - 1) return null;
    const slice = candles.slice(index - period + 1, index + 1);
    return slice.reduce((sum, candle) => sum + (candle.volume ?? 0), 0) / period;
  });
}

function prepareSeries(candles) {
  const vwap = calculateVwapByDay(candles);
  const atr = calculateAtr(candles, 14);
  const volumeSma = calculateVolumeSma(candles, 20);

  return candles.map((candle, index) => {
    const atrValue = atr[index];
    const volumeSmaValue = volumeSma[index];
    const bodyPct = candle.close > 0 ? Math.abs(candle.close - candle.open) / candle.close : null;
    const candleRangePct = candle.close > 0 ? (candle.high - candle.low) / candle.close : null;

    return {
      ...candle,
      index,
      day: dateKeyUtc(candle.time),
      minuteUtc: minuteOfDayUtc(candle.time),
      hourUtc: hourKeyUtc(candle.time),
      hourNumberUtc: hourNumberUtc(candle.time),
      vwap: vwap[index],
      atr: atrValue,
      atrPct: atrValue && candle.close > 0 ? atrValue / candle.close : null,
      volumeSma: volumeSmaValue,
      volumeSpike: volumeSmaValue && volumeSmaValue > 0 ? candle.volume / volumeSmaValue : null,
      bodyPct,
      candleRangePct,
    };
  });
}

function groupCandlesByDay(candles) {
  const grouped = new Map();
  for (const candle of candles) {
    const day = dateKeyUtc(candle.time);
    if (!grouped.has(day)) grouped.set(day, []);
    grouped.get(day).push(candle);
  }
  return grouped;
}

function buildOpeningRange(dayCandles, session) {
  const start = session.startMinuteUtc;
  const end = start + session.openingRangeMinutes;
  const rangeCandles = dayCandles.filter(
    (candle) => candle.minuteUtc >= start && candle.minuteUtc < end
  );

  if (rangeCandles.length < Math.max(3, session.openingRangeMinutes / 5 - 1)) {
    return null;
  }

  const high = Math.max(...rangeCandles.map((candle) => candle.high));
  const low = Math.min(...rangeCandles.map((candle) => candle.low));
  const firstOpen = rangeCandles[0].open;
  const lastClose = rangeCandles[rangeCandles.length - 1].close;
  const mid = (high + low) / 2;
  const pct = mid > 0 ? (high - low) / mid : null;
  const directionPct = firstOpen > 0 ? (lastClose - firstOpen) / firstOpen : null;

  return {
    high,
    low,
    mid,
    pct,
    directionPct,
    startTime: rangeCandles[0].time,
    endTime: rangeCandles[rangeCandles.length - 1].time,
  };
}

function getTradeWindowCandles(dayCandles, session) {
  const start = session.startMinuteUtc + session.openingRangeMinutes;
  const end = start + session.tradeWindowMinutes;
  return dayCandles.filter((candle) => candle.minuteUtc >= start && candle.minuteUtc < end);
}

function passesRangeFilter(openingRange, scenario) {
  return (
    openingRange.pct !== null &&
    openingRange.pct >= scenario.minRangePct &&
    openingRange.pct <= scenario.maxRangePct
  );
}

function passesCandleFilter(candle, scenario) {
  if (!candle.vwap || !candle.atrPct || !candle.volumeSpike || !candle.bodyPct || !candle.candleRangePct) {
    return false;
  }

  if (scenario.allowedHoursUtc && !scenario.allowedHoursUtc.includes(candle.hourNumberUtc)) {
    return false;
  }

  return (
    candle.atrPct >= scenario.minAtrPct &&
    candle.atrPct <= scenario.maxAtrPct &&
    candle.volumeSpike >= scenario.minVolumeSpike &&
    candle.bodyPct >= scenario.minImpulsePct &&
    candle.candleRangePct <= scenario.maxCandleRangePct
  );
}

function longEntryPrice(rawPrice) {
  return rawPrice * (1 + SLIPPAGE_PCT);
}

function shortEntryPrice(rawPrice) {
  return rawPrice * (1 - SLIPPAGE_PCT);
}

function longExitPrice(rawPrice) {
  return rawPrice * (1 - SLIPPAGE_PCT);
}

function shortExitPrice(rawPrice) {
  return rawPrice * (1 + SLIPPAGE_PCT);
}

function buildPosition({ symbol, scenario, session, side, candle, rawStop, signalType, openingRange }) {
  const entryPrice = side === "LONG" ? longEntryPrice(candle.close) : shortEntryPrice(candle.close);
  const stopPrice = rawStop;
  const stopPct =
    side === "LONG"
      ? (entryPrice - stopPrice) / entryPrice
      : (stopPrice - entryPrice) / entryPrice;

  if (!Number.isFinite(stopPct) || stopPct < scenario.minStopPct || stopPct > scenario.maxStopPct) {
    return null;
  }

  const riskBudget = INITIAL_BALANCE * scenario.riskPerTrade;
  const riskPerUnit = Math.abs(entryPrice - stopPrice);
  if (!Number.isFinite(riskPerUnit) || riskPerUnit <= 0) return null;

  const riskBasedSize = riskBudget / riskPerUnit;
  const maxPositionValue = INITIAL_BALANCE * scenario.maxPositionValuePct;
  const maxSize = maxPositionValue / entryPrice;
  const size = Math.min(riskBasedSize, maxSize);

  if (!Number.isFinite(size) || size <= 0) return null;

  const rewardDistance = Math.abs(entryPrice - stopPrice) * scenario.rewardR;
  const takeProfit = side === "LONG" ? entryPrice + rewardDistance : entryPrice - rewardDistance;

  return {
    symbol,
    scenarioId: scenario.id,
    sessionId: session.id,
    sessionLabel: session.label,
    side,
    signalType,
    entryTime: candle.time,
    entryDate: candle.day,
    entryHourUtc: candle.hourUtc,
    entryPrice: round(entryPrice, 8),
    size: round(size, 8),
    stopPrice: round(stopPrice, 8),
    takeProfit: round(takeProfit, 8),
    maxHoldMinutes: scenario.maxHoldMinutes,
    openingRangeHigh: round(openingRange.high, 8),
    openingRangeLow: round(openingRange.low, 8),
    openingRangePct: round(openingRange.pct * 100, 3),
    openingRangeDirectionPct: round(openingRange.directionPct * 100, 3),
    entryVwap: round(candle.vwap, 8),
    entryAtrPct: round(candle.atrPct * 100, 3),
    entryVolumeSpike: round(candle.volumeSpike, 2),
    entryBodyPct: round(candle.bodyPct * 100, 3),
  };
}

function getExit({ position, candle, isLastCandle }) {
  const heldMinutes = (candle.time - position.entryTime) / 60_000;

  if (position.side === "LONG") {
    const stopHit = candle.low <= position.stopPrice;
    const takeHit = candle.high >= position.takeProfit;

    if (stopHit && takeHit) return { reason: "STOP_FIRST_CONSERVATIVE", rawClose: position.stopPrice };
    if (stopHit) return { reason: "STOP", rawClose: position.stopPrice };
    if (takeHit) return { reason: "TAKE_PROFIT", rawClose: position.takeProfit };
  }

  if (position.side === "SHORT") {
    const stopHit = candle.high >= position.stopPrice;
    const takeHit = candle.low <= position.takeProfit;

    if (stopHit && takeHit) return { reason: "STOP_FIRST_CONSERVATIVE", rawClose: position.stopPrice };
    if (stopHit) return { reason: "STOP", rawClose: position.stopPrice };
    if (takeHit) return { reason: "TAKE_PROFIT", rawClose: position.takeProfit };
  }

  if (heldMinutes >= position.maxHoldMinutes) {
    return { reason: "MAX_HOLD", rawClose: candle.close };
  }

  if (isLastCandle) {
    return { reason: "SESSION_END", rawClose: candle.close };
  }

  return null;
}

function closePosition({ position, exit, balance }) {
  const closePrice =
    position.side === "LONG" ? longExitPrice(exit.rawClose) : shortExitPrice(exit.rawClose);

  const closed = closeResearchTrade({
    position: {
      ...position,
      closeTime: exit.closeTime,
    },
    closePrice: round(closePrice, 8),
    closeReason: exit.reason,
    balance,
    feeRate: FEE_RATE,
  });

  return {
    balance: closed.balance,
    trade: {
      ...closed.trade,
      symbol: position.symbol,
      scenarioId: position.scenarioId,
      sessionId: position.sessionId,
      sessionLabel: position.sessionLabel,
      signalType: position.signalType,
      entryDate: position.entryDate,
      entryHourUtc: position.entryHourUtc,
      closeHourUtc: hourKeyUtc(exit.closeTime),
      openingRangeHigh: position.openingRangeHigh,
      openingRangeLow: position.openingRangeLow,
      openingRangePct: position.openingRangePct,
      openingRangeDirectionPct: position.openingRangeDirectionPct,
      entryVwap: position.entryVwap,
      entryAtrPct: position.entryAtrPct,
      entryVolumeSpike: position.entryVolumeSpike,
      entryBodyPct: position.entryBodyPct,
      stopPrice: position.stopPrice,
      takeProfit: position.takeProfit,
      holdMinutes: round((exit.closeTime - position.entryTime) / 60_000, 1),
    },
  };
}

function updateSweepState({ state, candle, scenario, openingRange }) {
  const lowSweepLevel = openingRange.low * (1 - scenario.sweepBufferPct);
  const highSweepLevel = openingRange.high * (1 + scenario.sweepBufferPct);

  if (candle.low < lowSweepLevel) {
    state.sweptLow = true;
    state.sweepLow = Math.min(state.sweepLow ?? candle.low, candle.low);
  }

  if (candle.high > highSweepLevel) {
    state.sweptHigh = true;
    state.sweepHigh = Math.max(state.sweepHigh ?? candle.high, candle.high);
  }
}

function detectReclaimSignal({ state, candle, scenario, openingRange }) {
  updateSweepState({ state, candle, scenario, openingRange });

  if (!passesCandleFilter(candle, scenario)) return null;

  const reclaimLong =
    state.sweptLow &&
    scenario.allowLong &&
    candle.close > openingRange.low * (1 + scenario.reclaimBufferPct) &&
    candle.close > candle.vwap &&
    candle.close > candle.open;

  if (reclaimLong) {
    return {
      side: "LONG",
      signalType: "VWAP_RECLAIM_AFTER_LOW_SWEEP",
      rawStop: (state.sweepLow ?? openingRange.low) * (1 - scenario.stopBufferPct),
    };
  }

  const reclaimShort =
    state.sweptHigh &&
    scenario.allowShort &&
    candle.close < openingRange.high * (1 - scenario.reclaimBufferPct) &&
    candle.close < candle.vwap &&
    candle.close < candle.open;

  if (reclaimShort) {
    return {
      side: "SHORT",
      signalType: "VWAP_REJECTION_AFTER_HIGH_SWEEP",
      rawStop: (state.sweepHigh ?? openingRange.high) * (1 + scenario.stopBufferPct),
    };
  }

  return null;
}

function scenarioSymbols(scenario) {
  const allowed = scenario.symbols ?? SYMBOLS;
  return SYMBOLS.filter((symbol) => allowed.includes(symbol));
}

function backtestSymbolScenario({ symbol, scenario, candles }) {
  const prepared = prepareSeries(candles);
  const byDay = groupCandlesByDay(prepared);
  const trades = [];
  let balance = INITIAL_BALANCE;
  let cooldownDays = 0;

  for (const [day, dayCandles] of byDay.entries()) {
    if (cooldownDays > 0) {
      cooldownDays--;
      continue;
    }

    let tradesToday = 0;
    let dailyNetPnl = 0;

    for (const session of scenario.sessions) {
      if (tradesToday >= scenario.maxTradesPerDay) break;
      if (dailyNetPnl <= -scenario.maxDailyLossUSDT) break;

      const openingRange = buildOpeningRange(dayCandles, session);
      if (!openingRange || !passesRangeFilter(openingRange, scenario)) continue;

      const tradeWindowCandles = getTradeWindowCandles(dayCandles, session);
      if (tradeWindowCandles.length < 3) continue;

      const state = {
        sweptLow: false,
        sweptHigh: false,
        sweepLow: null,
        sweepHigh: null,
      };

      let position = null;
      let tradesThisSession = 0;

      for (let i = 0; i < tradeWindowCandles.length; i++) {
        const candle = tradeWindowCandles[i];
        const isLastCandle = i === tradeWindowCandles.length - 1;

        if (position) {
          const exit = getExit({ position, candle, isLastCandle });
          if (exit) {
            const closed = closePosition({
              position,
              exit: {
                ...exit,
                closeTime: candle.time,
              },
              balance,
            });

            balance = closed.balance;
            dailyNetPnl += closed.trade.netPnl;
            trades.push({
              ...closed.trade,
              day,
            });

            if (closed.trade.netPnl < 0 && scenario.cooldownDaysAfterLoss > 0) {
              cooldownDays = scenario.cooldownDaysAfterLoss;
            }

            position = null;
          }

          continue;
        }

        if (tradesThisSession >= scenario.maxTradesPerSession) continue;
        if (tradesToday >= scenario.maxTradesPerDay) continue;
        if (dailyNetPnl <= -scenario.maxDailyLossUSDT) continue;

        const signal = detectReclaimSignal({ state, candle, scenario, openingRange });
        if (!signal) continue;

        const newPosition = buildPosition({
          symbol,
          scenario,
          session,
          side: signal.side,
          candle,
          rawStop: signal.rawStop,
          signalType: signal.signalType,
          openingRange,
        });

        if (!newPosition) continue;

        position = newPosition;
        tradesToday++;
        tradesThisSession++;
      }
    }
  }

  return {
    symbol,
    scenarioId: scenario.id,
    trades,
    endingBalance: round(balance),
  };
}

function sum(values) {
  return values.reduce((acc, value) => acc + (Number.isFinite(value) ? value : 0), 0);
}

function summarizeBy(trades, keySelector) {
  const grouped = new Map();

  for (const trade of trades) {
    const key = keySelector(trade);
    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        trades: 0,
        wins: 0,
        grossPnl: 0,
        fees: 0,
        netPnl: 0,
      });
    }

    const row = grouped.get(key);
    row.trades++;
    row.wins += trade.netPnl > 0 ? 1 : 0;
    row.grossPnl += trade.grossPnl;
    row.fees += trade.fees;
    row.netPnl += trade.netPnl;
  }

  return Array.from(grouped.values())
    .map((row) => ({
      ...row,
      grossPnl: round(row.grossPnl),
      fees: round(row.fees),
      netPnl: round(row.netPnl),
      winRatePct: row.trades > 0 ? round((row.wins / row.trades) * 100, 1) : null,
    }))
    .sort((a, b) => b.netPnl - a.netPnl);
}

function calculateMaxDrawdown(trades) {
  const sorted = [...trades].sort((a, b) => a.closeTime - b.closeTime);
  let equity = INITIAL_BALANCE;
  let peak = INITIAL_BALANCE;
  let maxDrawdown = 0;

  for (const trade of sorted) {
    equity += trade.netPnl;
    if (equity > peak) {
      peak = equity;
    }
    const drawdown = peak - equity;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }

  return round(maxDrawdown);
}

function summarizeScenario({ scenario, symbolResults, allCalendarDays }) {
  const trades = symbolResults.flatMap((result) => result.trades);
  const totalTrades = trades.length;
  const wins = trades.filter((trade) => trade.netPnl > 0);
  const losses = trades.filter((trade) => trade.netPnl < 0);
  const grossPnl = round(sum(trades.map((trade) => trade.grossPnl)));
  const fees = round(sum(trades.map((trade) => trade.fees)));
  const netPnl = round(sum(trades.map((trade) => trade.netPnl)));
  const winRatePct = totalTrades > 0 ? round((wins.length / totalTrades) * 100, 1) : null;
  const positiveNet = sum(wins.map((trade) => trade.netPnl));
  const negativeNet = Math.abs(sum(losses.map((trade) => trade.netPnl)));
  const profitFactor = negativeNet > 0 ? round(positiveNet / negativeNet, 2) : null;
  const maxDrawdown = calculateMaxDrawdown(trades);
  const avgHoldMinutes =
    totalTrades > 0 ? round(sum(trades.map((trade) => trade.holdMinutes)) / totalTrades, 1) : null;
  const calendarDays = allCalendarDays.size;
  const tradesPerDay = calendarDays > 0 ? round(totalTrades / calendarDays, 2) : null;

  const bySymbol = summarizeBy(trades, (trade) => trade.symbol);
  const byHourUtc = summarizeBy(trades, (trade) => trade.entryHourUtc);
  const bySession = summarizeBy(trades, (trade) => trade.sessionId);
  const bySide = summarizeBy(trades, (trade) => trade.side);
  const bySignal = summarizeBy(trades, (trade) => trade.signalType);
  const byExitReason = summarizeBy(trades, (trade) => trade.closeReason);

  const profitableSymbols = bySymbol.filter((row) => row.netPnl > 0).length;
  const grossEdge = grossPnl > 0;
  const candidate =
    totalTrades >= 20 &&
    totalTrades <= 120 &&
    tradesPerDay !== null &&
    tradesPerDay <= 6 &&
    grossEdge &&
    netPnl > 0 &&
    (profitFactor === null || profitFactor >= 1.1) &&
    maxDrawdown <= INITIAL_BALANCE * 0.12 &&
    profitableSymbols >= Math.min(2, scenarioSymbols(scenario).length);

  return {
    scenarioId: scenario.id,
    description: scenario.description,
    candidate,
    totalTrades,
    tradesPerDay,
    winRatePct,
    grossPnl,
    fees,
    netPnl,
    profitFactor,
    maxDrawdown,
    avgHoldMinutes,
    profitableSymbols,
    bySymbol,
    byHourUtc,
    bySession,
    bySide,
    bySignal,
    byExitReason,
    sampleTrades: trades.slice(0, 10),
  };
}

function writeReports({ summaries, rawResults, metadata }) {
  fs.mkdirSync(path.dirname(REPORT_JSON), { recursive: true });

  const payload = {
    strategyId: STRATEGY_ID,
    strategyName: STRATEGY_NAME,
    generatedAt: new Date().toISOString(),
    safety: {
      mode: "research/paper only",
      realOrders: false,
      okxApiKeysRequired: false,
      liveTrading: false,
      railwayPaperLoopTouched: false,
    },
    metadata,
    summaries,
    rawResults,
  };

  fs.writeFileSync(REPORT_JSON, `${JSON.stringify(payload, null, 2)}\n`);

  const csvRows = [
    [
      "scenarioId",
      "candidate",
      "totalTrades",
      "tradesPerDay",
      "winRatePct",
      "grossPnl",
      "fees",
      "netPnl",
      "profitFactor",
      "maxDrawdown",
      "avgHoldMinutes",
      "profitableSymbols",
    ].join(","),
  ];

  for (const summary of summaries) {
    csvRows.push(
      [
        summary.scenarioId,
        summary.candidate,
        summary.totalTrades,
        summary.tradesPerDay,
        summary.winRatePct,
        summary.grossPnl,
        summary.fees,
        summary.netPnl,
        summary.profitFactor,
        summary.maxDrawdown,
        summary.avgHoldMinutes,
        summary.profitableSymbols,
      ].join(",")
    );
  }

  fs.writeFileSync(REPORT_CSV, `${csvRows.join("\n")}\n`);
}

function printSummary(summary) {
  console.log(
    [
      `${BAR} | ${summary.scenarioId}`,
      `trades ${summary.totalTrades}`,
      `perDay ${summary.tradesPerDay}`,
      `win ${summary.winRatePct}%`,
      `gross ${summary.grossPnl}`,
      `fees ${summary.fees}`,
      `net ${summary.netPnl}`,
      `PF ${summary.profitFactor}`,
      `DD ${summary.maxDrawdown}`,
      `avgHold ${summary.avgHoldMinutes}m`,
      `candidate ${summary.candidate}`,
    ].join(" | ")
  );

  const bestSymbols = summary.bySymbol
    .slice(0, 3)
    .map((row) => `${row.key}:${row.netPnl}`)
    .join(" | ");
  const worstSymbols = summary.bySymbol
    .slice(-3)
    .reverse()
    .map((row) => `${row.key}:${row.netPnl}`)
    .join(" | ");
  const bestHours = summary.byHourUtc
    .slice(0, 3)
    .map((row) => `${row.key}=${row.netPnl}`)
    .join(" | ");
  const worstHours = summary.byHourUtc
    .slice(-3)
    .reverse()
    .map((row) => `${row.key}=${row.netPnl}`)
    .join(" | ");
  const bestSides = summary.bySide
    .slice(0, 2)
    .map((row) => `${row.key}:${row.netPnl}`)
    .join(" | ");
  const exits = summary.byExitReason
    .slice(0, 4)
    .map((row) => `${row.key}:${row.trades}/${row.netPnl}`)
    .join(" | ");

  console.log(`  best symbols: ${bestSymbols || "n/a"}`);
  console.log(`  worst symbols: ${worstSymbols || "n/a"}`);
  console.log(`  best hours UTC: ${bestHours || "n/a"}`);
  console.log(`  worst hours UTC: ${worstHours || "n/a"}`);
  console.log(`  sides: ${bestSides || "n/a"}`);
  console.log(`  exits: ${exits || "n/a"}`);
}

export async function runSessionOrbVwapV2Research() {
  console.log(`=== ${STRATEGY_NAME} Research ===`);
  console.log("Mode: research / paper only");
  console.log("Safety: no real orders, no OKX API keys, no live trading");
  console.log(`Symbols: ${SYMBOLS.join(", ")}`);
  console.log(`Bar: ${BAR}`);
  console.log(`Target candles per symbol: ${TARGET_CANDLES}`);
  console.log(`Fee rate: ${FEE_RATE} | Slippage: ${SLIPPAGE_PCT}`);
  console.log("Focus: sweep -> VWAP reclaim/rejection only, no broad ORB breakout/retest.");

  const marketData = new Map();
  const allCalendarDays = new Set();

  console.log(`\nLoading ${BAR} candles...`);
  for (const symbol of SYMBOLS) {
    const candles = await fetchHistoricalCandles({
      symbol,
      bar: BAR,
      targetLimit: TARGET_CANDLES,
    });

    marketData.set(symbol, candles);
    for (const candle of candles) {
      allCalendarDays.add(dateKeyUtc(candle.time));
    }

    console.log(`  ${symbol}: ${candles.length} candles`);
  }

  const rawResults = [];
  const summaries = [];

  for (const scenario of SCENARIOS) {
    const symbolResults = [];

    for (const symbol of scenarioSymbols(scenario)) {
      const candles = marketData.get(symbol) ?? [];
      if (candles.length === 0) continue;

      const result = backtestSymbolScenario({
        symbol,
        scenario,
        candles,
      });

      symbolResults.push(result);
      rawResults.push(result);
    }

    const summary = summarizeScenario({
      scenario,
      symbolResults,
      allCalendarDays,
    });

    summaries.push(summary);
    printSummary(summary);
  }

  writeReports({
    summaries,
    rawResults,
    metadata: {
      symbols: SYMBOLS,
      bar: BAR,
      targetCandles: TARGET_CANDLES,
      feeRate: FEE_RATE,
      slippagePct: SLIPPAGE_PCT,
      initialBalance: INITIAL_BALANCE,
      scenarios: SCENARIOS,
      priorFinding:
        "Session ORB + VWAP v1 failed first-pass criteria, but vwap_reclaim_after_sweep had positive gross PnL before fees.",
      philosophy:
        "Focused event model: isolate sweep -> VWAP reclaim/rejection, reduce trade count, test side/session/symbol subsets.",
    },
  });

  console.log("\nReports:");
  console.log(`- ${REPORT_JSON}`);
  console.log(`- ${REPORT_CSV}`);

  const candidates = summaries.filter((summary) => summary.candidate);
  if (candidates.length === 0) {
    console.log("\nNo candidate passed first-pass criteria. Do not integrate into paper loop.");
  } else {
    console.log("\nCandidates found:");
    for (const candidate of candidates) {
      console.log(`- ${candidate.scenarioId}: net ${candidate.netPnl}, PF ${candidate.profitFactor}, DD ${candidate.maxDrawdown}`);
    }
    console.log("Next step: robustness check before any disabled-by-default paper module.");
  }

  return { summaries, rawResults };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSessionOrbVwapV2Research().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
