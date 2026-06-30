import { ema, rsi, atr, volumeSma } from "./indicators.js";

export function getSignal({ candles, config }) {
  if (!candles || candles.length < 60) {
    return {
      action: "HOLD",
      reason: "Недостатньо свічок для індикаторів",
      indicators: null,
    };
  }

  const closes = candles.map((c) => c.close);

  const ema20 = ema(closes, config.emaFast);
  const ema50 = ema(closes, config.emaSlow);
  const rsi14 = rsi(closes, config.rsiPeriod);
  const atr14 = atr(candles, config.atrPeriod);
  const volumeSma20 = volumeSma(candles, config.volumePeriod);
  const lastClose = candles[0].close;
  const lastVolume = candles[0].volume;

  const indicators = {
    lastClose,
    ema20,
    ema50,
    rsi14,
    atr14,
    lastVolume,
    volumeSma20,
  };

  const allConditions =
    ema20 > ema50 &&
    lastClose > ema20 &&
    rsi14 >= config.minRsiForLong &&
    rsi14 <= config.maxRsiForLong &&
    lastVolume >= volumeSma20 * config.minVolumeFactor &&
    atr14 !== null &&
    atr14 > 0;

  if (allConditions) {
    return {
      action: "BUY",
      reason: "EMA20 вище EMA50, ціна вище EMA20, RSI у робочій зоні, обʼєм підтверджує рух",
      indicators,
    };
  }

  let reason;
  if (ema20 <= ema50) {
    reason = "Немає long-тренду: EMA20 нижче або дорівнює EMA50";
  } else if (lastClose <= ema20) {
    reason = "Ціна нижче EMA20, імпульс недостатній";
  } else if (rsi14 < config.minRsiForLong) {
    reason = "RSI занизький для входу";
  } else if (rsi14 > config.maxRsiForLong) {
    reason = "RSI зависокий, вхід ризикований";
  } else if (lastVolume < volumeSma20 * config.minVolumeFactor) {
    reason = "Обʼєм не підтверджує рух";
  } else {
    reason = "Умови для входу не виконані";
  }

  return {
    action: "HOLD",
    reason,
    indicators,
  };
}
