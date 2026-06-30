/**
 * Bullish candle scenario designed to satisfy all BUY conditions in strategy.js:
 *   EMA20 > EMA50       — steady uptrend over 100 candles
 *   lastClose > EMA20   — last candle at a local sine peak
 *   RSI in [45, 65]     — balanced oscillations (≈50% up / 50% down moves)
 *   lastVolume >= volumeSma20 * 1.05  — spike on newest candle
 *   ATR > 0             — natural spread between high/low
 *
 * Candle[0] = newest (OKX format). Built old-to-new internally, then reversed.
 *
 * Price formula: close[i] = 59000 + i + 100 * sin(i * 0.5 + PHASE)
 *   PHASE = 2.336 → sin at i=99 equals sin(π/2) = 1.0 → local maximum → lastClose > EMA20
 *   Slope of 1 per candle → very slight uptrend → EMA20 barely but consistently above EMA50
 *   Amplitude 100 + freq 0.5 → ~50% up / ~50% down diffs → RSI converges to ~53
 */

const PHASE = 2.336;

export function createBullishCandles() {
  const oldToNew = [];

  for (let i = 0; i < 100; i++) {
    const close = Math.round((59000 + i + 100 * Math.sin(i * 0.5 + PHASE)) * 100) / 100;
    const spread = 45;
    const open = Math.round((close - 5) * 100) / 100;
    const high = Math.round((close + spread) * 100) / 100;
    const low = Math.round((close - spread) * 100) / 100;

    // Candles[0..79] (oldest 80): low base volume
    // Candles[80..98] (recent 19): moderate volume
    // Candle[99] (newest): volume spike → lastVolume >> volumeSma20 * 1.05
    let volume;
    if (i === 99) {
      volume = 300;
    } else if (i >= 80) {
      volume = 100;
    } else {
      volume = 70 + Math.round(Math.abs(Math.sin(i * 0.3)) * 20 * 100) / 100;
    }

    oldToNew.push({
      time: Date.now() - (99 - i) * 5 * 60 * 1000,
      open,
      high,
      low,
      close,
      volume,
    });
  }

  // Reverse: candles[0] = newest (i=99), candles[99] = oldest (i=0)
  return oldToNew.reverse();
}
