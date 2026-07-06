/**
 * QORB Pump Reversal Short strategy.
 * Research/backtest only — no real trading.
 *
 * Adapted from the QORB pump reversal bot logic to the ZenBlade candle format.
 * Designed for 1H candles (qorbTimeframeHours: 1).
 *
 * Returns: { action: "SELL_SHORT" | "HOLD", reason, indicators }
 */

import { atr as calcAtr } from "../indicators.js";

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Find the index of the highest high within a slice of candles. */
function findPeakIndex(candles) {
  let peakIdx = 0;
  let peakHigh = candles[0].high;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].high > peakHigh) {
      peakHigh = candles[i].high;
      peakIdx = i;
    }
  }
  return peakIdx;
}

/** Upper wick % of a single candle relative to its full range. */
function upperWickPct(candle) {
  const range = candle.high - candle.low;
  if (range <= 0) return 0;
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  return round((upperWick / range) * 100);
}

/** Score the pump event on a 0–100 scale. */
function calcScore({ pump24h, volumeSpike, peakUpperWickPct, changeSinceEventPct }) {
  let score = 0;

  // Pump strength (max 40 pts)
  if (pump24h >= 100)     score += 40;
  else if (pump24h >= 60) score += 25;
  else if (pump24h >= 40) score += 15;
  else if (pump24h >= 30) score += 10;

  // Volume spike (max 30 pts)
  if (volumeSpike >= 5)      score += 30;
  else if (volumeSpike >= 4) score += 20;
  else if (volumeSpike >= 3) score += 15;
  else if (volumeSpike >= 2) score += 5;

  // Upper wick exhaustion signal (max 20 pts)
  if (peakUpperWickPct >= 50)     score += 20;
  else if (peakUpperWickPct >= 30) score += 10;
  else if (peakUpperWickPct >= 15) score += 5;

  // Price change since pump peak (adjust ±5 pts)
  // Small decline = just started reversing = best entry window
  if (changeSinceEventPct >= -5 && changeSinceEventPct <= 0)  score += 5;
  else if (changeSinceEventPct < -10)                          score -= 5;

  return round(score);
}

/** STRONG / GOOD / MEDIUM / WATCH_ONLY based on pump + volume spike. */
function calcStrategyLabel(pump24h, volumeSpike) {
  if (pump24h >= 100 && volumeSpike >= 5) return "STRONG";
  if (pump24h >= 60  && volumeSpike >= 4) return "GOOD";
  if (pump24h >= 40  && volumeSpike >= 3) return "MEDIUM";
  return "WATCH_ONLY";
}

/** READY / READY_LATE / TOO_EARLY / EXHAUSTED. */
function calcStatus(ageHours, cooldownHours) {
  if (ageHours < 2)                return "TOO_EARLY";
  if (ageHours <= 24)              return "READY";
  if (ageHours <= cooldownHours)   return "READY_LATE";
  return "EXHAUSTED";
}

/**
 * @param {object} params
 * @param {Array}  params.candles  – 1H candles, chronological (oldest → newest)
 * @param {object} params.config   – ZenBlade config with qorb* fields
 */
export function getQorbPumpReversalShortSignal({ candles, config }) {
  const timeframeHours     = config.qorbTimeframeHours       ?? 1;
  const pumpLookback       = config.qorbPumpLookbackHours    ?? 24;
  const volumeLookback     = config.qorbVolumeLookbackHours  ?? 24;
  const minPumpWeak        = config.qorbMinPumpWeak          ?? 30;
  const minVolumeSpike     = config.qorbMinVolumeSpike       ?? 3;
  const minVolumeUSDT      = config.qorbMinVolumeUSDT        ?? 300000;
  const cooldownHours      = config.qorbEventCooldownHours   ?? 36;
  const minOpenScore       = config.qorbMinOpenScore         ?? 70;

  const minCandles = pumpLookback + 5;

  if (!candles || candles.length < minCandles) {
    return {
      action: "HOLD",
      reason: `Недостатньо свічок для QORB аналізу (потрібно ${minCandles}, є ${candles?.length ?? 0})`,
      indicators: null,
    };
  }

  const currentCandle = candles[candles.length - 1];
  const currentClose  = currentCandle.close;

  // ── Pump detection ────────────────────────────────────────────────────────

  // Lookback slice: last pumpLookback candles excluding current
  const lookbackSlice = candles.slice(-pumpLookback - 1, -1);
  const peakIdxInSlice = findPeakIndex(lookbackSlice);
  const peakCandle = lookbackSlice[peakIdxInSlice];
  const peakHigh   = peakCandle.high;

  // Find trough (lowest close) from start of lookback up to (and including) peak
  const prepeakSlice = lookbackSlice.slice(0, peakIdxInSlice + 1);
  const troughClose  = Math.min(...prepeakSlice.map((c) => c.close));

  const pump24h =
    troughClose > 0
      ? round(((peakHigh - troughClose) / troughClose) * 100)
      : 0;

  const ageHours = round(
    (candles.length - 1 - (candles.length - 1 - pumpLookback + peakIdxInSlice)) *
    timeframeHours
  );

  const changeSinceEventPct =
    peakHigh > 0
      ? round(((currentClose - peakHigh) / peakHigh) * 100)
      : 0;

  // ── Volume analysis ───────────────────────────────────────────────────────

  const volSlice      = candles.slice(-volumeLookback - 1, -1);
  const avgVolumeUSDT = volSlice.length > 0
    ? round(volSlice.reduce((s, c) => s + c.close * c.volume, 0) / volSlice.length)
    : 0;
  const volumeUSDT    = round(currentCandle.close * currentCandle.volume);
  const volumeSpike   = avgVolumeUSDT > 0
    ? round(volumeUSDT / avgVolumeUSDT)
    : 0;

  // ── Indicators ────────────────────────────────────────────────────────────

  const peakUpperWick = upperWickPct(peakCandle);
  const atr14         = calcAtr(candles, config.atrPeriod ?? 14);

  const score          = calcScore({ pump24h, volumeSpike, peakUpperWickPct: peakUpperWick, changeSinceEventPct });
  const strategyLabel  = calcStrategyLabel(pump24h, volumeSpike);
  const status         = calcStatus(ageHours, cooldownHours);

  const indicators = {
    currentClose,
    pump24h,
    troughClose: round(troughClose),
    peakHigh: round(peakHigh),
    ageHours,
    changeSinceEventPct,
    volumeUSDT,
    avgVolumeUSDT,
    volumeSpike,
    peakUpperWickPct: peakUpperWick,
    score,
    status,
    strategyLabel,
    atr14,
  };

  // ── Signal logic ──────────────────────────────────────────────────────────

  const statusOk          = status === "READY" || status === "READY_LATE";
  const scoreOk           = score >= minOpenScore;
  const labelOk           = strategyLabel !== "WATCH_ONLY";
  const changeOk          = changeSinceEventPct >= -20 && changeSinceEventPct <= 5;
  const pumpOk            = pump24h >= minPumpWeak;
  const volumeSpikeOk     = volumeSpike >= minVolumeSpike;
  const volumeUsdtOk      = volumeUSDT >= minVolumeUSDT;

  if (statusOk && scoreOk && labelOk && changeOk && pumpOk && volumeSpikeOk && volumeUsdtOk) {
    return {
      action: "SELL_SHORT",
      reason: `QORB reversal: pump ${pump24h}% | vol spike ${volumeSpike}x | ` +
              `${strategyLabel} | ${status} | age ${ageHours}h | score ${score}`,
      indicators,
    };
  }

  // Build HOLD reason
  let reason;
  if (!pumpOk)          reason = `Pump ${pump24h}% < мінімум ${minPumpWeak}%`;
  else if (!volumeSpikeOk) reason = `Volume spike ${volumeSpike}x < мінімум ${minVolumeSpike}x`;
  else if (!volumeUsdtOk)  reason = `Volume USDT ${volumeUSDT} < мінімум ${minVolumeUSDT}`;
  else if (!statusOk)      reason = `Статус ${status} (потрібно READY або READY_LATE)`;
  else if (!labelOk)       reason = `Стратегія WATCH_ONLY (pump/volume занадто слабкі)`;
  else if (!changeOk)      reason = `changeSinceEvent ${changeSinceEventPct}% поза зоною [-20, +5]`;
  else if (!scoreOk)       reason = `Score ${score} < minOpenScore ${minOpenScore}`;
  else                     reason = "Умови QORB reversal short не виконані";

  return { action: "HOLD", reason, indicators };
}
