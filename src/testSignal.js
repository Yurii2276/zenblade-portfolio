import { config } from "./config.js";
import { getSignal } from "./strategy.js";
import { createBullishCandles } from "./mockScenarios.js";

const candles = createBullishCandles();

const first = candles[0];
const last = candles[candles.length - 1];

console.log("=== ZenBlade Candle Order Check ===");
console.log(`First candle time: ${new Date(first.time).toISOString()}`);
console.log(`Last candle time:  ${new Date(last.time).toISOString()}`);
console.log(`First close: ${first.close}`);
console.log(`Last close:  ${last.close}`);
console.log(`Last volume: ${last.volume}`);

if (last.time <= first.time) {
  throw new Error("Candles order error: expected old -> new");
}

const signal = getSignal({ candles, config });

console.log("\n=== ZenBlade Test Signal ===");
console.log(`Signal:  ${signal.action}`);
console.log(`Reason:  ${signal.reason}`);

if (signal.indicators) {
  const ind = signal.indicators;
  console.log("--- Indicators ---");
  console.log(`lastClose:   ${ind.lastClose}`);
  console.log(`EMA20:       ${ind.ema20}`);
  console.log(`EMA50:       ${ind.ema50}`);
  console.log(`RSI14:       ${ind.rsi14}`);
  console.log(`ATR14:       ${ind.atr14}`);
  console.log(`lastVolume:  ${ind.lastVolume}`);
  console.log(`VolumeSMA20: ${ind.volumeSma20}`);
}
