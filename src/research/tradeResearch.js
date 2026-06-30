import { config } from "../config.js";
import { fetchHistoricalCandles } from "../okxClient.js";
import { calculateLongTrade } from "../riskManager.js";
import { getSignal } from "../strategy.js";
import { analyzeMarketRegime } from "./marketRegime.js";

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function volumeRatioBucket(value) {
  if (value === null || value === undefined) return "N/A";
  if (value < 0.8) return "<0.8";
  if (value <= 1.0) return "0.8–1.0";
  if (value <= 1.2) return "1.0–1.2";
  return ">1.2";
}

function rsiBucket(value) {
  if (value === null || value === undefined) return "N/A";
  if (value < 45) return "<45";
  if (value <= 50) return "45–50";
  if (value <= 55) return "50–55";
  if (value <= 60) return "55–60";
  if (value <= 65) return "60–65";
  return ">65";
}

function atrPctBucket(value) {
  if (value === null || value === undefined) return "N/A";
  if (value < 0.25) return "<0.25";
  if (value <= 0.5) return "0.25–0.5";
  if (value <= 0.8) return "0.5–0.8";
  return ">0.8";
}

function createTrade({
  position,
  exitTime,
  exitPrice,
  exitReason,
  feeRate,
}) {
  const grossPnl = round(
    (exitPrice - position.entryPrice) * position.size
  );
  const fees = round(
    (position.entryPrice + exitPrice) * position.size * feeRate
  );
  const netPnl = round(grossPnl - fees);

  return {
    strategy: position.strategy,
    profile: position.profile,
    symbol: position.symbol,
    entryTime: new Date(position.entryTime).toISOString(),
    exitTime: new Date(exitTime).toISOString(),
    exitReason,
    entryPrice: position.entryPrice,
    exitPrice,
    netPnl,
    grossPnl,
    fees,
    regime: position.snapshot.regime,
    rsi14: position.snapshot.rsi14,
    atrPct: position.snapshot.atrPct,
    volumeRatio: position.snapshot.volumeRatio,
    emaDistancePct: position.snapshot.emaDistancePct,
    emaSpreadPct: position.snapshot.emaSpreadPct,
    htfTrendOk: position.snapshot.htfTrendOk,
    holdingCandles: position.holdingCandles,
    mfe: round(position.mfe),
    mae: round(position.mae),
  };
}

function researchCombination({
  strategyName,
  profileName,
  symbol,
  candles,
  htfCandles,
  testConfig,
}) {
  let balance = testConfig.initialBalance;
  let openPosition = null;
  const trades = [];

  for (let i = 60; i < candles.length; i++) {
    const currentCandle = candles[i];

    if (openPosition) {
      openPosition.holdingCandles = i - openPosition.entryIndex;
      openPosition.mfe = Math.max(
        openPosition.mfe,
        (currentCandle.high - openPosition.entryPrice) * openPosition.size
      );
      openPosition.mae = Math.max(
        openPosition.mae,
        (openPosition.entryPrice - currentCandle.low) * openPosition.size
      );

      const hitStop = currentCandle.low <= openPosition.stopPrice;
      const hitTake = currentCandle.high >= openPosition.takePrice;

      if (hitStop || hitTake) {
        const exitPrice = hitStop
          ? openPosition.stopPrice
          : openPosition.takePrice;
        const exitReason = hitStop ? "STOP_LOSS" : "TAKE_PROFIT";
        const trade = createTrade({
          position: openPosition,
          exitTime: currentCandle.time,
          exitPrice,
          exitReason,
          feeRate: testConfig.feeRate,
        });

        trades.push(trade);
        balance = round(balance + trade.netPnl);
        openPosition = null;
      }
      continue;
    }

    const historicalCandles = candles.slice(0, i + 1);
    const htfSlice = htfCandles?.filter(
      (candle) => candle.time <= currentCandle.time
    ) ?? null;
    const signal = getSignal({
      candles: historicalCandles,
      config: testConfig,
      htfCandles: htfSlice,
    });

    if (signal.action !== "BUY" || !signal.indicators) {
      continue;
    }

    const plannedTrade = calculateLongTrade({
      balance,
      entryPrice: signal.indicators.lastClose,
      atr: signal.indicators.atr14,
      config: testConfig,
    });

    if (plannedTrade.size <= 0 || plannedTrade.positionValue <= 0) {
      continue;
    }

    const snapshot = analyzeMarketRegime({
      candles: historicalCandles,
      htfCandles: htfSlice,
      config: testConfig,
    });

    openPosition = {
      strategy: strategyName,
      profile: profileName,
      symbol,
      entryIndex: i,
      entryTime: currentCandle.time,
      entryPrice: plannedTrade.entryPrice,
      stopPrice: plannedTrade.stopPrice,
      takePrice: plannedTrade.takePrice,
      size: plannedTrade.size,
      snapshot,
      holdingCandles: 0,
      mfe: 0,
      mae: 0,
    };
  }

  if (openPosition && candles.length > 0) {
    const lastIndex = candles.length - 1;
    const lastCandle = candles[lastIndex];
    openPosition.holdingCandles = lastIndex - openPosition.entryIndex;
    const trade = createTrade({
      position: openPosition,
      exitTime: lastCandle.time,
      exitPrice: lastCandle.close,
      exitReason: "END_OF_TEST",
      feeRate: testConfig.feeRate,
    });
    trades.push(trade);
  }

  return trades;
}

function summarizeGroup(groupType, groupName, trades) {
  const wins = trades.filter((trade) => trade.netPnl > 0);
  const losses = trades.filter((trade) => trade.netPnl < 0);
  const netPnl = trades.reduce((sum, trade) => sum + trade.netPnl, 0);
  const totalWinPnl = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
  const totalLossPnl = Math.abs(
    losses.reduce((sum, trade) => sum + trade.netPnl, 0)
  );

  return {
    groupType,
    groupName,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: round((wins.length / trades.length) * 100),
    netPnl: round(netPnl),
    avgTrade: round(netPnl / trades.length),
    profitFactor: totalLossPnl > 0
      ? round(totalWinPnl / totalLossPnl)
      : null,
    avgMfe: round(
      trades.reduce((sum, trade) => sum + trade.mfe, 0) / trades.length
    ),
    avgMae: round(
      trades.reduce((sum, trade) => sum + trade.mae, 0) / trades.length
    ),
  };
}

export function aggregateTrades(trades) {
  const groups = new Map();
  const definitions = [
    ["strategy", (trade) => trade.strategy],
    [
      "strategyProfile",
      (trade) => `${trade.strategy} | ${trade.profile}`,
    ],
    [
      "strategySymbol",
      (trade) => `${trade.strategy} | ${trade.symbol}`,
    ],
    ["regime", (trade) => trade.regime],
    ["exitReason", (trade) => trade.exitReason],
    ["volumeRatio", (trade) => volumeRatioBucket(trade.volumeRatio)],
    ["rsi", (trade) => rsiBucket(trade.rsi14)],
    ["atrPct", (trade) => atrPctBucket(trade.atrPct)],
  ];

  for (const trade of trades) {
    for (const [groupType, getGroupName] of definitions) {
      const groupName = getGroupName(trade);
      const key = `${groupType}\u0000${groupName}`;
      if (!groups.has(key)) {
        groups.set(key, { groupType, groupName, trades: [] });
      }
      groups.get(key).trades.push(trade);
    }
  }

  return Array.from(groups.values()).map((group) =>
    summarizeGroup(group.groupType, group.groupName, group.trades)
  );
}

function buildRecommendations(trades, groupedSummaries) {
  const recommendations = [];
  const findGroup = (groupType, groupName) =>
    groupedSummaries.find(
      (group) =>
        group.groupType === groupType &&
        group.groupName === groupName
    );

  const rangeGroup = findGroup("regime", "RANGE");
  if (
    rangeGroup &&
    rangeGroup.netPnl < 0 &&
    rangeGroup.profitFactor !== null &&
    rangeGroup.profitFactor < 1
  ) {
    recommendations.push({
      rule: "avoid-range",
      message: "Уникати входів у RANGE market або додати жорсткіший regime-фільтр.",
      evidence: rangeGroup,
    });
  }

  const weakVolumeGroups = ["<0.8", "0.8–1.0"]
    .map((name) => findGroup("volumeRatio", name))
    .filter(Boolean);
  const weakVolumeNetPnl = weakVolumeGroups.reduce(
    (sum, group) => sum + group.netPnl,
    0
  );
  if (weakVolumeGroups.length > 0 && weakVolumeNetPnl < 0) {
    recommendations.push({
      rule: "raise-min-volume",
      message: "Розглянути підвищення minVolumeFactor: входи з volumeRatio < 1.0 збиткові.",
      evidence: {
        groups: weakVolumeGroups.map((group) => group.groupName),
        netPnl: round(weakVolumeNetPnl),
      },
    });
  }

  const highRsiGroup = findGroup("rsi", ">65");
  if (highRsiGroup && highRsiGroup.netPnl < 0) {
    recommendations.push({
      rule: "lower-max-rsi",
      message: "Розглянути зменшення maxRsiForLong: RSI > 65 має негативний результат.",
      evidence: highRsiGroup,
    });
  }

  const highAtrGroup = findGroup("atrPct", ">0.8");
  if (highAtrGroup && highAtrGroup.netPnl < 0) {
    recommendations.push({
      rule: "avoid-high-volatility",
      message: "Уникати atrPct > 0.8 або окремо дослідити ширший stop для high volatility.",
      evidence: highAtrGroup,
    });
  }

  const strategySymbolGroups = groupedSummaries.filter(
    (group) => group.groupType === "strategySymbol"
  );
  const symbolResults = new Map();
  for (const group of strategySymbolGroups) {
    const symbol = group.groupName.split(" | ")[1];
    if (!symbolResults.has(symbol)) symbolResults.set(symbol, []);
    symbolResults.get(symbol).push(group);
  }

  const consistentlyNegativeSymbols = Array.from(symbolResults.entries())
    .filter(([, groups]) =>
      groups.length > 0 && groups.every((group) => group.netPnl < 0)
    )
    .map(([symbol, groups]) => ({
      symbol,
      netPnl: round(groups.reduce((sum, group) => sum + group.netPnl, 0)),
      groups: groups.length,
    }))
    .sort((a, b) => a.netPnl - b.netPnl);

  if (consistentlyNegativeSymbols.length > 0) {
    const worstSymbol = consistentlyNegativeSymbols[0];
    recommendations.push({
      rule: "exclude-worst-symbol",
      message: `Тимчасово виключити ${worstSymbol.symbol} або дослідити його окремо: обидві стратегії збиткові.`,
      evidence: worstSymbol,
    });
  }

  for (const strategyGroup of groupedSummaries.filter(
    (group) => group.groupType === "strategy"
  )) {
    if (strategyGroup.trades < 30) {
      recommendations.push({
        rule: "statistically-weak",
        message: `${strategyGroup.groupName}: лише ${strategyGroup.trades} угод, результат статистично слабкий.`,
        evidence: strategyGroup,
      });
    }
  }

  if (recommendations.length === 0) {
    recommendations.push({
      rule: "no-strong-rule",
      message: "Автоматичні правила не виявили достатньо сильного сигналу для зміни параметрів.",
      evidence: null,
    });
  }

  return recommendations;
}

export async function runTradeResearch({ onProgress = () => {} } = {}) {
  const enabledStrategies = Object.entries(config.strategies)
    .filter(([, strategy]) => strategy.enabled === true);
  const candleCache = {};
  const errors = [];

  for (const symbol of config.symbols) {
    onProgress(`Loading ${symbol} ${config.bar} and ${config.htfBar} candles...`);
    const candles = await fetchHistoricalCandles({
      symbol,
      bar: config.bar,
      targetLimit: config.backtestCandlesLimit,
    });
    const htfCandles = await fetchHistoricalCandles({
      symbol,
      bar: config.htfBar,
      targetLimit: config.htfCandlesLimit,
    });

    let error = null;
    if (candles.length === 0) {
      error = `OKX returned 0 ${config.bar} candles`;
    } else if (htfCandles.length === 0) {
      error = `OKX returned 0 ${config.htfBar} candles`;
    }

    candleCache[symbol] = { candles, htfCandles, error };
    if (error) errors.push({ symbol, error });
    onProgress(
      `${symbol}: ${candles.length} ${config.bar} | ${htfCandles.length} ${config.htfBar}`
    );
  }

  const trades = [];

  for (const [strategyName] of enabledStrategies) {
    for (const [profileName, profile] of Object.entries(config.strategyProfiles)) {
      const testConfig = {
        ...config,
        ...profile,
        activeStrategy: strategyName,
        activeProfile: profileName,
      };

      for (const symbol of config.symbols) {
        const cached = candleCache[symbol];
        if (cached.error) continue;

        trades.push(...researchCombination({
          strategyName,
          profileName,
          symbol,
          candles: cached.candles,
          htfCandles: cached.htfCandles,
          testConfig,
        }));
      }
    }
  }

  const groupedSummaries = aggregateTrades(trades);
  const topWinningGroups = groupedSummaries
    .filter((group) => group.netPnl > 0)
    .sort((a, b) => b.netPnl - a.netPnl)
    .slice(0, 10);
  const worstLosingGroups = groupedSummaries
    .filter((group) => group.netPnl < 0)
    .sort((a, b) => a.netPnl - b.netPnl)
    .slice(0, 10);
  const recommendations = buildRecommendations(trades, groupedSummaries);

  return {
    trades,
    groupedSummaries,
    topWinningGroups,
    worstLosingGroups,
    recommendations,
    errors,
  };
}
