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

  let reason;
  if (ema20 > ema50) {
    reason = "Дані отримано: коротка EMA вище довгої, тренд потенційно висхідний";
  } else if (ema20 < ema50) {
    reason = "Дані отримано: коротка EMA нижче довгої, тренд потенційно слабкий";
  } else {
    reason = "Дані отримано, ринок без явної переваги";
  }

  return {
    action: "HOLD",
    reason,
    indicators: {
      lastClose,
      ema20,
      ema50,
      rsi14,
      atr14,
      lastVolume,
      volumeSma20,
    },
  };
}
