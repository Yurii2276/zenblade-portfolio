export function sma(values, period) {
  if (!values || values.length < period) return null;
  const slice = values.slice(0, period);
  const result = slice.reduce((sum, v) => sum + v, 0) / period;
  return Math.round(result * 100) / 100;
}

export function ema(values, period) {
  if (!values || values.length < period) return null;
  const reversed = [...values].reverse();
  const k = 2 / (period + 1);
  let emaVal = reversed.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  for (let i = period; i < reversed.length; i++) {
    emaVal = reversed[i] * k + emaVal * (1 - k);
  }
  return Math.round(emaVal * 100) / 100;
}

export function rsi(values, period = 14) {
  if (!values || values.length < period + 1) return null;
  const reversed = [...values].reverse();
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = reversed[i] - reversed[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < reversed.length; i++) {
    const diff = reversed[i] - reversed[i - 1];
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
}

export function atr(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const reversed = [...candles].reverse();
  const trValues = [];
  for (let i = 1; i < reversed.length; i++) {
    const high = reversed[i].high;
    const low = reversed[i].low;
    const prevClose = reversed[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trValues.push(tr);
  }
  if (trValues.length < period) return null;
  let atrVal = trValues.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  for (let i = period; i < trValues.length; i++) {
    atrVal = (atrVal * (period - 1) + trValues[i]) / period;
  }
  return Math.round(atrVal * 100) / 100;
}

export function volumeSma(candles, period = 20) {
  if (!candles || candles.length < period) return null;
  const slice = candles.slice(0, period);
  const result = slice.reduce((sum, c) => sum + c.volume, 0) / period;
  return Math.round(result * 100) / 100;
}
