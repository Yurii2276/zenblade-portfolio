import { ema, rsi, atr, volumeSma } from "../indicators.js";

function getCandleTime(candle) {
  return candle?.time ?? candle?.timestamp ?? candle?.ts ?? null;
}

function maxHigh(candles) {
  return candles.reduce((max, candle) => Math.max(max, candle.high), -Infinity);
}

function findBreakoutRetest({ candles, config }) {
  const breakoutLookback = config.breakoutLookback || 30;
  const breakoutRecentLookback = config.breakoutRecentLookback || 10;
  const breakoutBufferPct = config.breakoutBufferPct ?? 0.001;
  const retestTolerancePct = config.retestTolerancePct ?? 0.0025;

  const lastIndex = candles.length - 1;
  const startIndex = Math.max(
    breakoutLookback,
    lastIndex - breakoutRecentLookback
  );

  for (let i = startIndex; i <= lastIndex - 1; i++) {
    const priorRange = candles.slice(i - breakoutLookback, i);
    const breakoutLevel = maxHigh(priorRange);
    const breakoutCandle = candles[i];

    const breakoutDetected =
      breakoutLevel > 0 &&
      breakoutCandle.close > breakoutLevel * (1 + breakoutBufferPct);

    if (!breakoutDetected) continue;

    const candlesAfterBreakout = candles.slice(i + 1);
    const retestCandle = candlesAfterBreakout.find((candle) => {
      const touchedLevel =
        candle.low <= breakoutLevel * (1 + retestTolerancePct);
      const heldLevel =
        candle.close >= breakoutLevel * (1 - retestTolerancePct);

      return touchedLevel && heldLevel;
    });

    if (!retestCandle) continue;

    return {
      breakoutDetected: true,
      retestDetected: true,
      breakoutLevel,
      breakoutTime: getCandleTime(breakoutCandle),
      retestTime: getCandleTime(retestCandle),
    };
  }

  return {
    breakoutDetected: false,
    retestDetected: false,
    breakoutLevel: null,
    breakoutTime: null,
    retestTime: null,
  };
}

export function getBreakoutRetestSignal({ candles, config, htfCandles = null }) {
  const breakoutLookback = config.breakoutLookback || 30;
  const breakoutRecentLookback = config.breakoutRecentLookback || 10;
  const minimumCandles = Math.max(
    config.emaSlow + 5,
    config.volumePeriod + 5,
    config.atrPeriod + 5,
    breakoutLookback + breakoutRecentLookback + 5,
    80
  );

  if (!candles || candles.length < minimumCandles) {
    return {
      action: "HOLD",
      reason: "Недостатньо свічок для breakout retest",
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

  const breakoutState = findBreakoutRetest({ candles, config });

  const bullishConfirmation =
    lastClose > lastOpen &&
    lastClose > previousClose &&
    breakoutState.breakoutLevel != null &&
    lastClose > breakoutState.breakoutLevel;

  const indicators = {
    lastClose,
    lastOpen,
    previousClose,
    emaFast: emaFastVal,
    emaSlow: emaSlowVal,
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
    breakoutDetected: breakoutState.breakoutDetected,
    retestDetected: breakoutState.retestDetected,
    breakoutLevel: breakoutState.breakoutLevel,
    breakoutTime: breakoutState.breakoutTime,
    retestTime: breakoutState.retestTime,
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
    volumeSma20 != null &&
    lastVolume > volumeSma20 * config.maxVolumeFactor;

  if (volumeTooHigh) {
    return {
      action: "HOLD",
      reason: "Volume spike too high, possible exhaustion",
      indicators,
    };
  }

  const trend5mOk =
    emaFastVal != null &&
    emaSlowVal != null &&
    emaFastVal > emaSlowVal &&
    lastClose > emaFastVal &&
    atr14 !== null &&
    atr14 > 0;

  const rsiOk =
    rsi14 != null &&
    rsi14 >= config.minRsiForLong &&
    rsi14 <= config.maxRsiForLong;

  const volumeOk =
    volumeSma20 != null &&
    lastVolume >= volumeSma20 * config.minVolumeFactor;

  if (
    trend5mOk &&
    rsiOk &&
    volumeOk &&
    breakoutState.breakoutDetected &&
    breakoutState.retestDetected &&
    bullishConfirmation
  ) {
    return {
      action: "BUY",
      reason: "Breakout retest: HTF long, 5m trend long, breakout, retest held, bullish confirmation, volume confirmed",
      indicators,
    };
  }

  let reason;

  if (!trend5mOk) {
    reason = "Немає 5m long-тренду";
  } else if (!rsiOk) {
    reason = "RSI поза зоною";
  } else if (!volumeOk) {
    reason = "Обʼєм не підтверджує";
  } else if (!breakoutState.breakoutDetected) {
    reason = "Немає підтвердженого breakout";
  } else if (!breakoutState.retestDetected) {
    reason = "Немає retest після breakout";
  } else if (!bullishConfirmation) {
    reason = "Немає bullish confirmation після retest";
  } else {
    reason = "Умови breakout retest не виконані";
  }

  return {
    action: "HOLD",
    reason,
    indicators,
  };
}
