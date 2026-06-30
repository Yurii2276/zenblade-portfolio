import { config } from "./config.js";
import { getSignal } from "./strategy.js";
import { createBullishCandles } from "./mockScenarios.js";

const candles = createBullishCandles();
const signal = getSignal({ candles, config });

console.log("=== ZenBlade Test Signal ===");
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
