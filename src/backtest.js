import { config } from "./config.js";
import { fetchHistoricalCandles } from "./okxClient.js";
import { getSignal } from "./strategy.js";
import { calculateLongTrade } from "./riskManager.js";

const INITIAL_BALANCE = 1000;

function calcMaxDrawdown(equityCurve) {
  let peak = equityCurve[0] ?? INITIAL_BALANCE;
  let maxDD = 0;
  for (const val of equityCurve) {
    if (val > peak) peak = val;
    const dd = peak - val;
    if (dd > maxDD) maxDD = dd;
  }
  return Math.round(maxDD * 100) / 100;
}

function backtestSymbol(symbol, candles) {
  let balance      = INITIAL_BALANCE;
  let openPosition = null;
  const trades     = [];
  const equity     = [INITIAL_BALANCE];

  for (let i = 60; i < candles.length; i++) {
    const currentCandle = candles[i];

    // ── Check TP/SL on open position first ─────────────────────────────
    if (openPosition) {
      const { stopPrice, takePrice, size, entryPrice } = openPosition;
      const hitStop = currentCandle.low  <= stopPrice;
      const hitTake = currentCandle.high >= takePrice;

      if (hitStop || hitTake) {
        const closePrice  = hitStop ? stopPrice : takePrice;
        const closeReason = hitStop ? "STOP_LOSS" : "TAKE_PROFIT";

        const grossPnl = Math.round((closePrice - entryPrice) * size * 100) / 100;
        const fees     = Math.round((entryPrice + closePrice) * size * config.feeRate * 100) / 100;
        const netPnl   = Math.round((grossPnl - fees) * 100) / 100;

        balance = Math.round((balance + netPnl) * 100) / 100;
        equity.push(balance);

        trades.push({ entryPrice, closePrice, closeReason, size, grossPnl, fees, netPnl, balanceAfter: balance });
        openPosition = null;
      }
      continue;
    }

    // ── Evaluate entry ──────────────────────────────────────────────────
    const historicalCandles = candles.slice(0, i + 1);
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

  return { symbol, trades, finalBalance: balance, equity, candles };
}

function buildSummary({ symbol, trades, finalBalance, equity, candles }) {
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

  const avgTrade = trades.length > 0
    ? Math.round((netPnl / trades.length) * 100) / 100
    : 0;

  const bestTrade  = trades.length > 0
    ? Math.round(Math.max(...trades.map((t) => t.netPnl)) * 100) / 100
    : 0;
  const worstTrade = trades.length > 0
    ? Math.round(Math.min(...trades.map((t) => t.netPnl)) * 100) / 100
    : 0;

  const maxDrawdown = calcMaxDrawdown(equity);

  const firstTime = candles[0]?.time ?? null;
  const lastTime  = candles[candles.length - 1]?.time ?? null;
  const daysCovered = firstTime && lastTime
    ? Math.round(((lastTime - firstTime) / 86400000) * 10) / 10
    : 0;

  const startCandle = firstTime ? new Date(firstTime).toISOString() : "N/A";
  const endCandle   = lastTime  ? new Date(lastTime).toISOString()  : "N/A";

  return {
    symbol, finalBalance, winCount, lossCount, winRate,
    netPnl, fees, profitFactor, totalTrades: trades.length,
    avgTrade, bestTrade, worstTrade, maxDrawdown,
    startCandle, endCandle, daysCovered,
  };
}

function printSummary(s) {
  console.log(`Symbol:          ${s.symbol}`);
  console.log(`   Start Candle:    ${s.startCandle}`);
  console.log(`   End Candle:      ${s.endCandle}`);
  console.log(`   Days Covered:    ~${s.daysCovered} days`);
  console.log(`   Initial Balance: ${INITIAL_BALANCE} USDT`);
  console.log(`   Final Balance:   ${s.finalBalance} USDT`);
  console.log(`   Total Trades:    ${s.totalTrades}`);
  console.log(`   Wins:            ${s.winCount}`);
  console.log(`   Losses:          ${s.lossCount}`);
  console.log(`   Win Rate:        ${s.winRate}`);
  console.log(`   Net PnL:         ${s.netPnl} USDT`);
  console.log(`   Fees:            ${s.fees} USDT`);
  console.log(`   Profit Factor:   ${s.profitFactor}`);
  console.log(`   Average Trade:   ${s.avgTrade} USDT`);
  console.log(`   Best Trade:      ${s.bestTrade} USDT`);
  console.log(`   Worst Trade:     ${s.worstTrade} USDT`);
  console.log(`   Max Drawdown:    ${s.maxDrawdown} USDT`);
  console.log();
}

// ── Main ───────────────────────────────────────────────────────────────────
console.log("=== ZenBlade Extended Backtest ===");
console.log(`Symbols:      ${config.symbols.join(", ")}`);
console.log(`Bar:          ${config.bar}`);
console.log(`Target candles per symbol: ${config.backtestCandlesLimit}`);
console.log();

const summaries = [];

for (const symbol of config.symbols) {
  console.log(`Loading historical candles for ${symbol}...`);
  const candles = await fetchHistoricalCandles({
    symbol,
    bar:         config.bar,
    targetLimit: config.backtestCandlesLimit,
  });
  console.log(`Candles loaded: ${candles.length}`);

  if (candles.length < 200) {
    console.log(`⚠ Warning: small sample (${candles.length} candles) — results may not be reliable`);
  }

  const result  = backtestSymbol(symbol, candles);
  const summary = buildSummary(result);
  summaries.push(summary);

  printSummary(summary);
}

// ── Ranking ────────────────────────────────────────────────────────────────
summaries.sort((a, b) => b.netPnl - a.netPnl);

console.log("=== Ranking by Net PnL ===");
summaries.forEach((s, i) => {
  const arrow = s.netPnl > 0 ? "▲" : s.netPnl < 0 ? "▼" : "─";
  console.log(
    `${i + 1}. ${s.symbol.padEnd(12)} ${arrow}  ` +
    `Net PnL: ${String(s.netPnl).padStart(8)} USDT  |  ` +
    `Trades: ${String(s.totalTrades).padStart(3)}  |  ` +
    `Win Rate: ${String(s.winRate).padStart(6)}  |  ` +
    `MaxDD: ${s.maxDrawdown} USDT  |  ` +
    `Final: ${s.finalBalance} USDT`
  );
});
