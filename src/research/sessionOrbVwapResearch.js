import fs from "node:fs";
import path from "node:path";
import { config as baseConfig } from "../config.js";
import { fetchHistoricalCandles } from "../okxClient.js";
import { closeResearchTrade } from "./tradeAccounting.js";

/**
 * ZenBlade Session ORB + VWAP Reclaim research script.
 *
 * Research only:
 * - no Railway loop integration
 * - no live trading
 * - no OKX API keys
 * - no real orders
 *
 * Core idea:
 * Trade only intraday session events, not all-day EMA noise:
 * 1) Opening Range Breakout (ORB)
 * 2) Liquidity sweep/fakeout followed by VWAP reclaim/rejection
 * 3) ORB breakout followed by retest of range/VWAP
 */

const STRATEGY_ID = "session-orb-vwap";
const STRATEGY_NAME = "ZenBlade Session ORB + VWAP Reclaim";

const DEFAULT_SYMBOLS = ["BTC-USDT", "ETH-USDT", "SOL-USDT"];
const SYMBOLS = (process.env.SESSION_ORB_VWAP_SYMBOLS ?? DEFAULT_SYMBOLS.join(","))
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const BAR = process.env.SESSION_ORB_VWAP_BAR ?? "5m";
const TARGET_CANDLES = Number.parseInt(process.env.SESSION_ORB_VWAP_CANDLES ?? "6000", 10);
const INITIAL_BALANCE = Number.parseFloat(
  process.env.RESEARCH_INITIAL_BALANCE ?? String(baseConfig.initialBalance ?? 1000)
);
const FEE_RATE = Number.parseFloat(
  process.env.RESEARCH_FEE_RATE ?? String(baseConfig.feeRate ?? 0.0008)
);
const SLIPPAGE_PCT = Number.parseFloat(process.env.RESEARCH_SLIPPAGE_PCT ?? "0.0002");

const REPORT_JSON = "reports/session-orb-vwap-research.json";
const REPORT_CSV = "reports/session-orb-vwap-research.csv";

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

const SESSION_EUROPE = {
  id: "europe_london",
  label: "Europe/London activity window",
  startMinuteUtc: 8 * 60,
  openingRangeMinutes: 45,
  tradeWindowMinutes: 165,
};

const SCENARIOS = [
  {
    id: "orb_breakout_conservative",
    description: "Opening range breakout with VWAP bias, volume confirmation, and R-multiple exits.",
    sessions: [SESSION_US, SESSION_LATE_US],
    mode: "ORB_BREAKOUT",
    maxTradesPerDay: 2,
    maxTradesPerSession: 1,
    maxDailyLossUSDT: 18,
    minRangePct: 0.0025,
    maxRangePct: 0.018,
    minAtrPct: 0.0008,
    maxAtrPct: 0.018,
    minVolumeSpike: 1.25,
    minImpulsePct: 0.0012,
    maxCandleRangePct: 0.018,
    breakoutBufferPct: 0.0012,
    useVwapBias: true,
    stopMode: "RANGE_MID",
    minStopPct: 0.0025,
    maxStopPct: 0.009,
    rewardR: 1.45,
    maxHoldMinutes: 90,
    cooldownSessionsAfterLoss: 1,
    riskPerTrade: 0.006,
    maxPositionValuePct: 0.28,
    allowLong: true,
    allowShort: true,
  },
  {
    id: "vwap_reclaim_after_sweep",
    description: "Fake breakout / liquidity sweep outside opening range, then VWAP reclaim/rejection.",
    sessions: [SESSION_US, SESSION_LATE_US],
    mode: "VWAP_RECLAIM_AFTER_SWEEP",
    maxTradesPerDay: 2,
    maxTradesPerSession: 1,
    maxDailyLossUSDT: 16,
    minRangePct: 0.002,
    maxRangePct: 0.02,
    minAtrPct: 0.0007,
    maxAtrPct: 0.02,
    minVolumeSpike: 1.15,
    minImpulsePct: 0.0009,
    maxCandleRangePct: 0.02,
    sweepBufferPct: 0.001,
    reclaimBufferPct: 0.0005,
    stopBufferPct: 0.0015,
    minStopPct: 0.0025,
    maxStopPct: 0.010,
    rewardR: 1.35,
    maxHoldMinutes: 75,
    cooldownSessionsAfterLoss: 1,
    riskPerTrade: 0.005,
    maxPositionValuePct: 0.25,
    allowLong: true,
    allowShort: true,
  },
  {
    id: "orb_vwap_retest",
    description: "Breakout first, then enter only on retest of range edge/VWAP with continuation close.",
    sessions: [SESSION_US, SESSION_LATE_US, SESSION_EUROPE],
    mode: "ORB_VWAP_RETEST",
    maxTradesPerDay: 2,
    maxTradesPerSession: 1,
    maxDailyLossUSDT: 16,
    minRangePct: 0.0025,
    maxRangePct: 0.018,
    minAtrPct: 0.0008,
    maxAtrPct: 0.018,
    minVolumeSpike: 1.05,
    minImpulsePct: 0.0007,
    maxCandleRangePct: 0.018,
    breakoutBufferPct: 0.001,
    retestTolerancePct: 0.0018,
    minBreakoutCandlesBeforeRetest: 1,
    stopMode: "RETEST_INVALIDATION",
    minStopPct: 0.0025,
    maxStopPct: 0.0085,
    rewardR: 1.55,
    maxHoldMinutes: 120,
    cooldownSessionsAfterLoss: 1,
    riskPerTrade: 0.005,
    maxPositionValuePct: 0.24,
    allowLong: true,
    allowShort: true,
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

function typicalPrice(candle) {
  return (candle.high + candle.low + candle.close) / 3;
}

function trueRange(current, previous) {
  if (!previous) return current.high - current.low;
  return Math.max(
    current.high - current.low,
    Math.abs(current.high - previous.close),
    Math.abs(current.low - previous.close)
  );
}

function calculateAtrSeries(candles, period = 14) {
  const tr = candles.map((candle, index) => trueRange(candle, candles[index - 1]));
  const atr = Array(candles.length).fill(null);
  let rolling = 0;

  for (let i = 0; i < tr.length; i++) {
    rolling += tr[i];

    if (i >= period) {
      rolling -= tr[i - period];
    }

    if (i >= period - 1) {
      atr[i] = rolling / period;
    }
  }

  return atr;
}

function calculateVolumeSmaSeries(candles, period = 20) {
  const values = Array(candles.length).fill(null);
  let rolling = 0;

  for (let i = 0; i < candles.length; i++) {
    rolling += candles[i].volume;

    if (i >= period) {
      rolling -= candles[i - period].volume;
    }

    if (i >= period - 1) {
      values[i] = rolling / period;
    }
  }

  return values;
}

function calculateDailyVwapSeries(candles) {
  const values = Array(candles.length).fill(null);
  let currentDay = null;
  let cumulativePriceVolume = 0;
  let cumulativeVolume = 0;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const day = dateKeyUtc(candle.time);

    if (day !== currentDay) {
      currentDay = day;
      cumulativePriceVolume = 0;
      cumulativeVolume = 0;
    }

    cumulativePriceVolume += typicalPrice(candle) * candle.volume;
    cumulativeVolume += candle.volume;

    if (cumulativeVolume > 0) {
      values[i] = cumulativePriceVolume / cumulativeVolume;
    }
  }

  return values;
}

function prepareSeries(candles) {
  const atr = calculateAtrSeries(candles, 14);
  const volumeSma = calculateVolumeSmaSeries(candles, 20);
  const dailyVwap = calculateDailyVwapSeries(candles);

  return candles.map((candle, index) => ({
    ...candle,
    index,
    dateKey: dateKeyUtc(candle.time),
    minuteUtc: minuteOfDayUtc(candle.time),
    hourUtc: hourKeyUtc(candle.time),
    atr: atr[index],
    atrPct: atr[index] && candle.close > 0 ? atr[index] / candle.close : null,
    volumeSma: volumeSma[index],
    volumeSpike:
      volumeSma[index] && volumeSma[index] > 0 ? candle.volume / volumeSma[index] : null,
    vwap: dailyVwap[index],
    candleRangePct: candle.open > 0 ? (candle.high - candle.low) / candle.open : null,
    bodyPct: candle.open > 0 ? Math.abs(candle.close - candle.open) / candle.open : null,
  }));
}

function groupCandlesByDay(candles) {
  const byDay = new Map();

  for (const candle of candles) {
    if (!byDay.has(candle.dateKey)) {
      byDay.set(candle.dateKey, []);
    }
    byDay.get(candle.dateKey).push(candle);
  }

  return byDay;
}

function buildOpeningRange(dayCandles, session) {
  const rangeStart = session.startMinuteUtc;
  const rangeEnd = rangeStart + session.openingRangeMinutes;
  const rangeCandles = dayCandles.filter(
    (candle) => candle.minuteUtc >= rangeStart && candle.minuteUtc < rangeEnd
  );

  if (rangeCandles.length < Math.max(3, Math.floor(session.openingRangeMinutes / 10))) {
    return null;
  }

  const high = Math.max(...rangeCandles.map((candle) => candle.high));
  const low = Math.min(...rangeCandles.map((candle) => candle.low));
  const firstOpen = rangeCandles[0].open;
  const lastClose = rangeCandles[rangeCandles.length - 1].close;
  const mid = (high + low) / 2;
  const rangePct = firstOpen > 0 ? (high - low) / firstOpen : null;

  if (!Number.isFinite(rangePct) || rangePct <= 0) return null;

  return {
    startTime: rangeCandles[0].time,
    endTime: rangeCandles[rangeCandles.length - 1].time,
    high,
    low,
    mid,
    rangePct,
    firstOpen,
    lastClose,
    candleCount: rangeCandles.length,
  };
}

function getTradeWindowCandles(dayCandles, session) {
  const start = session.startMinuteUtc + session.openingRangeMinutes;
  const end = start + session.tradeWindowMinutes;

  return dayCandles.filter((candle) => candle.minuteUtc >= start && candle.minuteUtc < end);
}

function passesRangeFilter(openingRange, scenario) {
  return (
    openingRange.rangePct >= scenario.minRangePct &&
    openingRange.rangePct <= scenario.maxRangePct
  );
}

function passesCandleFilter(candle, scenario) {
  if (!candle.atrPct || candle.atrPct < scenario.minAtrPct || candle.atrPct > scenario.maxAtrPct) {
    return false;
  }

  if (
    !candle.candleRangePct ||
    candle.candleRangePct <= 0 ||
    candle.candleRangePct > scenario.maxCandleRangePct
  ) {
    return false;
  }

  const hasVolume = candle.volumeSpike !== null && candle.volumeSpike >= scenario.minVolumeSpike;
  const hasImpulse = candle.bodyPct !== null && candle.bodyPct >= scenario.minImpulsePct;

  return hasVolume || hasImpulse;
}

function longEntryPrice(rawClose) {
  return rawClose * (1 + SLIPPAGE_PCT);
}

function shortEntryPrice(rawClose) {
  return rawClose * (1 - SLIPPAGE_PCT);
}

function longExitPrice(rawClose) {
  return rawClose * (1 - SLIPPAGE_PCT);
}

function shortExitPrice(rawClose) {
  return rawClose * (1 + SLIPPAGE_PCT);
}

function clampStop({ side, entryPrice, rawStop, scenario }) {
  const minRisk = entryPrice * scenario.minStopPct;
  const maxRisk = entryPrice * scenario.maxStopPct;

  if (side === "LONG") {
    let risk = entryPrice - rawStop;
    if (!Number.isFinite(risk) || risk <= 0) return null;
    risk = Math.min(Math.max(risk, minRisk), maxRisk);
    return entryPrice - risk;
  }

  let risk = rawStop - entryPrice;
  if (!Number.isFinite(risk) || risk <= 0) return null;
  risk = Math.min(Math.max(risk, minRisk), maxRisk);
  return entryPrice + risk;
}

function buildPosition({
  symbol,
  scenario,
  session,
  side,
  candle,
  rawEntryPrice,
  rawStop,
  balance,
  signalType,
  openingRange,
}) {
  const entryPrice = side === "LONG" ? longEntryPrice(rawEntryPrice) : shortEntryPrice(rawEntryPrice);
  const stopPrice = clampStop({ side, entryPrice, rawStop, scenario });
  if (!Number.isFinite(stopPrice) || stopPrice <= 0) return null;

  const riskPerUnit =
    side === "LONG" ? entryPrice - stopPrice : stopPrice - entryPrice;

  if (!Number.isFinite(riskPerUnit) || riskPerUnit <= 0) return null;

  const riskBudget = balance * scenario.riskPerTrade;
  const maxPositionValue = balance * scenario.maxPositionValuePct;
  const riskBasedSize = riskBudget / riskPerUnit;
  const valueBasedSize = maxPositionValue / entryPrice;
  const size = Math.min(riskBasedSize, valueBasedSize);

  if (!Number.isFinite(size) || size <= 0) return null;

  const takeProfit =
    side === "LONG"
      ? entryPrice + riskPerUnit * scenario.rewardR
      : entryPrice - riskPerUnit * scenario.rewardR;

  return {
    symbol,
    strategyId: STRATEGY_ID,
    scenarioId: scenario.id,
    sessionId: session.id,
    sessionLabel: session.label,
    side,
    entryTime: candle.time,
    entryDate: candle.dateKey,
    entryHourUtc: candle.hourUtc,
    entryMinuteUtc: candle.minuteUtc,
    entryPrice: round(entryPrice, 8),
    rawEntryPrice: round(rawEntryPrice, 8),
    stopPrice: round(stopPrice, 8),
    takeProfit: round(takeProfit, 8),
    size: round(size, 8),
    signalType,
    openingRangeHigh: round(openingRange.high, 8),
    openingRangeLow: round(openingRange.low, 8),
    openingRangePct: round(openingRange.rangePct * 100, 4),
    entryVwap: round(candle.vwap, 8),
    entryAtrPct: round(candle.atrPct * 100, 4),
    entryVolumeSpike: round(candle.volumeSpike, 3),
  };
}

function getExit({ position, candle, scenario, isLastCandle }) {
  const entryAgeMinutes = (candle.time - position.entryTime) / 60_000;

  if (candle.time <= position.entryTime) {
    return null;
  }

  if (position.side === "LONG") {
    const hitStop = candle.low <= position.stopPrice;
    const hitTake = candle.high >= position.takeProfit;

    if (hitStop && hitTake) {
      return { reason: "STOP_AND_TP_SAME_CANDLE_STOP_FIRST", rawClose: position.stopPrice };
    }

    if (hitStop) {
      return { reason: "STOP_LOSS", rawClose: position.stopPrice };
    }

    if (hitTake) {
      return { reason: "TAKE_PROFIT", rawClose: position.takeProfit };
    }

    if (entryAgeMinutes >= scenario.maxHoldMinutes) {
      return { reason: "MAX_HOLD", rawClose: candle.close };
    }

    if (isLastCandle) {
      return { reason: "SESSION_END", rawClose: candle.close };
    }

    return null;
  }

  const hitStop = candle.high >= position.stopPrice;
  const hitTake = candle.low <= position.takeProfit;

  if (hitStop && hitTake) {
    return { reason: "STOP_AND_TP_SAME_CANDLE_STOP_FIRST", rawClose: position.stopPrice };
  }

  if (hitStop) {
    return { reason: "STOP_LOSS", rawClose: position.stopPrice };
  }

  if (hitTake) {
    return { reason: "TAKE_PROFIT", rawClose: position.takeProfit };
  }

  if (entryAgeMinutes >= scenario.maxHoldMinutes) {
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
      entryVwap: position.entryVwap,
      entryAtrPct: position.entryAtrPct,
      entryVolumeSpike: position.entryVolumeSpike,
      stopPrice: position.stopPrice,
      takeProfit: position.takeProfit,
      holdMinutes: round((exit.closeTime - position.entryTime) / 60_000, 1),
    },
  };
}

function detectOrbBreakout({ candle, scenario, openingRange }) {
  if (!passesCandleFilter(candle, scenario)) return null;
  if (!candle.vwap) return null;

  const highTrigger = openingRange.high * (1 + scenario.breakoutBufferPct);
  const lowTrigger = openingRange.low * (1 - scenario.breakoutBufferPct);

  if (
    scenario.allowLong &&
    candle.close > highTrigger &&
    (!scenario.useVwapBias || candle.close > candle.vwap)
  ) {
    return {
      side: "LONG",
      signalType: "ORB_BREAKOUT_LONG",
      rawStop:
        scenario.stopMode === "RANGE_MID" ? openingRange.mid : openingRange.low,
    };
  }

  if (
    scenario.allowShort &&
    candle.close < lowTrigger &&
    (!scenario.useVwapBias || candle.close < candle.vwap)
  ) {
    return {
      side: "SHORT",
      signalType: "ORB_BREAKOUT_SHORT",
      rawStop:
        scenario.stopMode === "RANGE_MID" ? openingRange.mid : openingRange.high,
    };
  }

  return null;
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

function detectVwapReclaim({ state, candle, scenario, openingRange }) {
  if (!passesCandleFilter(candle, scenario)) return null;
  if (!candle.vwap) return null;

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

function updateBreakoutState({ state, candle, scenario, openingRange }) {
  const highTrigger = openingRange.high * (1 + scenario.breakoutBufferPct);
  const lowTrigger = openingRange.low * (1 - scenario.breakoutBufferPct);

  if (!state.breakoutDirection && candle.close > highTrigger && candle.vwap && candle.close > candle.vwap) {
    state.breakoutDirection = "LONG";
    state.breakoutIndex = candle.index;
  }

  if (!state.breakoutDirection && candle.close < lowTrigger && candle.vwap && candle.close < candle.vwap) {
    state.breakoutDirection = "SHORT";
    state.breakoutIndex = candle.index;
  }
}

function detectOrbVwapRetest({ state, candle, scenario, openingRange }) {
  if (!state.breakoutDirection) return null;
  if (!passesCandleFilter(candle, scenario)) return null;
  if (!candle.vwap) return null;

  const candlesSinceBreakout = candle.index - state.breakoutIndex;
  if (candlesSinceBreakout < scenario.minBreakoutCandlesBeforeRetest) return null;

  if (state.breakoutDirection === "LONG" && scenario.allowLong) {
    const retestedRange = candle.low <= openingRange.high * (1 + scenario.retestTolerancePct);
    const retestedVwap = candle.low <= candle.vwap * (1 + scenario.retestTolerancePct);
    const continuationClose = candle.close > openingRange.high && candle.close > candle.vwap && candle.close > candle.open;

    if ((retestedRange || retestedVwap) && continuationClose) {
      return {
        side: "LONG",
        signalType: "ORB_VWAP_RETEST_LONG",
        rawStop: Math.min(openingRange.mid, candle.vwap) * (1 - scenario.retestTolerancePct),
      };
    }
  }

  if (state.breakoutDirection === "SHORT" && scenario.allowShort) {
    const retestedRange = candle.high >= openingRange.low * (1 - scenario.retestTolerancePct);
    const retestedVwap = candle.high >= candle.vwap * (1 - scenario.retestTolerancePct);
    const continuationClose = candle.close < openingRange.low && candle.close < candle.vwap && candle.close < candle.open;

    if ((retestedRange || retestedVwap) && continuationClose) {
      return {
        side: "SHORT",
        signalType: "ORB_VWAP_RETEST_SHORT",
        rawStop: Math.max(openingRange.mid, candle.vwap) * (1 + scenario.retestTolerancePct),
      };
    }
  }

  return null;
}

function detectSignal({ state, candle, scenario, openingRange }) {
  if (scenario.mode === "ORB_BREAKOUT") {
    return detectOrbBreakout({ candle, scenario, openingRange });
  }

  if (scenario.mode === "VWAP_RECLAIM_AFTER_SWEEP") {
    updateSweepState({ state, candle, scenario, openingRange });
    return detectVwapReclaim({ state, candle, scenario, openingRange });
  }

  if (scenario.mode === "ORB_VWAP_RETEST") {
    updateBreakoutState({ state, candle, scenario, openingRange });
    return detectOrbVwapRetest({ state, candle, scenario, openingRange });
  }

  return null;
}

function backtestSymbolScenario({ symbol, scenario, candles }) {
  const prepared = prepareSeries(candles);
  const byDay = groupCandlesByDay(prepared);
  const trades = [];
  let balance = INITIAL_BALANCE;
  let lossCooldownSessions = 0;

  for (const [day, dayCandles] of byDay.entries()) {
    let tradesToday = 0;
    let dailyNetPnl = 0;

    for (const session of scenario.sessions) {
      if (tradesToday >= scenario.maxTradesPerDay) break;
      if (dailyNetPnl <= -scenario.maxDailyLossUSDT) break;
      if (lossCooldownSessions > 0) {
        lossCooldownSessions--;
        continue;
      }

      const openingRange = buildOpeningRange(dayCandles, session);
      if (!openingRange || !passesRangeFilter(openingRange, scenario)) continue;

      const tradeWindowCandles = getTradeWindowCandles(dayCandles, session);
      if (tradeWindowCandles.length < 3) continue;

      const state = {
        sweptLow: false,
        sweptHigh: false,
        sweepLow: null,
        sweepHigh: null,
        breakoutDirection: null,
        breakoutIndex: null,
      };

      let position = null;
      let tradesThisSession = 0;

      for (let i = 0; i < tradeWindowCandles.length; i++) {
        const candle = tradeWindowCandles[i];
        const isLastCandle = i === tradeWindowCandles.length - 1;

        if (position) {
          const exit = getExit({ position, candle, scenario, isLastCandle });
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

            if (closed.trade.netPnl < 0 && scenario.cooldownSessionsAfterLoss > 0) {
              lossCooldownSessions = scenario.cooldownSessionsAfterLoss;
            }

            position = null;
          }

          continue;
        }

        if (tradesThisSession >= scenario.maxTradesPerSession) continue;
        if (tradesToday >= scenario.maxTradesPerDay) continue;
        if (dailyNetPnl <= -scenario.maxDailyLossUSDT) continue;

        const signal = detectSignal({ state, candle, scenario, openingRange });
        if (!signal) continue;

        const newPosition = buildPosition({
          symbol,
          scenario,
          session,
          side: signal.side,
          candle,
          rawEntryPrice: candle.close,
          rawStop: signal.rawStop,
          balance,
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
  const bestSymbol = bySymbol[0];
  const bestSymbolConcentration =
    netPnl > 0 && bestSymbol && bestSymbol.netPnl > 0 ? bestSymbol.netPnl / netPnl : null;

  const candidate =
    totalTrades >= 30 &&
    totalTrades <= 260 &&
    tradesPerDay !== null &&
    tradesPerDay <= 12 &&
    netPnl > 0 &&
    (profitFactor === null || profitFactor >= 1.1) &&
    maxDrawdown <= INITIAL_BALANCE * 0.18 &&
    profitableSymbols >= 2 &&
    (bestSymbolConcentration === null || bestSymbolConcentration <= 0.75);

  return {
    scenarioId: scenario.id,
    description: scenario.description,
    mode: scenario.mode,
    sessions: scenario.sessions.map((session) => session.id),
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
    bestSymbolConcentration: bestSymbolConcentration === null ? null : round(bestSymbolConcentration, 2),
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
      "mode",
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
      "sessions",
    ].join(","),
  ];

  for (const summary of summaries) {
    csvRows.push(
      [
        summary.scenarioId,
        summary.mode,
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
        `"${summary.sessions.join("|")}"`,
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

  console.log(`  best symbols: ${bestSymbols || "n/a"}`);
  console.log(`  worst symbols: ${worstSymbols || "n/a"}`);
  console.log(`  best hours UTC: ${bestHours || "n/a"}`);
  console.log(`  worst hours UTC: ${worstHours || "n/a"}`);
}

export async function runSessionOrbVwapResearch() {
  console.log(`=== ${STRATEGY_NAME} Research ===`);
  console.log("Mode: research / paper only");
  console.log("Safety: no real orders, no OKX API keys, no live trading");
  console.log(`Symbols: ${SYMBOLS.join(", ")}`);
  console.log(`Bar: ${BAR}`);
  console.log(`Target candles per symbol: ${TARGET_CANDLES}`);
  console.log(`Fee rate: ${FEE_RATE} | Slippage: ${SLIPPAGE_PCT}`);
  console.log("Sessions: US open, late US, optional Europe/London retest scenario");

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

    for (const symbol of SYMBOLS) {
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
      philosophy:
        "Session event model: fewer trades, only opening range / VWAP events, no all-day EMA overtrading.",
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
    console.log("Next step: review robustness before any disabled-by-default paper module.");
  }

  return { summaries, rawResults };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSessionOrbVwapResearch().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
