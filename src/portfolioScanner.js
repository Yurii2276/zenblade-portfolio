import { config } from "./config.js";
import { fetchCandles } from "./okxClient.js";
import { getSignal } from "./strategy.js";
import { logInfo } from "./logger.js";

async function scanSymbol(symbol) {
  const candles = await fetchCandles({
    symbol,
    bar:   config.bar,
    limit: config.candlesLimit,
  });

  const signal = getSignal({ candles, config });
  const ind    = signal.indicators ?? {};

  const { lastClose, ema20, ema50, rsi14, atr14, lastVolume, volumeSma20 } = ind;

  let score = 0;
  if (ema20 != null && ema50 != null && ema20 > ema50)                              score += 30;
  if (lastClose != null && ema20 != null && lastClose > ema20)                      score += 20;
  if (rsi14 != null && rsi14 >= config.minRsiForLong && rsi14 <= config.maxRsiForLong) score += 20;
  if (lastVolume != null && volumeSma20 != null &&
      lastVolume >= volumeSma20 * config.minVolumeFactor)                            score += 15;
  if (atr14 != null && atr14 > 0)                                                   score += 10;
  if (signal.action === "BUY")                                                       score += 5;

  return {
    symbol,
    action:     signal.action,
    score,
    reason:     signal.reason,
    indicators: ind,
  };
}

console.log("=== ZenBlade Portfolio Scanner ===\n");

const results = [];

for (const symbol of config.symbols) {
  try {
    const result = await scanSymbol(symbol);
    results.push(result);
  } catch (err) {
    console.error(`Error scanning ${symbol}: ${err.message}`);
    results.push({ symbol, action: "ERROR", score: 0, reason: err.message, indicators: {} });
  }
}

results.sort((a, b) => b.score - a.score);

results.forEach((r, i) => {
  const ind = r.indicators;
  console.log(`${i + 1}. ${r.symbol}`);
  console.log(`   Score:       ${r.score}`);
  console.log(`   Signal:      ${r.action}`);
  console.log(`   Price:       ${ind.lastClose ?? "N/A"}`);
  console.log(`   EMA20:       ${ind.ema20     ?? "N/A"}`);
  console.log(`   EMA50:       ${ind.ema50     ?? "N/A"}`);
  console.log(`   RSI14:       ${ind.rsi14     ?? "N/A"}`);
  console.log(`   ATR14:       ${ind.atr14     ?? "N/A"}`);
  console.log(`   Volume:      ${ind.lastVolume  ?? "N/A"}`);
  console.log(`   Volume SMA20:${ind.volumeSma20 ?? "N/A"}`);
  console.log(`   Reason:      ${r.reason}`);
  console.log();
});

const best = results[0];
const isStrong = best && best.score >= 80;

console.log("Best candidate:");
if (isStrong) {
  console.log(`${best.symbol} | Score: ${best.score} | Signal: ${best.action}`);
} else {
  console.log(`${best?.symbol ?? "N/A"} | Score: ${best?.score ?? 0} | Signal: ${best?.action ?? "N/A"}`);
  console.log("No strong setup yet");
}
