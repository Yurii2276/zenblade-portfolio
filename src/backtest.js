import { config } from "./config.js";
import { fetchCandles } from "./okxClient.js";
import { getSignal } from "./strategy.js";
import { calculateLongTrade } from "./riskManager.js";

const INITIAL_BALANCE = 1000;

function backtestSymbol(symbol, candles) {
  let balance       = INITIAL_BALANCE;
  let openPosition  = null;
  const trades      = [];

  for (let i = 60; i < candles.length; i++) {
    const historicalCandles = candles.slice(0, i + 1);
    const currentCandle     = candles[i];

    // ── Check TP/SL on open position ───────────────────────────────────
    if (openPosition) {
      const { stopPrice, takePrice, size, entryPrice } = openPosition;
      const hitStop = currentCandle.low  <= stopPrice;
      const hitTake = currentCandle.high >= takePrice;

      if (hitStop || hitTake) {
        // Conservative: if both triggered same candle, stop wins
        const closePrice  = hitStop ? stopPrice : takePrice;
        const closeReason = hitStop ? "STOP_LOSS" : "TAKE_PROFIT";

        const grossPnl = Math.round((closePrice - entryPrice) * size * 100) / 100;
        const fees     = Math.round((entryPrice + closePrice) * size * config.feeRate * 100) / 100;
        const netPnl   = Math.round((grossPnl - fees) * 100) / 100;

        balance = Math.round((balance + netPnl) * 100) / 100;

        trades.push({
          entryPrice,
          closePrice,
          closeReason,
          size,
          grossPnl,
          fees,
          netPnl,
          balanceAfter: balance,
        });

        openPosition = null;
      }
      continue;
    }

    // ── Evaluate entry on new candle ────────────────────────────────────
    const signal = getSignal({ candles: historicalCandles, config });

    if (signal.action === "BUY" && signal.indicators) {
      const trade = calculateLongTrade({
        balance,
        entryPrice: signal.indicators.lastClose,
        atr:        signal.indicators.atr14,
        config,
      });

      if (trade.size > 0 && trade.positionValue > 0) {
        openPosition = {
          entryPrice: trade.entryPrice,
          stopPrice:  trade.stopPrice,
          takePrice:  trade.takePrice,
          size:       trade.size,
        };
      }
    }
  }

  return { symbol, trades, finalBalance: balance };
}

function buildSummary({ symbol, trades, finalBalance }) {
  const wins   = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl < 0);

  const winCount  = wins.length;
  const lossCount = losses.length;
  const winRate   = trades.length > 0
    ? ((winCount / trades.length) * 100).toFixed(1) + "%"
    : "N/A";

  const netPnl = Math.round(trades.reduce((s, t) => s + t.netPnl, 0) * 100) / 100;
  const fees   = Math.round(trades.reduce((s, t) => s + t.fees,   0) * 100) / 100;

  const totalWinPnl  = wins.reduce((s, t) => s + t.netPnl, 0);
  const totalLossPnl = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));
  const profitFactor = totalLossPnl > 0
    ? Math.round((totalWinPnl / totalLossPnl) * 100) / 100
    : "N/A";

  return { symbol, finalBalance, winCount, lossCount, winRate, netPnl, fees, profitFactor, totalTrades: trades.length };
}

function printSummary(s, index) {
  if (index !== undefined) console.log(`${index + 1}. ${s.symbol}`);
  else                      console.log(`Symbol:          ${s.symbol}`);

  console.log(`   Initial Balance: ${INITIAL_BALANCE} USDT`);
  console.log(`   Final Balance:   ${s.finalBalance} USDT`);
  console.log(`   Total Trades:    ${s.totalTrades}`);
  console.log(`   Wins:            ${s.winCount}`);
  console.log(`   Losses:          ${s.lossCount}`);
  console.log(`   Win Rate:        ${s.winRate}`);
  console.log(`   Net PnL:         ${s.netPnl} USDT`);
  console.log(`   Fees:            ${s.fees} USDT`);
  console.log(`   Profit Factor:   ${s.profitFactor}`);
  console.log();
}

// ── Main ───────────────────────────────────────────────────────────────────
console.log("=== ZenBlade Backtest ===");
console.log(`Symbols: ${config.symbols.join(", ")}`);
console.log(`Bar:     ${config.bar}  |  Candles per symbol: ${config.candlesLimit}`);
console.log();

const summaries = [];

for (const symbol of config.symbols) {
  process.stdout.write(`Fetching ${symbol}...`);
  const candles = await fetchCandles({ symbol, bar: config.bar, limit: config.candlesLimit });
  process.stdout.write(` ${candles.length} candles\n`);

  const result  = backtestSymbol(symbol, candles);
  const summary = buildSummary(result);
  summaries.push(summary);

  printSummary(summary);
}

// ── Overall ranking ────────────────────────────────────────────────────────
summaries.sort((a, b) => b.netPnl - a.netPnl);

console.log("=== Ranking by Net PnL ===");
summaries.forEach((s, i) => {
  const arrow = s.netPnl > 0 ? "▲" : s.netPnl < 0 ? "▼" : "─";
  console.log(`${i + 1}. ${s.symbol.padEnd(12)} ${arrow} Net PnL: ${s.netPnl} USDT  |  Trades: ${s.totalTrades}  |  Win Rate: ${s.winRate}  |  Final: ${s.finalBalance} USDT`);
});
