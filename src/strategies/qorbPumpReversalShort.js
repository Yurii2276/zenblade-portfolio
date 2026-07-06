/**
 * QORB Pump Reversal Short strategy.
 * Research/backtest only — no real trading.
 *
 * Adapted from the original QORB pump reversal paper bot:
 * - scans historical candles for pump events;
 * - measures pump strength and event-candle volume spike;
 * - waits for event maturity / exhaustion;
 * - returns SELL_SHORT only for research.
 */

import { atr as calcAtr } from "../indicators.js";

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function pctChange(from, to) {
  if (!from || from === 0) return 0;
  return ((to - from) / from) * 100;
}

function avg(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function avgVolumeUSDT(candles, startIndex, length) {
  const values = [];

  for (let i = startIndex; i < startIndex + length; i++) {
    const candle = candles[i];
    if (!candle) continue;
    values.push(candle.close * candle.volume);
  }

  return avg(values);
}

function upperWickPct(candle) {
  const range = candle.high - candle.low;
  if (range <= 0) return 0;

  const wick = candle.high - Math.max(candle.open, candle.close);
  return (wick / range) * 100;
}

function scoreSignal(event, ageHours, changeSinceEventPct) {
  let score = 0;

  if (event.pump24h >= 100) score += 40;
  else if (event.pump24h >= 80) score += 35;
  else if (event.pump24h >= 50) score += 30;
  else if (event.pump24h >= 30) score += 18;

  if (event.volumeSpike >= 50) score += 30;
  else if (event.volumeSpike >= 20) score += 25;
  else if (event.volumeSpike >= 10) score += 18;
  else if (event.volumeSpike >= 5) score += 10;
  else if (event.volumeSpike >= 3) score += 5;

  if (ageHours >= 12 && ageHours <= 18) score += 25;
  else if (ageHours > 18 && ageHours <= 24) score += 15;
  else if (ageHours < 12) score += 5;
  else if (ageHours > 24 && ageHours <= 72) score += 7;

  if (changeSinceEventPct <= 0 && changeSinceEventPct >= -20) score += 20;
  else if (changeSinceEventPct > 0 && changeSinceEventPct <= 5) score += 8;
  else if (changeSinceEventPct < -20) score -= 10;
  else if (changeSinceEventPct > 10) score -= 15;

  if (event.upperWickPct >= 50) score += 5;
  else if (event.upperWickPct >= 30) score += 3;

  return Math.max(0, Math.min(100, round(score)));
}

function defineStrategy(event, config) {
  const minPump = config.qorbMinPumpWeak ?? 30;
  const minSpike = config.qorbMinVolumeSpike ?? 3;

  if (event.pump24h >= minPump * 2 && event.volumeSpike >= minSpike * 4) {
    return "STRONG";
  }

  if (event.pump24h >= minPump * 1.5 && event.volumeSpike >= minSpike * 2) {
    return "GOOD";
  }

  if (event.pump24h >= minPump && event.volumeSpike >= minSpike) {
    return "MEDIUM";
  }

  return "WATCH_ONLY";
}

function defineStatus(event, ageHours, changeSinceEventPct, config) {
  const minPump = config.qorbMinPumpWeak ?? 30;

  if (event.pump24h < minPump) return "IGNORE";
  if (ageHours < 12) return "WAIT";

  if (
    ageHours >= 12 &&
    ageHours <= 18 &&
    changeSinceEventPct <= 5 &&
    changeSinceEventPct >= -20
  ) {
    return "READY";
  }

  if (
    ageHours > 18 &&
    ageHours <= 24 &&
    changeSinceEventPct <= 5 &&
    changeSinceEventPct >= -25
  ) {
    return "READY_LATE";
  }

  if (ageHours > 72) return "EXPIRED";

  return "WATCH";
}

function findLatestPumpEvent(candles, config) {
  const timeframeHours = config.qorbTimeframeHours ?? 1;
  const lookback = config.qorbPumpLookbackHours ?? 24;
  const volumeLookback = config.qorbVolumeLookbackHours ?? 24;
  const minPumpWeak = config.qorbMinPumpWeak ?? 30;
  const minVolumeSpike = config.qorbMinVolumeSpike ?? 3;
  const minVolumeUSDT = config.qorbMinVolumeUSDT ?? 300000;
  const cooldownHours = config.qorbEventCooldownHours ?? 36;
  const cooldownCandles = Math.ceil(cooldownHours / timeframeHours);

  const events = [];
  let lastEventIndex = -999999;

  for (let i = lookback + volumeLookback; i < candles.length; i++) {
    if (i - lastEventIndex < cooldownCandles) continue;

    const past = candles[i - lookback];
    const now = candles[i];

    if (!past || !now) continue;

    const pump24h = pctChange(past.close, now.close);
    if (pump24h < minPumpWeak) continue;

    const volumeUSDT = now.close * now.volume;
    if (volumeUSDT < minVolumeUSDT) continue;

    const avgVol = avgVolumeUSDT(candles, i - volumeLookback, volumeLookback);
    const volumeSpike = avgVol > 0 ? volumeUSDT / avgVol : 0;
    if (volumeSpike < minVolumeSpike) continue;

    events.push({
      index: i,
      eventTimestamp: now.time,
      eventPrice: now.close,
      eventKey: `${now.time}_${round(now.close, 8)}`,
      pump24h: round(pump24h),
      volumeUSDT: round(volumeUSDT, 0),
      avgVolumeUSDT: round(avgVol, 0),
      volumeSpike: round(volumeSpike),
      upperWickPct: round(upperWickPct(now)),
    });

    lastEventIndex = i;
  }

  return events.length > 0 ? events[events.length - 1] : null;
}

/**
 * @param {object} params
 * @param {Array}  params.candles — candles, chronological oldest → newest
 * @param {object} params.config  — ZenBlade config with qorb* fields
 */
export function getQorbPumpReversalShortSignal({ candles, config }) {
  const timeframeHours = config.qorbTimeframeHours ?? 1;
  const pumpLookback = config.qorbPumpLookbackHours ?? 24;
  const volumeLookback = config.qorbVolumeLookbackHours ?? 24;
  const minOpenScore = config.qorbMinOpenScore ?? 70;

  const minCandles = pumpLookback + volumeLookback + 5;

  if (!candles || candles.length < minCandles) {
    return {
      action: "HOLD",
      reason: `Недостатньо свічок для QORB аналізу (потрібно ${minCandles}, є ${candles?.length ?? 0})`,
      indicators: null,
    };
  }

  const currentCandle = candles[candles.length - 1];
  const event = findLatestPumpEvent(candles, config);

  if (!event) {
    return {
      action: "HOLD",
      reason: "QORB pump event не знайдено",
      indicators: {
        currentClose: currentCandle.close,
        atr14: calcAtr(candles, config.atrPeriod ?? 14),
      },
    };
  }

  const candleAgeHours = (candles.length - 1 - event.index) * timeframeHours;
  const timestampAgeHours =
    Number.isFinite(currentCandle.time) && Number.isFinite(event.eventTimestamp)
      ? Math.floor((currentCandle.time - event.eventTimestamp) / (60 * 60 * 1000))
      : candleAgeHours;

  const ageHours = timestampAgeHours >= 0 ? timestampAgeHours : candleAgeHours;
  const changeSinceEventPct = pctChange(event.eventPrice, currentCandle.close);

  const score = scoreSignal(event, ageHours, changeSinceEventPct);
  const strategyLabel = defineStrategy(event, config);
  const status = defineStatus(event, ageHours, changeSinceEventPct, config);
  const atr14 = calcAtr(candles, config.atrPeriod ?? 14);

  const indicators = {
    currentClose: currentCandle.close,
    eventKey: event.eventKey,
    eventIndex: event.index,
    eventPrice: round(event.eventPrice, 8),
    eventTimestamp: event.eventTimestamp,
    pump24h: event.pump24h,
    ageHours,
    changeSinceEventPct: round(changeSinceEventPct),
    volumeUSDT: event.volumeUSDT,
    avgVolumeUSDT: event.avgVolumeUSDT,
    volumeSpike: event.volumeSpike,
    peakUpperWickPct: event.upperWickPct,
    score,
    status,
    strategyLabel,
    atr14,
  };

  const statusOk = status === "READY" || status === "READY_LATE";
  const scoreOk = score >= minOpenScore;
  const labelOk = strategyLabel !== "WATCH_ONLY";
  const changeOk = changeSinceEventPct >= -20 && changeSinceEventPct <= 5;

  if (statusOk && scoreOk && labelOk && changeOk) {
    return {
      action: "SELL_SHORT",
      reason:
        `QORB reversal: pump ${event.pump24h}% | vol spike ${event.volumeSpike}x | ` +
        `${strategyLabel} | ${status} | age ${ageHours}h | score ${score}`,
      indicators,
    };
  }

  let reason;
  if (!statusOk) reason = `Статус ${status} (потрібно READY або READY_LATE)`;
  else if (!labelOk) reason = "Стратегія WATCH_ONLY";
  else if (!changeOk) reason = `changeSinceEvent ${round(changeSinceEventPct)}% поза зоною [-20, +5]`;
  else if (!scoreOk) reason = `Score ${score} < minOpenScore ${minOpenScore}`;
  else reason = "Умови QORB reversal short не виконані";

  return { action: "HOLD", reason, indicators };
}
