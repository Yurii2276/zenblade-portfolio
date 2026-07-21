/**
 * ZenBlade Macro Gold + DXY Paper Module — Phase 5 draft.
 *
 * Scope:
 * - paper/dry-run only
 * - no real orders
 * - no private API keys
 * - separate paper state; invoked by Railway paper loop
 *
 * Signal:
 * - DXY 2D change <= -0.3%
 * - XAUT 2D change >= +1.0%
 *
 * Candidates:
 * - BTC-USDT conservative
 * - ETH-USDT aggressive
 * - SOL intentionally disabled for first paper module
 */

import fs from "node:fs";
import path from "node:path";
import { config as baseConfig } from "../config.js";
import { fetchHistoricalCandles } from "../okxClient.js";

const STATE_PATH = path.resolve(
  process.env.MACRO_GOLD_DXY_STATE_PATH ?? "data/macro-gold-dxy-paper-state.json"
);
const TRADES_PATH = path.resolve(
  process.env.MACRO_GOLD_DXY_TRADES_PATH ?? "data/macro-gold-dxy-paper-trades.json"
);

const DRY_RUN = process.env.MACRO_GOLD_DXY_DRY_RUN !== "false";
const BAR = process.env.MACRO_GOLD_DXY_BAR ?? "1D";
const TARGET_CANDLES = Number.parseInt(process.env.MACRO_GOLD_DXY_CANDLES ?? "120", 10);

const DXY_SYMBOL = process.env.MACRO_GOLD_DXY_DXY_SYMBOL ?? "DX-Y.NYB";
const GOLD_SYMBOL = process.env.MACRO_GOLD_DXY_GOLD_SYMBOL ?? "XAUT-USDT";

const DXY_MAX_2D_PCT = Number.parseFloat(process.env.MACRO_GOLD_DXY_DXY_MAX_2D_PCT ?? "-0.3");
const XAUT_MIN_2D_PCT = Number.parseFloat(process.env.MACRO_GOLD_DXY_XAUT_MIN_2D_PCT ?? "1.0");
const MAX_ABS_DXY_CHANGE_2D_PCT = Number.parseFloat(process.env.MACRO_GOLD_DXY_MAX_ABS_DXY_CHANGE_2D_PCT ?? "5");

const MAX_DATE_GAP_DAYS = Number.parseFloat(
  process.env.MACRO_GOLD_DXY_MAX_DATE_GAP_DAYS ?? "1"
);

const MAX_DATA_AGE_DAYS = Number.parseFloat(
  process.env.MACRO_GOLD_DXY_MAX_DATA_AGE_DAYS ?? "3"
);

const HOLD_HOURS = Number.parseFloat(process.env.MACRO_GOLD_DXY_HOLD_HOURS ?? "48");
const SIGNAL_TTL_HOURS = Number.parseFloat(process.env.MACRO_GOLD_DXY_SIGNAL_TTL_HOURS ?? "48");

const SYMBOLS = parseCsv(process.env.MACRO_GOLD_DXY_SYMBOLS ?? "BTC-USDT,ETH-USDT");

const DEFAULT_STATE = {
  balance: baseConfig.initialBalance ?? 1000,
  openPositions: [],
  usedSignalKeys: {},
  lastRunAt: null,
};

function parseCsv(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function ensureDataDir() {
  fs.mkdirSync("data", { recursive: true });
}

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return structuredClone(fallback);
  }
}

function saveJson(filePath, data) {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function loadState() {
  ensureDataDir();
  const state = loadJson(STATE_PATH, DEFAULT_STATE);

  return {
    ...DEFAULT_STATE,
    ...state,
    openPositions: Array.isArray(state.openPositions) ? state.openPositions : [],
    usedSignalKeys: state.usedSignalKeys ?? {},
    lastRunAt: state.lastRunAt ?? null,
  };
}

function loadTrades() {
  ensureDataDir();
  return loadJson(TRADES_PATH, []);
}

function saveAll(state, trades) {
  if (DRY_RUN) {
    console.log("DRY_RUN | state/trades not saved");
    return;
  }

  saveJson(STATE_PATH, state);
  saveJson(TRADES_PATH, trades);
}

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function roundPrice(value) {
  if (!Number.isFinite(value)) return 0;
  if (value >= 100) return round(value, 2);
  if (value >= 1) return round(value, 4);
  if (value >= 0.01) return round(value, 6);
  return round(value, 8);
}

function dateKeyFromTime(time) {
  return new Date(time).toISOString().slice(0, 10);
}

function dateToUtcMs(date) {
  if (!date) return null;

  const parsed = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateGapDays(firstDate, secondDate) {
  const first = dateToUtcMs(firstDate);
  const second = dateToUtcMs(secondDate);

  if (!Number.isFinite(first) || !Number.isFinite(second)) {
    return null;
  }

  return Math.abs(first - second) / (24 * 60 * 60 * 1000);
}

function dateAgeDays(date) {
  const time = dateToUtcMs(date);

  if (!Number.isFinite(time)) {
    return null;
  }

  return Math.max(0, (Date.now() - time) / (24 * 60 * 60 * 1000));
}

function pctChangeFromLast(candles, lookbackDays = 2) {
  if (!Array.isArray(candles) || candles.length <= lookbackDays) return null;

  const current = candles.at(-1)?.close;
  const previous = candles.at(-1 - lookbackDays)?.close;

  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) {
    return null;
  }

  return ((current - previous) / previous) * 100;
}

function hoursSince(isoDate) {
  if (!isoDate) return Infinity;
  const time = Date.parse(isoDate);
  if (!Number.isFinite(time)) return Infinity;
  return (Date.now() - time) / (60 * 60 * 1000);
}

function hasOpenPosition(state, symbol) {
  return state.openPositions.some(
    (position) =>
      position.status === "OPEN" &&
      position.strategyId === "macroGoldDxy" &&
      position.symbol === symbol
  );
}

function signalKey(symbol, signalDate) {
  return `macroGoldDxy:${symbol}:${signalDate}`;
}

async function loadYahooDailyCandles(label, symbol) {
  const range = process.env.MACRO_GOLD_DXY_YAHOO_RANGE ?? "6mo";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;

  console.log(`LOAD | Yahoo ${label} ${symbol}`);

  const response = await fetch(url, {
    headers: { "user-agent": "ZenBladeResearch/1.0" },
  });

  if (!response.ok) {
    throw new Error(`Yahoo ${label} HTTP ${response.status}`);
  }

  const json = await response.json();
  const result = json?.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];

  if (!result?.timestamp?.length || !quote) {
    throw new Error(`Yahoo ${label} returned no quote data`);
  }

  return result.timestamp
    .map((seconds, index) => {
      const close = Number(quote.close?.[index]);

      // Yahoo can return zero-close placeholders. Never use them.
      if (!Number.isFinite(close) || close <= 0) return null;

      const open = Number(quote.open?.[index]);
      const high = Number(quote.high?.[index]);
      const low = Number(quote.low?.[index]);
      const volume = Number(quote.volume?.[index] ?? 0);

      return {
        time: seconds * 1000,
        date: new Date(seconds * 1000).toISOString().slice(0, 10),
        open: Number.isFinite(open) && open > 0 ? open : close,
        high: Number.isFinite(high) && high > 0 ? high : close,
        low: Number.isFinite(low) && low > 0 ? low : close,
        close,
        volume: Number.isFinite(volume) ? volume : 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);
}

async function loadOkxDailyCandles(symbol, targetLimit = TARGET_CANDLES) {
  console.log(`LOAD | OKX ${symbol} ${BAR}`);

  const candles = await fetchHistoricalCandles({
    symbol,
    bar: BAR,
    targetLimit,
  });

  return candles
    .filter((candle) => Number.isFinite(candle.close) && candle.close > 0)
    .sort((a, b) => a.time - b.time);
}

async function buildMacroSignal() {
  const dxyCandles = await loadYahooDailyCandles("dxy", DXY_SYMBOL);
  const xautCandles = await loadOkxDailyCandles(GOLD_SYMBOL);

  const dxyChange2dPct = pctChangeFromLast(dxyCandles, 2);
  const xautChange2dPct = pctChangeFromLast(xautCandles, 2);

  const dxyLast = dxyCandles.at(-1);
  const xautLast = xautCandles.at(-1);

  const dxyDate = dxyLast?.date ?? (dxyLast?.time ? dateKeyFromTime(dxyLast.time) : null);
  const xautDate = xautLast?.date ?? (xautLast?.time ? dateKeyFromTime(xautLast.time) : null);

  const dateGap = dateGapDays(dxyDate, xautDate);
  const dxyAgeDays = dateAgeDays(dxyDate);
  const xautAgeDays = dateAgeDays(xautDate);

  const dataDatesInvalid =
    !dxyDate ||
    !xautDate ||
    !Number.isFinite(dateGap) ||
    dateGap > MAX_DATE_GAP_DAYS ||
    !Number.isFinite(dxyAgeDays) ||
    !Number.isFinite(xautAgeDays) ||
    dxyAgeDays > MAX_DATA_AGE_DAYS ||
    xautAgeDays > MAX_DATA_AGE_DAYS;

  const reasons = [];

  if (dataDatesInvalid) {
    reasons.push("STALE_OR_MISALIGNED_DATA");
  }

  if (!Number.isFinite(dxyChange2dPct)) {
    reasons.push("DXY_CHANGE_UNAVAILABLE");
  }

  if (!Number.isFinite(xautChange2dPct)) {
    reasons.push("XAUT_CHANGE_UNAVAILABLE");
  }

  if (Number.isFinite(dxyChange2dPct) && Math.abs(dxyChange2dPct) > MAX_ABS_DXY_CHANGE_2D_PCT) {
    reasons.push(`DXY_ABNORMAL_CHANGE_${round(dxyChange2dPct)}%`);
  }

  if (Number.isFinite(dxyChange2dPct) && dxyChange2dPct > DXY_MAX_2D_PCT) {
    reasons.push(`DXY_NOT_DOWN_ENOUGH_${round(dxyChange2dPct)}%`);
  }

  if (Number.isFinite(xautChange2dPct) && xautChange2dPct < XAUT_MIN_2D_PCT) {
    reasons.push(`XAUT_NOT_UP_ENOUGH_${round(xautChange2dPct)}%`);
  }

  const pass = reasons.length === 0;

  return {
    action: pass ? "BUY_SIGNAL" : "SKIP",
    signalDate: xautDate ?? dxyDate ?? new Date().toISOString().slice(0, 10),
    dxyDate,
    xautDate,
    dxyClose: dxyLast?.close ?? null,
    xautClose: xautLast?.close ?? null,
    dxyChange2dPct: round(dxyChange2dPct),
    xautChange2dPct: round(xautChange2dPct),
    dateGapDays: round(dateGap, 2),
    dxyAgeDays: round(dxyAgeDays, 2),
    xautAgeDays: round(xautAgeDays, 2),
    thresholds: {
      dxyMax2dPct: DXY_MAX_2D_PCT,
      xautMin2dPct: XAUT_MIN_2D_PCT,
      maxAbsDxyChange2dPct: MAX_ABS_DXY_CHANGE_2D_PCT,
      maxDateGapDays: MAX_DATE_GAP_DAYS,
      maxDataAgeDays: MAX_DATA_AGE_DAYS,
    },
    reason: pass
      ? `PASS | DXY ${round(dxyChange2dPct)}% <= ${DXY_MAX_2D_PCT}% and XAUT ${round(xautChange2dPct)}% >= ${XAUT_MIN_2D_PCT}%`
      : `SKIP | ${reasons.join(" | ")}`,
  };
}

function planPaperPosition({ symbol, candles, macroSignal, state }) {
  const lastCandle = candles.at(-1);
  if (!lastCandle) return null;

  const entryPrice = roundPrice(lastCandle.close);
  const feeRate = baseConfig.feeRate ?? 0.0008;

  // Conservative sizing for first dry-run module.
  const riskPerTrade = Number.parseFloat(process.env.MACRO_GOLD_DXY_RISK_PER_TRADE ?? "0.005");
  const maxPositionValuePct = Number.parseFloat(process.env.MACRO_GOLD_DXY_MAX_POSITION_VALUE_PCT ?? "0.15");

  const positionValue = round((state.balance ?? 1000) * maxPositionValuePct, 4);
  const size = round(positionValue / entryPrice, 6);

  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(positionValue) || positionValue <= 0) {
    return null;
  }

  return {
    id: `macroGoldDxy:${symbol}:${Date.now()}`,
    strategyId: "macroGoldDxy",
    strategyName: "Macro Gold DXY Paper Module",
    symbol,
    side: "LONG",
    status: "OPEN",
    mode: DRY_RUN ? "dry-run" : "paper",
    entryPrice,
    size,
    positionValue,
    feeRate,
    riskPerTrade,
    maxPositionValuePct,
    openedAt: new Date().toISOString(),
    openedCandleTime: lastCandle.time,
    openedCandleDate: dateKeyFromTime(lastCandle.time),
    maxHoldHours: HOLD_HOURS,
    signalTtlHours: SIGNAL_TTL_HOURS,
    macroSignal,
    signalReason: macroSignal.reason,
    plannedExit: "MAX_HOLD_48H",
  };
}

function shouldClosePosition(position, candle) {
  const age = hoursSince(position.openedAt);

  if (age >= HOLD_HOURS) {
    return {
      reason: "MAX_HOLD_48H",
      exitPrice: roundPrice(candle.close),
    };
  }

  return null;
}

function closePosition({ position, exitPrice, reason, balance }) {
  const grossPnl = (exitPrice - position.entryPrice) * position.size;
  const fees = (position.entryPrice + exitPrice) * position.size * position.feeRate;
  const netPnl = round(grossPnl - fees);
  const nextBalance = round((balance ?? 1000) + netPnl);

  return {
    nextBalance,
    trade: {
      ...position,
      status: "CLOSED",
      exitPrice,
      exitRule: reason,
      closedAt: new Date().toISOString(),
      grossPnl: round(grossPnl),
      fees: round(fees),
      netPnl,
      balanceAfterClose: nextBalance,
    },
  };
}

async function monitorOpenPositions(state, trades) {
  const remaining = [];

  for (const position of state.openPositions) {
    const candles = await loadOkxDailyCandles(position.symbol, 5);
    const lastCandle = candles.at(-1);

    if (!lastCandle) {
      console.log(`HOLD | ${position.symbol} | no latest candle`);
      remaining.push(position);
      continue;
    }

    const closeDecision = shouldClosePosition(position, lastCandle);

    if (!closeDecision) {
      console.log(
        `HOLD | ${position.symbol} | age ${round(hoursSince(position.openedAt), 1)}h | entry ${position.entryPrice} | last ${lastCandle.close}`
      );
      remaining.push(position);
      continue;
    }

    const closed = closePosition({
      position,
      exitPrice: closeDecision.exitPrice,
      reason: closeDecision.reason,
      balance: state.balance,
    });

    state.balance = closed.nextBalance;
    trades.push(closed.trade);

    console.log(
      `EXIT | ${position.symbol} | ${closeDecision.reason} | exit ${closed.trade.exitPrice} | netPnL ${closed.trade.netPnl}`
    );
  }

  state.openPositions = remaining;
}

async function evaluateSymbol({ symbol, macroSignal, state }) {
  if (hasOpenPosition(state, symbol)) {
    console.log(`SKIP | ${symbol} | position already OPEN`);
    return;
  }

  const key = signalKey(symbol, macroSignal.signalDate);

  if (state.usedSignalKeys[key]) {
    const age = hoursSince(state.usedSignalKeys[key]);

    if (age <= SIGNAL_TTL_HOURS) {
      console.log(`SKIP | ${symbol} | signal already used within TTL | age ${round(age, 1)}h`);
      return;
    }
  }

  if (macroSignal.action !== "BUY_SIGNAL") {
    console.log(`SKIP | ${symbol} | ${macroSignal.reason}`);
    return;
  }

  const candles = await loadOkxDailyCandles(symbol, 20);
  const position = planPaperPosition({
    symbol,
    candles,
    macroSignal,
    state,
  });

  if (!position) {
    console.log(`SKIP | ${symbol} | position plan failed`);
    return;
  }

  console.log(
    `${DRY_RUN ? "DRY_RUN_BUY" : "BUY"} | ${symbol} | entry ${position.entryPrice} | value ${position.positionValue} | reason ${position.signalReason}`
  );

  if (!DRY_RUN) {
    state.openPositions.push(position);
    state.usedSignalKeys[key] = new Date().toISOString();
  }
}

export async function runMacroGoldDxyPaperModuleOnce() {
  if (baseConfig.paperOnly !== true) {
    throw new Error("Safety stop: baseConfig.paperOnly must be true");
  }

  const state = loadState();
  const trades = loadTrades();

  console.log("=== ZenBlade Macro Gold DXY Paper Module ===");
  console.log(`Mode: ${DRY_RUN ? "dry-run only — no state changes" : "paper only — separate state file"}`);
  console.log("No real trading. No private API keys. Separate paper state; invoked by Railway loop.");
  console.log(`Symbols: ${SYMBOLS.join(", ")}`);
  console.log(`Balance: ${state.balance} USDT`);
  console.log(`Open positions: ${state.openPositions.length}`);
  console.log("");

  await monitorOpenPositions(state, trades);

  const macroSignal = await buildMacroSignal();

  console.log("");
  console.log("Macro signal:");
  console.log(`- action: ${macroSignal.action}`);
  console.log(`- reason: ${macroSignal.reason}`);
  console.log(`- DXY date: ${macroSignal.dxyDate}, 2D: ${macroSignal.dxyChange2dPct}%`);
  console.log(`- XAUT date: ${macroSignal.xautDate}, 2D: ${macroSignal.xautChange2dPct}%`);
  console.log("");

  for (const symbol of SYMBOLS) {
    await evaluateSymbol({
      symbol,
      macroSignal,
      state,
    });
  }

  state.lastRunAt = new Date().toISOString();
  saveAll(state, trades);

  console.log("");
  console.log("Done.");
  console.log(`Mode: ${DRY_RUN ? "dry-run" : "paper"}`);
  console.log(`Balance: ${state.balance} USDT`);
  console.log(`Open positions: ${state.openPositions.length}`);
  console.log(`Closed trades: ${trades.length}`);
}

const isDirectRun =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  runMacroGoldDxyPaperModuleOnce().catch((error) => {
    console.error("Macro Gold DXY paper module failed:", error);
    process.exitCode = 1;
  });
}
