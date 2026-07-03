import fs from "node:fs";
import { config as baseConfig } from "../config.js";
import { fetchHistoricalCandles } from "../okxClient.js";
import { getSignal } from "../strategy.js";
import { calculateLongTrade } from "../riskManager.js";

const SYMBOL = "ETH-USDT";
const INITIAL_BALANCE = baseConfig.initialBalance ?? 1000;
const WINDOW_COUNT = 4;
const TARGET_5M_CANDLES = Number.parseInt(process.env.ETH_PORTFOLIO_CANDLES ?? "6000", 10);
const TARGET_HTF_CANDLES = Number.parseInt(process.env.ETH_PORTFOLIO_HTF_CANDLES ?? "1000", 10);

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function calcMaxDrawdown(equityCurve) {
  let peak = equityCurve[0] ?? INITIAL_BALANCE;
  let maxDrawdown = 0;

  for (const value of equityCurve) {
    if (value > peak) peak = value;
    maxDrawdown = Math.max(maxDrawdown, peak - value);
  }

  return round(maxDrawdown);
}

function closeTrade({ position, closePrice, closeReason, balance, feeRate }) {
  const { entryPrice, size } = position;
  const grossPnl = round((closePrice - entryPrice) * size);
  const fees = round((entryPrice + closePrice) * size * feeRate);
  const netPnl = round(grossPnl - fees);
  const nextBalance = round(balance + netPnl);

  return {
    balance: nextBalance,
    trade: {
      strategyKey: position.strategyKey,
      strategyLabel: position.strategyLabel,
      entryTime: position.entryTime,
      closeTime: position.closeTime,
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

function calcStats(trades, equity) {
  const wins = trades.filter((trade) => trade.netPnl > 0);
  const losses = trades.filter((trade) => trade.netPnl < 0);

  const netPnl = round(trades.reduce((sum, trade) => sum + trade.netPnl, 0));
  const winPnl = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
  const lossPnl = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnl, 0));

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? round((wins.length / trades.length) * 100, 1) : null,
    netPnl,
    profitFactor: lossPnl > 0 ? round(winPnl / lossPnl) : wins.length > 0 ? null : 0,
    maxDrawdown: calcMaxDrawdown(equity),
    fees: round(trades.reduce((sum, trade) => sum + trade.fees, 0)),
  };
}

function groupStatsByStrategy(trades) {
  const groups = {};

  for (const trade of trades) {
    if (!groups[trade.strategyKey]) groups[trade.strategyKey] = [];
    groups[trade.strategyKey].push(trade);
  }

  return Object.fromEntries(
    Object.entries(groups).map(([key, strategyTrades]) => [
      key,
      calcStats(strategyTrades, [INITIAL_BALANCE]),
    ])
  );
}

function buildStrategyConfig(setup) {
  return {
    ...baseConfig,
    symbol: SYMBOL,
    symbols: [SYMBOL],
    ...setup.overrides,
    activeStrategy: setup.strategyName,
    activeProfile: setup.profileName,
    paperOnly: true,
    useHtfFilter: true,
  };
}

function calcSpreadPct(fast, slow) {
  if (!Number.isFinite(fast) || !Number.isFinite(slow) || slow <= 0) return null;
  return ((fast - slow) / slow) * 100;
}

function calcReturnPct(candles, index, lookbackCandles) {
  if (!Array.isArray(candles) || index - lookbackCandles < 0) return null;

  const previousClose = candles[index - lookbackCandles]?.close;
  const currentClose = candles[index]?.close;

  if (!Number.isFinite(previousClose) || !Number.isFinite(currentClose) || previousClose <= 0) {
    return null;
  }

  return ((currentClose - previousClose) / previousClose) * 100;
}

function passesSetupFilters({ setup, signal, candles, index }) {
  const filters = setup.filters;
  if (!filters || !signal.indicators) return true;

  const indicators = signal.indicators;

  if (filters.minEmaSpreadPct != null) {
    const spread = calcSpreadPct(indicators.emaFast, indicators.emaSlow);
    if (spread == null || spread < filters.minEmaSpreadPct) return false;
  }

  if (filters.minHtfEmaSpreadPct != null) {
    const spread = calcSpreadPct(indicators.htfEmaFast, indicators.htfEmaSlow);
    if (spread == null || spread < filters.minHtfEmaSpreadPct) return false;
  }

  if (filters.minRsi != null) {
    if (indicators.rsi14 == null || indicators.rsi14 < filters.minRsi) return false;
  }

  if (filters.maxRsi != null) {
    if (indicators.rsi14 == null || indicators.rsi14 > filters.maxRsi) return false;
  }

  if (filters.minAtrPct != null || filters.maxAtrPct != null) {
    const atrPct =
      indicators.atr14 != null && indicators.lastClose > 0
        ? (indicators.atr14 / indicators.lastClose) * 100
        : null;

    if (filters.minAtrPct != null && (atrPct == null || atrPct < filters.minAtrPct)) {
      return false;
    }

    if (filters.maxAtrPct != null && (atrPct == null || atrPct > filters.maxAtrPct)) {
      return false;
    }
  }

  if (filters.minRet12hPct != null || filters.maxRet12hPct != null) {
    const ret12hPct = calcReturnPct(candles, index, 144);

    if (filters.minRet12hPct != null && (ret12hPct == null || ret12hPct < filters.minRet12hPct)) {
      return false;
    }

    if (filters.maxRet12hPct != null && (ret12hPct == null || ret12hPct > filters.maxRet12hPct)) {
      return false;
    }
  }

  if (filters.minRet24hPct != null || filters.maxRet24hPct != null) {
    const ret24hPct = calcReturnPct(candles, index, 288);

    if (filters.minRet24hPct != null && (ret24hPct == null || ret24hPct < filters.minRet24hPct)) {
      return false;
    }

    if (filters.maxRet24hPct != null && (ret24hPct == null || ret24hPct > filters.maxRet24hPct)) {
      return false;
    }
  }

  if (filters.minRet3dPct != null || filters.maxRet3dPct != null) {
    const ret3dPct = calcReturnPct(candles, index, 864);

    if (filters.minRet3dPct != null && (ret3dPct == null || ret3dPct < filters.minRet3dPct)) {
      return false;
    }

    if (filters.maxRet3dPct != null && (ret3dPct == null || ret3dPct > filters.maxRet3dPct)) {
      return false;
    }
  }

  return true;
}

function getHtfSlice(htfCandles, currentTime) {
  return htfCandles.filter((candle) => candle.time <= currentTime);
}

function backtestScenario({ candles, htfCandles, scenario }) {
  let balance = INITIAL_BALANCE;
  let openPosition = null;
  const trades = [];
  const equity = [INITIAL_BALANCE];

  const setups = [...scenario.setups].sort((a, b) => a.priority - b.priority);

  for (let i = 60; i < candles.length; i++) {
    const currentCandle = candles[i];

    if (openPosition) {
      const hitStop = currentCandle.low <= openPosition.stopPrice;
      const hitTake = currentCandle.high >= openPosition.takePrice;

      if (hitStop || hitTake) {
        openPosition.closeTime = currentCandle.time;

        const closePrice = hitStop ? openPosition.stopPrice : openPosition.takePrice;
        const closeReason = hitStop ? "STOP_LOSS" : "TAKE_PROFIT";

        const closed = closeTrade({
          position: openPosition,
          closePrice,
          closeReason,
          balance,
          feeRate: openPosition.feeRate,
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
    const htfSlice = getHtfSlice(htfCandles, currentTime);

    let selected = null;

    for (const setup of setups) {
      const testConfig = buildStrategyConfig(setup);

      const signal = getSignal({
        candles: historicalCandles,
        config: testConfig,
        htfCandles: htfSlice,
      });

      if (
        signal.action === "BUY" &&
        signal.indicators?.atr14 &&
        passesSetupFilters({ setup, signal, candles, index: i })
      ) {
        selected = {
          setup,
          signal,
          testConfig,
        };
        break;
      }
    }

    if (!selected) continue;

    const entryPrice = selected.signal.indicators.lastClose;
    const atr = selected.signal.indicators.atr14;

    const plannedTrade = calculateLongTrade({
      balance,
      entryPrice,
      atr,
      config: selected.testConfig,
    });

    if (plannedTrade.size > 0 && plannedTrade.positionValue > 0) {
      openPosition = {
        strategyKey: selected.setup.key,
        strategyLabel: selected.setup.label,
        entryTime: currentCandle.time,
        entryPrice: plannedTrade.entryPrice,
        stopPrice: plannedTrade.stopPrice,
        takePrice: plannedTrade.takePrice,
        size: plannedTrade.size,
        feeRate: selected.testConfig.feeRate,
      };
    }
  }

  if (openPosition && candles.length > 0) {
    const lastCandle = candles[candles.length - 1];
    openPosition.closeTime = lastCandle.time;

    const closed = closeTrade({
      position: openPosition,
      closePrice: lastCandle.close,
      closeReason: "END_OF_TEST",
      balance,
      feeRate: openPosition.feeRate,
    });

    balance = closed.balance;
    trades.push(closed.trade);
    equity.push(balance);
  }

  return {
    scenario: scenario.key,
    label: scenario.label,
    trades,
    stats: calcStats(trades, equity),
    byStrategy: groupStatsByStrategy(trades),
  };
}

function splitWindows(candles) {
  const size = Math.floor(candles.length / WINDOW_COUNT);
  const windows = [];

  for (let i = 0; i < WINDOW_COUNT; i++) {
    const start = i * size;
    const end = i === WINDOW_COUNT - 1 ? candles.length : start + size;
    windows.push(candles.slice(start, end));
  }

  return windows;
}

function validateByWindows({ candles, htfCandles, scenario }) {
  const windows = splitWindows(candles);

  const windowResults = windows.map((windowCandles, index) => {
    const result = backtestScenario({
      candles: windowCandles,
      htfCandles,
      scenario,
    });

    return {
      window: index + 1,
      startTime: new Date(windowCandles[0].time).toISOString(),
      endTime: new Date(windowCandles[windowCandles.length - 1].time).toISOString(),
      ...result.stats,
      byStrategy: result.byStrategy,
    };
  });

  const positiveWindows = windowResults.filter((item) => item.netPnl > 0).length;
  const windowsWithTrades = windowResults.filter((item) => item.trades > 0).length;
  const totalWindowTrades = windowResults.reduce((sum, item) => sum + item.trades, 0);
  const totalWindowPnl = round(windowResults.reduce((sum, item) => sum + item.netPnl, 0));
  const maxWindowDrawdown = round(Math.max(...windowResults.map((item) => item.maxDrawdown ?? 0)));

  return {
    windows: windowResults,
    windowSummary: {
      positiveWindows,
      windowsWithTrades,
      totalWindowTrades,
      totalWindowPnl,
      maxWindowDrawdown,
      candidate:
        totalWindowTrades >= 15 &&
        totalWindowPnl > 0 &&
        positiveWindows >= 3 &&
        windowsWithTrades >= 3 &&
        maxWindowDrawdown < 10,
    },
  };
}

function makeScenarios() {
  const breakoutStrong = {
    key: "breakoutStrong",
    label: "ETH breakoutRetest / strong trend",
    strategyName: "breakoutRetest",
    profileName: "aggressive",
    priority: 1,
    overrides: {
      ...baseConfig.strategyProfiles.aggressive,
      breakoutLookback: 30,
      breakoutRecentLookback: 10,
      breakoutBufferPct: 0.001,
      retestTolerancePct: 0.0025,
      breakoutRegimeEmaFast: 30,
      breakoutRegimeEmaSlow: 100,
      breakoutMinEmaSpreadPct: 0.2,
      breakoutMaxAtrPct: 0.3,
      breakoutMinRsi: 55,
    },
  };

  const pullbackSoft = {
    key: "pullbackSoft",
    label: "ETH trendPullback / soft trend",
    strategyName: "trendPullback",
    profileName: "custom-pullback-soft",
    priority: 2,
    overrides: {
      emaFast: 9,
      emaSlow: 21,
      minRsiForLong: 42,
      maxRsiForLong: 55,
      minVolumeFactor: 1,
      maxVolumeFactor: 1.5,
      atrStopMultiplier: 1.5,
      atrTakeMultiplier: 2.5,
      pullbackLookback: 8,
      pullbackTolerancePct: 0.002,
    },
  };

  const breakoutStrict = {
    ...breakoutStrong,
    key: "breakoutStrict",
    label: "ETH breakoutRetest / stricter strong trend",
    priority: 2,
    overrides: {
      ...breakoutStrong.overrides,
      breakoutMinEmaSpreadPct: 0.35,
      breakoutMaxAtrPct: 0.25,
      breakoutMinRsi: 58,
    },
  };

  const pullbackSoftFiltered = {
    ...pullbackSoft,
    key: "pullbackSoftFiltered",
    label: "ETH trendPullback / soft trend with regime filter",
    priority: 1,
    filters: {
      minRet3dPct: 1.5,
      maxRet24hPct: 5,
    },
  };

  const breakoutStrictFiltered = {
    ...breakoutStrict,
    key: "breakoutStrictFiltered",
    label: "ETH breakoutRetest / strict breakout with context filter",
    priority: 2,
    filters: {
      minRet3dPct: 1.5,
      maxRet24hPct: 5,
    },
  };

  return [
    {
      key: "breakout_only",
      label: "Breakout only",
      setups: [breakoutStrong],
    },
    {
      key: "pullback_only",
      label: "Pullback only",
      setups: [pullbackSoft],
    },
    {
      key: "portfolio_breakout_then_pullback",
      label: "Portfolio: breakout priority, then pullback",
      setups: [breakoutStrong, pullbackSoft],
    },
    {
      key: "portfolio_pullback_then_breakout",
      label: "Portfolio: pullback priority, then breakout",
      setups: [
        { ...pullbackSoft, priority: 1 },
        { ...breakoutStrong, priority: 2 },
      ],
    },
    {
      key: "portfolio_pullback_then_strict_breakout",
      label: "Portfolio: pullback priority, then strict breakout",
      setups: [
        { ...pullbackSoft, priority: 1 },
        { ...breakoutStrict, priority: 2 },
      ],
    },
    {
      key: "pullback_filtered_only",
      label: "Pullback filtered only",
      setups: [pullbackSoftFiltered],
    },
    {
      key: "portfolio_filtered_pullback_then_strict_breakout",
      label: "Portfolio: filtered pullback, then strict breakout",
      setups: [
        { ...pullbackSoftFiltered, priority: 1 },
        { ...breakoutStrict, priority: 2 },
      ],
    },
    {
      key: "portfolio_filtered_pullback_then_filtered_strict_breakout",
      label: "Portfolio: filtered pullback, then filtered strict breakout",
      setups: [
        { ...pullbackSoftFiltered, priority: 1 },
        { ...breakoutStrictFiltered, priority: 2 },
      ],
    },
  ];
}

function printResult(result) {
  const { stats, windowSummary } = result;

  console.log(
    `${result.label} | trades ${stats.trades} | pnl ${stats.netPnl} | ` +
    `PF ${stats.profitFactor ?? "N/A"} | win ${stats.winRate ?? "N/A"}% | ` +
    `DD ${stats.maxDrawdown} | windows +${windowSummary.positiveWindows}/4 | ` +
    `candidate ${windowSummary.candidate}`
  );

  if (Object.keys(result.byStrategy).length > 0) {
    for (const [key, item] of Object.entries(result.byStrategy)) {
      console.log(
        `  ${key}: trades ${item.trades}, pnl ${item.netPnl}, ` +
        `PF ${item.profitFactor ?? "N/A"}, win ${item.winRate ?? "N/A"}%`
      );
    }
  }

  for (const window of result.windows) {
    console.log(
      `  W${window.window}: trades ${window.trades}, pnl ${window.netPnl}, ` +
      `PF ${window.profitFactor ?? "N/A"}, win ${window.winRate ?? "N/A"}%, DD ${window.maxDrawdown}`
    );
  }
}

function writeReports(results) {
  fs.mkdirSync("reports", { recursive: true });

  fs.writeFileSync(
    "reports/eth-portfolio-research.json",
    JSON.stringify(results, null, 2)
  );

  const rows = [
    "scenario,trades,netPnl,pf,winRate,maxDD,positiveWindows,windowsWithTrades,totalWindowTrades,totalWindowPnl,maxWindowDD,candidate",
    ...results.map((item) => [
      item.scenario,
      item.stats.trades,
      item.stats.netPnl,
      item.stats.profitFactor ?? "N/A",
      item.stats.winRate ?? "N/A",
      item.stats.maxDrawdown,
      item.windowSummary.positiveWindows,
      item.windowSummary.windowsWithTrades,
      item.windowSummary.totalWindowTrades,
      item.windowSummary.totalWindowPnl,
      item.windowSummary.maxWindowDrawdown,
      item.windowSummary.candidate,
    ].join(",")),
  ];

  fs.writeFileSync("reports/eth-portfolio-research.csv", `${rows.join("\n")}\n`);
}

export async function runEthPortfolioResearch() {
  console.log("=== ZenBlade ETH Portfolio Research ===");
  console.log("Mode: research / paper only");
  console.log(`Symbol: ${SYMBOL}`);
  console.log(`Target 5m candles: ${TARGET_5M_CANDLES}`);
  console.log(`Target HTF candles: ${TARGET_HTF_CANDLES}`);
  console.log();

  console.log("Loading ETH 5m candles...");
  const candles = await fetchHistoricalCandles({
    symbol: SYMBOL,
    bar: baseConfig.bar,
    targetLimit: TARGET_5M_CANDLES,
  });

  console.log("Loading ETH 1H candles...");
  const htfCandles = await fetchHistoricalCandles({
    symbol: SYMBOL,
    bar: baseConfig.htfBar,
    targetLimit: TARGET_HTF_CANDLES,
  });

  console.log(`${SYMBOL}: ${candles.length} 5m candles | ${htfCandles.length} 1H candles`);
  console.log();

  if (candles.length === 0 || htfCandles.length === 0) {
    throw new Error("No candles loaded");
  }

  const scenarios = makeScenarios();

  const results = scenarios.map((scenario) => {
    const full = backtestScenario({
      candles,
      htfCandles,
      scenario,
    });

    const validation = validateByWindows({
      candles,
      htfCandles,
      scenario,
    });

    return {
      scenario: scenario.key,
      label: scenario.label,
      stats: full.stats,
      byStrategy: full.byStrategy,
      windows: validation.windows,
      windowSummary: validation.windowSummary,
    };
  });

  console.log("Results:");
  for (const result of results) {
    console.log();
    printResult(result);
  }

  writeReports(results);

  console.log();
  console.log("Reports:");
  console.log("- reports/eth-portfolio-research.json");
  console.log("- reports/eth-portfolio-research.csv");

  return results;
}
