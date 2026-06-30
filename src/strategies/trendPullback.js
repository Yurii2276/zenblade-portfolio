import { ema, rsi, atr, volumeSma } from "../indicators.js";

export function getTrendPullbackSignal({ candles, config, htfCandles = null }) {
  if (!candles || candles.length < 60) {
    return {
      action: "HOLD",
      reason: "Недостатньо свічок для індикаторів",
      indicators: null,
    };
  }

  const closes = candles.map((c) => c.close);
  const lastCandle = candles[candles.length - 1];
  const previousCandle = candles[candles.length - 2];
  const lastClose = lastCandle.close;
  const lastOpen = lastCandle.open;
  const previousClose = previousCandle.close;
  const lastVolume = lastCandle.volume;

  const emaFastVal = ema(closes, config.emaFast);
  const emaSlowVal = ema(closes, config.emaSlow);
  const rsi14 = rsi(closes, config.rsiPeriod);
  const atr14 = atr(candles, config.atrPeriod);
  const volumeSma20 = volumeSma(candles, config.volumePeriod);

  const pullbackLookback = config.pullbackLookback || 8;
  const pullbackTolerancePct = config.pullbackTolerancePct ?? 0.002;
  const recentCandles = candles.slice(-pullbackLookback);
  const pullbackDetected = recentCandles.some(
    (candle) => candle.low <= emaFastVal * (1 + pullbackTolerancePct)
  );
  const bullishConfirmation =
    lastClose > lastOpen &&
    lastClose > previousClose;

  const indicators = {
    lastClose,
    lastOpen,
    previousClose,
    emaFast: emaFastVal,
    emaSlow: emaSlowVal,
    // Keep legacy names for compatibility with existing paper-mode output.
    ema20: emaFastVal,
    ema50: emaSlowVal,
    rsi14,
    atr14,
    lastVolume,
    volumeSma20,
    htfLastClose: null,
    htfEmaFast: null,
    htfEmaSlow: null,
    htfTrendOk: config.useHtfFilter === true ? false : null,
    pullbackDetected,
    bullishConfirmation,
  };

  if (config.useHtfFilter === true) {
    const minimumHtfCandles = config.htfEmaSlow + 5;
    if (!htfCandles || htfCandles.length < minimumHtfCandles) {
      return {
        action: "HOLD",
        reason: "Недостатньо HTF-свічок для підтвердження тренду",
        indicators,
      };
    }

    const htfCloses = htfCandles.map((c) => c.close);
    const htfLastClose = htfCloses[htfCloses.length - 1];
    const htfEmaFast = ema(htfCloses, config.htfEmaFast);
    const htfEmaSlow = ema(htfCloses, config.htfEmaSlow);
    const htfTrendOk =
      htfEmaFast > htfEmaSlow &&
      htfLastClose > htfEmaFast;

    Object.assign(indicators, {
      htfLastClose,
      htfEmaFast,
      htfEmaSlow,
      htfTrendOk,
    });

    if (!htfTrendOk) {
      return {
        action: "HOLD",
        reason: "HTF-фільтр не підтверджує long-тренд",
        indicators,
      };
    }
  }

  const volumeTooHigh =
    config.maxVolumeFactor != null &&
    lastVolume > volumeSma20 * config.maxVolumeFactor;

  if (volumeTooHigh) {
    return {
      action: "HOLD",
      reason: "Volume spike too high, possible exhaustion",
      indicators,
    };
  }

  const trend5mOk =
    emaFastVal > emaSlowVal &&
    lastClose > emaFastVal &&
    atr14 !== null &&
    atr14 > 0;
  const rsiOk =
    rsi14 >= config.minRsiForLong &&
    rsi14 <= config.maxRsiForLong;
  const volumeOk =
    lastVolume >= volumeSma20 * config.minVolumeFactor;

  if (
    trend5mOk &&
    rsiOk &&
    pullbackDetected &&
    bullishConfirmation &&
    volumeOk
  ) {
    return {
      action: "BUY",
      reason: "Trend pullback: HTF long, 5m trend long, pullback to EMA, bullish confirmation, volume confirmed",
      indicators,
    };
  }

  let reason;
  if (!trend5mOk) {
    reason = "Немає 5m long-тренду";
  } else if (!rsiOk) {
    reason = "RSI поза зоною";
  } else if (!pullbackDetected) {
    reason = "Не було pullback до EMA";
  } else if (!bullishConfirmation) {
    reason = "Немає bullish confirmation";
  } else if (!volumeOk) {
    reason = "Обʼєм не підтверджує";
  } else {
    reason = "Умови trend pullback не виконані";
  }

  return {
    action: "HOLD",
    reason,
    indicators,
  };
}
