import { getSignal } from "../strategy.js";
import { calculateLongTrade } from "../riskManager.js";
import { summarizeTradeRegimes } from "../intelligence/regimeDetector.js";

const DEFAULT_INITIAL_BALANCE = 1000;

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function validateCandles(candles) {
  if (!Array.isArray(candles) || candles.length < 100) {
    return { ok: false, reason: "not_enough_candles" };
  }

  let previousTime = -Infinity;
  for (const candle of candles) {
    const values = [candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume];
    if (values.some((value) => !Number.isFinite(Number(value)))) {
      return { ok: false, reason: "non_finite_candle_value" };
    }
    if (candle.time <= previousTime) return { ok: false, reason: "candles_not_strictly_sorted" };
    if (candle.high < candle.low || candle.open <= 0 || candle.close <= 0) {
      return { ok: false, reason: "invalid_ohlc" };
    }
    previousTime = candle.time;
  }

  return { ok: true };
}

function maxDrawdownPct(equity) {
  let peak = equity[0] ?? DEFAULT_INITIAL_BALANCE;
  let maxPct = 0;
  for (const value of equity) {
    if (value > peak) peak = value;
    if (peak <= 0) continue;
    maxPct = Math.max(maxPct, ((peak - value) / peak) * 100);
  }
  return round(maxPct, 3);
}

function closeLong({ position, closePrice, closeReason, balance, feeRate }) {
  const grossPnl = (closePrice - position.entryPrice) * position.size;
  const fees = (position.entryPrice + closePrice) * position.size * feeRate;
  const netPnl = grossPnl - fees;
  return {
    balance: balance + netPnl,
    trade: {
      entryTime: position.entryTime,
      exitTime: position.exitTime,
      entryPrice: position.entryPrice,
      closePrice,
      closeReason,
      size: position.size,
      grossPnl: round(grossPnl),
      fees: round(fees),
      netPnl: round(netPnl),
    },
  };
}

export function runLongBacktest({
  candles,
  htfCandles = null,
  testConfig,
  initialBalance = DEFAULT_INITIAL_BALANCE,
  allowEntriesFromIndex = 60,
}) {
  const quality = validateCandles(candles);
  if (!quality.ok) throw new Error(`Bad candles: ${quality.reason}`);

  let balance = initialBalance;
  let openPosition = null;
  const trades = [];
  const equity = [initialBalance];

  for (let i = 60; i < candles.length; i += 1) {
    const currentCandle = candles[i];

    if (openPosition) {
      openPosition.exitTime = currentCandle.time;
      const hitStop = currentCandle.low <= openPosition.stopPrice;
      const hitTake = currentCandle.high >= openPosition.takePrice;

      if (hitStop || hitTake) {
        // Conservative assumption: if both are touched in one candle, stop wins.
        const closePrice = hitStop ? openPosition.stopPrice : openPosition.takePrice;
        const closed = closeLong({
          position: openPosition,
          closePrice,
          closeReason: hitStop ? "STOP_LOSS" : "TAKE_PROFIT",
          balance,
          feeRate: testConfig.feeRate,
        });
        balance = closed.balance;
        trades.push(closed.trade);
        equity.push(balance);
        openPosition = null;
      }
      continue;
    }

    if (i < allowEntriesFromIndex) continue;

    const historicalCandles = candles.slice(0, i + 1);
    const htfSlice = htfCandles?.filter((candle) => candle.time <= currentCandle.time) ?? null;
    const signal = getSignal({ candles: historicalCandles, config: testConfig, htfCandles: htfSlice });

    if (signal.action !== "BUY" || !signal.indicators) continue;

    const trade = calculateLongTrade({
      balance,
      entryPrice: signal.indicators.lastClose,
      atr: signal.indicators.atr14,
      config: testConfig,
    });

    if (!Number.isFinite(trade.size) || trade.size <= 0 || trade.positionValue <= 0) continue;

    openPosition = {
      entryTime: currentCandle.time,
      exitTime: currentCandle.time,
      entryPrice: trade.entryPrice,
      stopPrice: trade.stopPrice,
      takePrice: trade.takePrice,
      size: trade.size,
    };
  }

  if (openPosition) {
    const last = candles.at(-1);
    openPosition.exitTime = last.time;
    const closed = closeLong({
      position: openPosition,
      closePrice: last.close,
      closeReason: "END_OF_TEST",
      balance,
      feeRate: testConfig.feeRate,
    });
    balance = closed.balance;
    trades.push(closed.trade);
    equity.push(balance);
  }

  const wins = trades.filter((trade) => trade.netPnl > 0);
  const losses = trades.filter((trade) => trade.netPnl < 0);
  const grossWins = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLosses = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnl, 0));
  const totalFees = trades.reduce((sum, trade) => sum + trade.fees, 0);
  const netPnl = balance - initialBalance;
  const regimeSummary = summarizeTradeRegimes(candles, trades);

  return {
    trades,
    metrics: {
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRatePct: trades.length ? round((wins.length / trades.length) * 100, 2) : 0,
      netPnlUSDT: round(netPnl, 2),
      returnPct: round((netPnl / initialBalance) * 100, 3),
      profitFactor: grossLosses > 0 ? round(grossWins / grossLosses, 3) : (grossWins > 0 ? 99 : 0),
      maxDrawdownPct: maxDrawdownPct(equity),
      expectancyUSDT: trades.length ? round(netPnl / trades.length, 4) : 0,
      totalFeesUSDT: round(totalFees, 2),
      finalBalanceUSDT: round(balance, 2),
      regimeSummary,
    },
  };
}
