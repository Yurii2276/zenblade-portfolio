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

function backtestSymbol(candles, htfCandles, profileConfig) {
  let balance      = INITIAL_BALANCE;
  let openPosition = null;
  const trades     = [];
  const equity     = [INITIAL_BALANCE];

  for (let i = 60; i < candles.length; i++) {
    const currentCandle = candles[i];

    if (openPosition) {
      const { stopPrice, takePrice, size, entryPrice } = openPosition;
      const hitStop = currentCandle.low  <= stopPrice;
      const hitTake = currentCandle.high >= takePrice;

      if (hitStop || hitTake) {
        const closePrice  = hitStop ? stopPrice : takePrice;
        const closeReason = hitStop ? "STOP_LOSS" : "TAKE_PROFIT";

        const grossPnl = Math.round((closePrice - entryPrice) * size * 100) / 100;
        const fees     = Math.round((entryPrice + closePrice) * size * profileConfig.feeRate * 100) / 100;
        const netPnl   = Math.round((grossPnl - fees) * 100) / 100;

        balance = Math.round((balance + netPnl) * 100) / 100;
        equity.push(balance);
        trades.push({ entryPrice, closePrice, closeReason, size, grossPnl, fees, netPnl });
        openPosition = null;
      }
      continue;
    }

    const historicalCandles = candles.slice(0, i + 1);
    const currentTime = currentCandle.time;
    const htfSlice = htfCandles?.filter((c) => c.time <= currentTime) ?? null;
    const signal = getSignal({
      candles: historicalCandles,
      config: profileConfig,
      htfCandles: htfSlice,
    });

    if (signal.action === "BUY" && signal.indicators) {
      const trade = calculateLongTrade({
        balance,
        entryPrice: signal.indicators.lastClose,
        atr:        signal.indicators.atr14,
        config:     profileConfig,
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

  if (openPosition && candles.length > 0) {
    const { size, entryPrice } = openPosition;
    const closePrice = candles[candles.length - 1].close;
    const grossPnl = Math.round((closePrice - entryPrice) * size * 100) / 100;
    const fees = Math.round((entryPrice + closePrice) * size * profileConfig.feeRate * 100) / 100;
    const netPnl = Math.round((grossPnl - fees) * 100) / 100;

    balance = Math.round((balance + netPnl) * 100) / 100;
    equity.push(balance);
    trades.push({
      entryPrice,
      closePrice,
      closeReason: "END_OF_TEST",
      size,
      grossPnl,
      fees,
      netPnl,
    });
  }

  return { trades, finalBalance: balance, equity };
}

function buildSummary({ symbol, profileName, trades, finalBalance, equity }) {
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

  const avgTrade   = trades.length > 0 ? Math.round((netPnl / trades.length) * 100) / 100 : 0;
  const bestTrade  = trades.length > 0 ? Math.round(Math.max(...trades.map((t) => t.netPnl)) * 100) / 100 : 0;
  const worstTrade = trades.length > 0 ? Math.round(Math.min(...trades.map((t) => t.netPnl)) * 100) / 100 : 0;
  const maxDrawdown = calcMaxDrawdown(equity);

  return {
    symbol, profileName, finalBalance,
    totalTrades: trades.length, winCount, lossCount, winRate,
    netPnl, fees, profitFactor,
    avgTrade, bestTrade, worstTrade, maxDrawdown,
  };
}

// ── Pre-fetch candles once per symbol ──────────────────────────────────────
console.log("=== ZenBlade Backtest: Strategy Profiles ===");
console.log(`Symbols:  ${config.symbols.join(", ")}`);
console.log(`Bar:      ${config.bar}  |  Target candles: ${config.backtestCandlesLimit}`);
console.log(`Profiles: ${Object.keys(config.strategyProfiles).join(", ")}`);
console.log();

const candleCache = {};
for (const symbol of config.symbols) {
  process.stdout.write(`Loading candles for ${symbol}...`);
  const candles = await fetchHistoricalCandles({
    symbol,
    bar:         config.bar,
    targetLimit: config.backtestCandlesLimit,
  });
  const htfCandles = config.useHtfFilter === true
    ? await fetchHistoricalCandles({
        symbol,
        bar:         config.htfBar,
        targetLimit: config.htfCandlesLimit,
      })
    : null;

  let error = null;
  if (candles.length === 0) {
    error = `OKX returned 0 ${config.bar} candles`;
  } else if (config.useHtfFilter === true && (!htfCandles || htfCandles.length === 0)) {
    error = `OKX returned 0 ${config.htfBar} HTF candles`;
  }

  candleCache[symbol] = { candles, htfCandles, error };
  console.log(` ${candles.length} candles | HTF: ${htfCandles?.length ?? 0}`);
  if (error) {
    console.warn(`⚠ ${symbol} failed: ${error}`);
    process.exitCode = 1;
  }
}
console.log();

// ── Run backtest per profile × symbol ─────────────────────────────────────
const allSummaries = [];

for (const [profileName, profile] of Object.entries(config.strategyProfiles)) {
  const profileConfig = { ...config, ...profile, activeProfile: profileName };

  console.log(`── Profile: ${profileName.toUpperCase()} ──`);
  console.log(`   EMA: ${profile.emaFast}/${profile.emaSlow}  RSI: ${profile.minRsiForLong}–${profile.maxRsiForLong}  VolFactor: ${profile.minVolumeFactor}  ATR stop/take: ${profile.atrStopMultiplier}/${profile.atrTakeMultiplier}`);
  console.log();

  for (const symbol of config.symbols) {
    const { candles, htfCandles, error } = candleCache[symbol];
    if (error) {
      console.warn(`   ${symbol}: FAILED — ${error}`);
      continue;
    }

    const { trades, finalBalance, equity } = backtestSymbol(candles, htfCandles, profileConfig);
    const summary = buildSummary({ symbol, profileName, trades, finalBalance, equity });
    allSummaries.push(summary);

    console.log(`   ${symbol}`);
    console.log(`      Final Balance:  ${summary.finalBalance} USDT`);
    console.log(`      Total Trades:   ${summary.totalTrades}`);
    console.log(`      Wins/Losses:    ${summary.winCount}/${summary.lossCount}`);
    console.log(`      Win Rate:       ${summary.winRate}`);
    console.log(`      Net PnL:        ${summary.netPnl} USDT`);
    console.log(`      Fees:           ${summary.fees} USDT`);
    console.log(`      Profit Factor:  ${summary.profitFactor}`);
    console.log(`      Avg Trade:      ${summary.avgTrade} USDT`);
    console.log(`      Best Trade:     ${summary.bestTrade} USDT`);
    console.log(`      Worst Trade:    ${summary.worstTrade} USDT`);
    console.log(`      Max Drawdown:   ${summary.maxDrawdown} USDT`);
    console.log();
  }
}

// ── Overall ranking ────────────────────────────────────────────────────────
allSummaries.sort((a, b) => b.netPnl - a.netPnl);

console.log("=== Profile Ranking (by Net PnL) ===");
allSummaries.forEach((s, i) => {
  const arrow = s.netPnl > 0 ? "▲" : s.netPnl < 0 ? "▼" : "─";
  console.log(
    `${String(i + 1).padStart(2)}. ${s.profileName.padEnd(13)} ${s.symbol.padEnd(12)} ${arrow} ` +
    `Net PnL: ${String(s.netPnl).padStart(8)} USDT  |  ` +
    `Trades: ${String(s.totalTrades).padStart(3)}  |  ` +
    `Win Rate: ${String(s.winRate).padStart(6)}  |  ` +
    `PF: ${String(s.profitFactor).padStart(5)}  |  ` +
    `MaxDD: ${s.maxDrawdown} USDT`
  );
});

// ── Best overall ──────────────────────────────────────────────────────────
const best = allSummaries[0];
if (best) {
  console.log("\nBest profile overall:");
  console.log(`   Profile:       ${best.profileName}`);
  console.log(`   Symbol:        ${best.symbol}`);
  console.log(`   Net PnL:       ${best.netPnl} USDT`);
  console.log(`   Win Rate:      ${best.winRate}`);
  console.log(`   Profit Factor: ${best.profitFactor}`);
  console.log(`   Max Drawdown:  ${best.maxDrawdown} USDT`);
} else {
  console.error("\nNo valid profile results: candle loading failed for every symbol.");
  process.exitCode = 1;
}
