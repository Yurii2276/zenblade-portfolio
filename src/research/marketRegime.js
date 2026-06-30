import { ema, rsi, atr, volumeSma } from "../indicators.js";

function round(value, decimals = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function analyzeMarketRegime({ candles, htfCandles, config }) {
  if (!candles || candles.length === 0) {
    throw new Error("Market regime analysis requires 5m candles");
  }

  const closes = candles.map((candle) => candle.close);
  const lastCandle = candles[candles.length - 1];
  const lastClose = lastCandle.close;
  const emaFast = ema(closes, config.emaFast);
  const emaSlow = ema(closes, config.emaSlow);
  const rsi14 = rsi(closes, config.rsiPeriod);
  const atr14 = atr(candles, config.atrPeriod);
  const lastVolume = lastCandle.volume;
  const volumeSma20 = volumeSma(candles, config.volumePeriod);

  const htfCloses = htfCandles?.map((candle) => candle.close) ?? [];
  const htfLastClose = htfCloses.length > 0
    ? htfCloses[htfCloses.length - 1]
    : null;
  const htfEmaFast = ema(htfCloses, config.htfEmaFast);
  const htfEmaSlow = ema(htfCloses, config.htfEmaSlow);
  const htfTrendOk =
    htfEmaFast !== null &&
    htfEmaSlow !== null &&
    htfLastClose !== null &&
    htfEmaFast > htfEmaSlow &&
    htfLastClose > htfEmaFast;

  const emaDistancePct = emaFast
    ? ((lastClose - emaFast) / emaFast) * 100
    : null;
  const emaSpreadPct = emaSlow
    ? ((emaFast - emaSlow) / emaSlow) * 100
    : null;
  const atrPct = lastClose && atr14 !== null
    ? (atr14 / lastClose) * 100
    : null;
  const volumeRatio = volumeSma20
    ? lastVolume / volumeSma20
    : null;

  let regime = "MIXED";
  if (emaFast > emaSlow && htfTrendOk === true) {
    regime = "UPTREND";
  } else if (emaFast < emaSlow && htfTrendOk === false) {
    regime = "DOWNTREND";
  } else if (emaSpreadPct !== null && Math.abs(emaSpreadPct) < 0.15) {
    regime = "RANGE";
  } else if (atrPct !== null && atrPct > 0.8) {
    regime = "HIGH_VOLATILITY";
  } else if (atrPct !== null && atrPct < 0.25) {
    regime = "LOW_VOLATILITY";
  }

  return {
    lastClose,
    emaFast,
    emaSlow,
    emaDistancePct: round(emaDistancePct),
    emaSpreadPct: round(emaSpreadPct),
    rsi14,
    atr14,
    atrPct: round(atrPct),
    lastVolume,
    volumeSma20,
    volumeRatio: round(volumeRatio),
    htfTrendOk,
    htfEmaFast,
    htfEmaSlow,
    htfLastClose,
    regime,
  };
}
