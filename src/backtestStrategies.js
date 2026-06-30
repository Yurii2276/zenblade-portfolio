import { config } from "./config.js";
import { fetchHistoricalCandles } from "./okxClient.js";
import { getSignal } from "./strategy.js";
import { calculateLongTrade } from "./riskManager.js";

const INITIAL_BALANCE = 1000;

function calcMaxDrawdown(equityCurve) {
  let peak = equityCurve[0] ?? INITIAL_BALANCE;
  let maxDrawdown = 0;

  for (const value of equityCurve) {
    if (value > peak) peak = value;
    const drawdown = peak - value;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  return Math.round(maxDrawdown * 100) / 100;
}

function closeTrade({ position, closePrice, closeReason, balance, feeRate }) {
  const { entryPrice, size } = position;
  const grossPnl = Math.round((closePrice - entryPrice) * size * 100) / 100;
  const fees = Math.round((entryPrice + closePrice) * size * feeRate * 100) / 100;
  const netPnl = Math.round((grossPnl - fees) * 100) / 100;
  const nextBalance = Math.round((balance + netPnl) * 100) / 100;

  return {
    balance: nextBalance,
    trade: {
      entryPrice,
      closePrice,
      closeReason,
      size,
      grossPnl,
      fees,
      netPnl,
    },
  };
}

function backtestSymbol(candles, htfCandles, testConfig) {
  let balance = INITIAL_BALANCE;
  let openPosition = null;
  const trades = [];
  const equity = [INITIAL_BALANCE];

  for (let i = 60; i < candles.length; i++) {
    const currentCandle = candles[i];

    if (openPosition) {
      const hitStop = currentCandle.low <= openPosition.stopPrice;
      const hitTake = currentCandle.high >= openPosition.takePrice;

      if (hitStop || hitTake) {
        const closePrice = hitStop
          ? openPosition.stopPrice
          : openPosition.takePrice;
        const closeReason = hitStop ? "STOP_LOSS" : "TAKE_PROFIT";
        const closed = closeTrade({
          position: openPosition,
          closePrice,
          closeReason,
          balance,
          feeRate: testConfig.feeRate,
        });

        balance = closed.balance;
        trades.push(closed.trade);
        equity.push(balance);
        openPosition = null;
      }
      continue;
    }

    const historicalCandles = candles.slice(0, i + 1);
    const currentTime = currentCandle.time;
    const htfSlice = htfCandles?.filter((c) => c.time <= currentTime) ?? null;
    const signal = getSignal({
      candles: historicalCandles,
      config: testConfig,
      htfCandles: htfSlice,
    });

    if (signal.action === "BUY" && signal.indicators) {
      const trade = calculateLongTrade({
        balance,
        entryPrice: signal.indicators.lastClose,
        atr: signal.indicators.atr14,
        config: testConfig,
      });

      if (trade.size > 0 && trade.positionValue > 0) {
        openPosition = {
          entryPrice: trade.entryPrice,
          stopPrice: trade.stopPrice,
          takePrice: trade.takePrice,
          size: trade.size,
        };
      }
    }
  }

  if (openPosition && candles.length > 0) {
    const closed = closeTrade({
      position: openPosition,
      closePrice: candles[candles.length - 1].close,
      closeReason: "END_OF_TEST",
      balance,
      feeRate: testConfig.feeRate,
    });

    balance = closed.balance;
    trades.push(closed.trade);
    equity.push(balance);
  }

  return { trades, finalBalance: balance, equity };
}

function buildSummary({
  strategyName,
  profileName,
  symbol,
  trades,
  finalBalance,
  equity,
}) {
  const wins = trades.filter((trade) => trade.netPnl > 0);
  const losses = trades.filter((trade) => trade.netPnl < 0);
  const netPnl = Math.round(
    trades.reduce((sum, trade) => sum + trade.netPnl, 0) * 100
  ) / 100;
  const totalWinPnl = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
  const totalLossPnl = Math.abs(
    losses.reduce((sum, trade) => sum + trade.netPnl, 0)
  );

  return {
    strategyName,
    profileName,
    symbol,
    totalTrades: trades.length,
    winRate: trades.length > 0
      ? `${((wins.length / trades.length) * 100).toFixed(1)}%`
      : "N/A",
    netPnl,
    profitFactor: totalLossPnl > 0
      ? Math.round((totalWinPnl / totalLossPnl) * 100) / 100
      : "N/A",
    maxDrawdown: calcMaxDrawdown(equity),
    finalBalance,
  };
}

const enabledStrategies = Object.entries(config.strategies)
  .filter(([, strategy]) => strategy.enabled === true);

console.log("=== ZenBlade Backtest: Multiple Strategies ===");
console.log(`Strategies: ${enabledStrategies.map(([name]) => name).join(", ")}`);
console.log(`Profiles:   ${Object.keys(config.strategyProfiles).join(", ")}`);
console.log(`Symbols:    ${config.symbols.join(", ")}`);
console.log(`5m target:  ${config.backtestCandlesLimit} | HTF target: ${config.htfCandlesLimit}`);
console.log();

const candleCache = {};

for (const symbol of config.symbols) {
  process.stdout.write(`Loading candles for ${symbol}...`);
  const candles = await fetchHistoricalCandles({
    symbol,
    bar: config.bar,
    targetLimit: config.backtestCandlesLimit,
  });
  const htfCandles = config.useHtfFilter === true
    ? await fetchHistoricalCandles({
        symbol,
        bar: config.htfBar,
        targetLimit: config.htfCandlesLimit,
      })
    : null;

  let error = null;
  if (candles.length === 0) {
    error = `OKX returned 0 ${config.bar} candles`;
  } else if (
    config.useHtfFilter === true &&
    (!htfCandles || htfCandles.length === 0)
  ) {
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
console.log(
  "Strategy".padEnd(16) +
  "Profile".padEnd(14) +
  "Symbol".padEnd(12) +
  "Trades".padStart(8) +
  "Win Rate".padStart(12) +
  "Net PnL".padStart(14) +
  "PF".padStart(9) +
  "Max DD".padStart(12)
);
console.log("-".repeat(97));

const allSummaries = [];

for (const [strategyName] of enabledStrategies) {
  for (const [profileName, profile] of Object.entries(config.strategyProfiles)) {
    const testConfig = {
      ...config,
      ...profile,
      activeProfile: profileName,
      activeStrategy: strategyName,
    };

    for (const symbol of config.symbols) {
      const { candles, htfCandles, error } = candleCache[symbol];
      if (error) {
        console.warn(`${strategyName}/${profileName}/${symbol}: FAILED — ${error}`);
        continue;
      }

      const result = backtestSymbol(candles, htfCandles, testConfig);
      const summary = buildSummary({
        strategyName,
        profileName,
        symbol,
        ...result,
      });
      allSummaries.push(summary);

      console.log(
        strategyName.padEnd(16) +
        profileName.padEnd(14) +
        symbol.padEnd(12) +
        String(summary.totalTrades).padStart(8) +
        String(summary.winRate).padStart(12) +
        String(summary.netPnl).padStart(14) +
        String(summary.profitFactor).padStart(9) +
        String(summary.maxDrawdown).padStart(12)
      );
    }
  }
}

allSummaries.sort((a, b) => b.netPnl - a.netPnl);

console.log("\n=== Strategy Ranking ===");
allSummaries.forEach((summary, index) => {
  console.log(
    `${String(index + 1).padStart(2)}. ` +
    `${summary.strategyName.padEnd(16)} ` +
    `${summary.profileName.padEnd(13)} ` +
    `${summary.symbol.padEnd(12)} | ` +
    `Net PnL: ${String(summary.netPnl).padStart(7)} USDT | ` +
    `Trades: ${String(summary.totalTrades).padStart(3)} | ` +
    `Win Rate: ${String(summary.winRate).padStart(6)} | ` +
    `PF: ${String(summary.profitFactor).padStart(5)} | ` +
    `MaxDD: ${summary.maxDrawdown} USDT`
  );
});

const best = allSummaries[0];

if (best) {
  console.log("\nBest strategy overall:");
  console.log(`Strategy:      ${best.strategyName}`);
  console.log(`Profile:       ${best.profileName}`);
  console.log(`Symbol:        ${best.symbol}`);
  console.log(`Net PnL:       ${best.netPnl} USDT`);
  console.log(`Trades:        ${best.totalTrades}`);
  console.log(`Win Rate:      ${best.winRate}`);
  console.log(`Profit Factor: ${best.profitFactor}`);
  console.log(`Max Drawdown:  ${best.maxDrawdown} USDT`);
} else {
  console.error("\nNo valid strategy results: candle loading failed for every symbol.");
  process.exitCode = 1;
}
