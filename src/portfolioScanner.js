import { config as defaultConfig } from "./config.js";
import { fetchCandles, fetchHistoricalCandles } from "./okxClient.js";
import { getSignal } from "./strategy.js";

async function scanSymbol(symbol, config) {
  const candles = await fetchCandles({
    symbol,
    bar:   config.bar,
    limit: config.candlesLimit,
  });

  const htfCandles = config.useHtfFilter === true
    ? await fetchHistoricalCandles({
        symbol,
        bar:         config.htfBar,
        targetLimit: config.htfCandlesLimit,
      })
    : null;

  const signal = getSignal({ candles, config, htfCandles });
  const ind    = signal.indicators ?? {};

  const {
    lastClose, emaFast, emaSlow, rsi14, atr14, lastVolume, volumeSma20,
    htfTrendOk,
  } = ind;

  let score = 0;
  if (emaFast != null && emaSlow != null && emaFast > emaSlow)                           score += 30;
  if (lastClose != null && emaFast != null && lastClose > emaFast)                       score += 20;
  if (rsi14 != null && rsi14 >= config.minRsiForLong && rsi14 <= config.maxRsiForLong)  score += 20;
  if (lastVolume != null && volumeSma20 != null &&
      lastVolume >= volumeSma20 * config.minVolumeFactor)                                score += 15;
  if (atr14 != null && atr14 > 0)                                                       score += 10;
  if (signal.action === "BUY")                                                           score += 5;
  if (htfTrendOk === true)                                                              score += 15;

  return {
    symbol,
    action:     signal.action,
    score,
    reason:     signal.reason,
    candles,
    htfCandles,
    indicators: ind,
  };
}

export async function scanPortfolio(config) {
  const results = [];

  for (const symbol of config.symbols) {
    try {
      const result = await scanSymbol(symbol, config);
      results.push(result);
    } catch (err) {
      console.error(`Error scanning ${symbol}: ${err.message}`);
      results.push({ symbol, action: "ERROR", score: 0, reason: err.message, candles: [], indicators: {} });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

function printResults(results, config) {
  const threshold = config.minScoreForEntry || 80;
  console.log("=== ZenBlade Portfolio Scanner ===\n");

  results.forEach((r, i) => {
    const ind = r.indicators;
    console.log(`${i + 1}. ${r.symbol}`);
    console.log(`   Score:        ${r.score}`);
    console.log(`   Signal:       ${r.action}`);
    console.log(`   Price:        ${ind.lastClose  ?? "N/A"}`);
    console.log(`   EMA fast:     ${ind.emaFast    ?? "N/A"}`);
    console.log(`   EMA slow:     ${ind.emaSlow    ?? "N/A"}`);
    console.log(`   RSI14:        ${ind.rsi14      ?? "N/A"}`);
    console.log(`   ATR14:        ${ind.atr14      ?? "N/A"}`);
    console.log(`   Volume:       ${ind.lastVolume  ?? "N/A"}`);
    console.log(`   Volume SMA:   ${ind.volumeSma20 ?? "N/A"}`);
    console.log(`   HTF Last Close: ${ind.htfLastClose ?? "N/A"}`);
    console.log(`   HTF EMA Fast:   ${ind.htfEmaFast   ?? "N/A"}`);
    console.log(`   HTF EMA Slow:   ${ind.htfEmaSlow   ?? "N/A"}`);
    console.log(`   HTF Trend OK:   ${ind.htfTrendOk   ?? "N/A"}`);
    console.log(`   Reason:       ${r.reason}`);
    console.log();
  });

  const best     = results[0];
  const isStrong = best && best.score >= threshold && best.action === "BUY";

  console.log("Best candidate:");
  if (isStrong) {
    console.log(`${best.symbol} | Score: ${best.score} | Signal: ${best.action}`);
  } else {
    console.log(`${best?.symbol ?? "N/A"} | Score: ${best?.score ?? 0} | Signal: ${best?.action ?? "N/A"}`);
    console.log("No strong setup yet");
  }
}

// CLI entry point — only runs when executed directly
if (process.argv[1].endsWith("portfolioScanner.js")) {
  const results = await scanPortfolio(defaultConfig);
  printResults(results, defaultConfig);
}
