import { ema, rsi, atr, volumeSma } from "./indicators.js";

export function getSignal({ candles, config }) {
  if (!candles || candles.length < 60) {
    return {
      action: "HOLD",
      reason: "Недостатньо свічок для індикаторів",
      indicators: null,
    };
  }

  const closes     = candles.map((c) => c.close);
  const lastCandle = candles[candles.length - 1];
  const lastClose  = lastCandle.close;
  const lastVolume = lastCandle.volume;

  const emaFastVal   = ema(closes, config.emaFast);
  const emaSlowVal   = ema(closes, config.emaSlow);
  const rsi14        = rsi(closes, config.rsiPeriod);
  const atr14        = atr(candles, config.atrPeriod);
  const volumeSma20  = volumeSma(candles, config.volumePeriod);

  const indicators = {
    lastClose,
    emaFast:    emaFastVal,
    emaSlow:    emaSlowVal,
    // keep legacy names for backward compatibility with paperEngine, stats, etc.
    ema20:      emaFastVal,
    ema50:      emaSlowVal,
    rsi14,
    atr14,
    lastVolume,
    volumeSma20,
  };

  const allConditions =
    emaFastVal > emaSlowVal &&
    lastClose  > emaFastVal &&
    rsi14 >= config.minRsiForLong &&
    rsi14 <= config.maxRsiForLong &&
    lastVolume >= volumeSma20 * config.minVolumeFactor &&
    atr14 !== null &&
    atr14 > 0;

  if (allConditions) {
    return {
      action: "BUY",
      reason: `EMA fast вище EMA slow, ціна вище EMA fast, RSI у робочій зоні, обʼєм підтверджує рух`,
      indicators,
    };
  }

  let reason;
  if (emaFastVal <= emaSlowVal) {
    reason = "Немає long-тренду: EMA fast нижче або дорівнює EMA slow";
  } else if (lastClose <= emaFastVal) {
    reason = "Ціна нижче EMA fast, імпульс недостатній";
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
