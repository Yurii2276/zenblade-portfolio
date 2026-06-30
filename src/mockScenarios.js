/**
 * Bullish candle scenario — chronological order: oldest → newest.
 * candles[candles.length - 1] is the most recent candle.
 *
 * Designed to satisfy all BUY conditions in strategy.js:
 *   EMA20 > EMA50       — steady uptrend over 100 candles
 *   lastClose > EMA20   — last candle at a local sine peak (PHASE chosen for this)
 *   RSI in [45, 65]     — ~50/50 up/down moves keep RSI ≈ 53–63
 *   lastVolume >= volumeSma20 * 1.05  — spike on last (newest) candle
 *   ATR > 0             — natural spread between high/low
 *
 * Price formula (old-to-new index i=0..99):
 *   close[i] = 59000 + i + 100 * sin(i * 0.5 + PHASE)
 *   PHASE = 2.336 → sin(99*0.5 + 2.336) = sin(π/2) = 1.0 → last candle at local max
 */

const PHASE = 2.336;

export function createBullishCandles() {
  const candles = [];

  for (let i = 0; i < 100; i++) {
    const close = Math.round((59000 + i + 100 * Math.sin(i * 0.5 + PHASE)) * 100) / 100;
    const spread = 45;
    const open = Math.round((close - 5) * 100) / 100;
    const high = Math.round((close + spread) * 100) / 100;
    const low = Math.round((close - spread) * 100) / 100;

    // Last candle (i=99, newest): volume spike
    // Previous 19 (i=80..98): moderate 100
    // Older (i=0..79): low base volume
    let volume;
    if (i === 99) {
      volume = 300;
    } else if (i >= 80) {
      volume = 100;
    } else {
      volume = 70 + Math.round(Math.abs(Math.sin(i * 0.3)) * 20 * 100) / 100;
    }

    candles.push({
      time: Date.now() - (99 - i) * 5 * 60 * 1000,
      open,
      high,
      low,
      close,
      volume,
    });
  }

  // candles[0] = oldest, candles[99] = newest
  return candles;
}
