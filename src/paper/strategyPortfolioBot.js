import fs from "node:fs";
import path from "node:path";
import { config as baseConfig } from "../config.js";
import { fetchHistoricalCandles } from "../okxClient.js";
import { getSignal } from "../strategy.js";
import { sendTelegramMessage } from "../telegram.js";

const STATE_PATH = path.resolve("data/strategy-paper-state.json");
const TRADES_PATH = path.resolve("data/strategy-paper-trades.json");

const STATUS_INTERVAL_HOURS = Number.parseFloat(process.env.PAPER_STATUS_HOURS ?? "6");
const LOG_WAIT = process.env.PAPER_LOG_WAIT === "true";

const DEFAULT_STATE = {
  balance: baseConfig.initialBalance ?? 1000,
  openPositions: [],
  lastProcessedCandleByKey: {},
  usedSignalKeys: {},
  lastStatusAt: null,
};

const STRATEGIES = [
  {
    strategyId: "ethPullbackContext",
    strategyName: "ETH Pullback Context",
    strategyEngine: "trendPullback",
    symbols: ["ETH-USDT"],
    side: "LONG",
    bar: "5m",
    candlesLimit: 1200,
    htfBar: "1H",
    htfCandlesLimit: 500,
    maxHoldHours: 48,
    overrides: {
      ...baseConfig.strategyProfiles.aggressive,
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
      useHtfFilter: true,
    },
    filters: {
      minRet3dPct: 1.5,
      maxRet24hPct: 5,
    },
  },
  {
    strategyId: "qorbBasket",
    strategyName: "QORB Pump Reversal Basket",
    strategyEngine: "qorbPumpReversalShort",
    symbols: baseConfig.qorbBasketSymbols ?? [],
    side: "SHORT",
    bar: "1H",
    candlesLimit: 3000,
    htfBar: null,
    htfCandlesLimit: 0,
    maxHoldHours: baseConfig.qorbMaxHoldHours ?? 72,
    overrides: {
      qorbMinPumpWeak: 12,
      qorbMinVolumeSpike: 1.3,
      qorbMinOpenScore: 35,
      qorbMinVolumeUSDT: 50000,
      useHtfFilter: false,
    },
    filters: {},
  },
];

function ensureDataDir() {
  fs.mkdirSync("data", { recursive: true });
}

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return structuredClone(fallback);
  }
}

function saveJson(filePath, data) {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function loadState() {
  ensureDataDir();
  const state = loadJson(STATE_PATH, DEFAULT_STATE);

  return {
    ...DEFAULT_STATE,
    ...state,
    openPositions: Array.isArray(state.openPositions) ? state.openPositions : [],
    lastProcessedCandleByKey: state.lastProcessedCandleByKey ?? {},
    usedSignalKeys: state.usedSignalKeys ?? {},
    lastStatusAt: state.lastStatusAt ?? null,
  };
}

function loadTrades() {
  ensureDataDir();
  return loadJson(TRADES_PATH, []);
}

function saveAll(state, trades) {
  saveJson(STATE_PATH, state);
  saveJson(TRADES_PATH, trades);
}

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function roundPrice(value) {
  if (!Number.isFinite(value)) return 0;
  if (value >= 100) return round(value, 2);
  if (value >= 1) return round(value, 4);
  if (value >= 0.01) return round(value, 6);
  return round(value, 8);
}

function calcReturnPct(candles, lookbackCandles) {
  if (!Array.isArray(candles) || candles.length <= lookbackCandles) return null;

  const current = candles[candles.length - 1]?.close;
  const previous = candles[candles.length - 1 - lookbackCandles]?.close;

  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) {
    return null;
  }

  return ((current - previous) / previous) * 100;
}

function passesExtraFilters(strategy, signal, candles) {
  const filters = strategy.filters ?? {};
  if (!signal.indicators) return false;

  if (filters.minRet3dPct != null) {
    const ret3d = calcReturnPct(candles, 864);
    if (ret3d == null || ret3d < filters.minRet3dPct) return false;
  }

  if (filters.maxRet24hPct != null) {
    const ret24h = calcReturnPct(candles, 288);
    if (ret24h == null || ret24h > filters.maxRet24hPct) return false;
  }

  return true;
}

function buildConfig(strategy, symbol) {
  return {
    ...baseConfig,
    ...strategy.overrides,
    symbol,
    symbols: [symbol],
    bar: strategy.bar,
    candlesLimit: strategy.candlesLimit,
    htfBar: strategy.htfBar ?? baseConfig.htfBar,
    htfCandlesLimit: strategy.htfCandlesLimit ?? baseConfig.htfCandlesLimit,
    activeStrategy: strategy.strategyEngine,
    paperOnly: true,
    mode: "paper",
  };
}

function positionKey(strategyId, symbol) {
  return `${strategyId}:${symbol}`;
}

function signalKey(strategy, symbol, signal, lastCandle) {
  if (strategy.strategyId === "qorbBasket" && signal.indicators?.eventKey) {
    return `${strategy.strategyId}:${symbol}:${signal.indicators.eventKey}`;
  }

  return `${strategy.strategyId}:${symbol}:${lastCandle.time}`;
}

function hasOpenPosition(state, strategyId, symbol) {
  return state.openPositions.some(
    (position) =>
      position.status === "OPEN" &&
      position.strategyId === strategyId &&
      position.symbol === symbol
  );
}

function planPosition({ strategy, symbol, signal, candles, config, balance }) {
  const lastCandle = candles[candles.length - 1];
  const entryPrice = roundPrice(signal.indicators?.lastClose ?? signal.indicators?.currentClose ?? lastCandle.close);
  const feeRate = config.feeRate ?? 0.0008;
  const riskAmount = round(balance * (config.riskPerTrade ?? 0.01), 4);
  const maxPositionValue = round(balance * (config.maxPositionValuePct ?? 0.3), 4);

  let stopPrice;
  let takePrice;

  if (strategy.side === "LONG") {
    const atr = signal.indicators?.atr14;
    if (!Number.isFinite(atr) || atr <= 0) return null;

    stopPrice = roundPrice(entryPrice - atr * (config.atrStopMultiplier ?? 1.2));
    takePrice = roundPrice(entryPrice + atr * (config.atrTakeMultiplier ?? 1.8));
  } else {
    const slPct = config.qorbSlPct ?? 10;
    const tpPct = config.qorbTpPct ?? 15;

    stopPrice = roundPrice(entryPrice * (1 + slPct / 100));
    takePrice = roundPrice(entryPrice * (1 - tpPct / 100));
  }

  const riskPerUnit =
    strategy.side === "LONG"
      ? entryPrice - stopPrice
      : stopPrice - entryPrice;

  if (!Number.isFinite(riskPerUnit) || riskPerUnit <= 0) return null;

  let size = riskAmount / riskPerUnit;
  let positionValue = size * entryPrice;

  if (positionValue > maxPositionValue) {
    positionValue = maxPositionValue;
    size = positionValue / entryPrice;
  }

  size = round(size, 6);
  positionValue = round(positionValue, 4);

  if (size <= 0 || positionValue <= 0) return null;

  return {
    id: `${strategy.strategyId}:${symbol}:${Date.now()}`,
    strategyId: strategy.strategyId,
    strategyName: strategy.strategyName,
    strategyEngine: strategy.strategyEngine,
    symbol,
    side: strategy.side,
    status: "OPEN",
    mode: "paper",
    entryPrice,
    stopPrice,
    takePrice,
    size,
    positionValue,
    riskAmount,
    feeRate,
    openedAt: new Date().toISOString(),
    openedCandleTime: lastCandle.time,
    maxHoldHours: strategy.maxHoldHours,
    signalReason: signal.reason,
    signalIndicators: signal.indicators,
  };
}

function shouldClosePosition(position, candle) {
  const ageMs = Date.now() - new Date(position.openedAt).getTime();
  const ageHours = ageMs / (60 * 60 * 1000);

  if (position.maxHoldHours && ageHours >= position.maxHoldHours) {
    return {
      reason: "MAX_HOLD",
      exitPrice: roundPrice(candle.close),
    };
  }

  if (position.side === "LONG") {
    if (candle.low <= position.stopPrice) {
      return { reason: "STOP_LOSS", exitPrice: position.stopPrice };
    }

    if (candle.high >= position.takePrice) {
      return { reason: "TAKE_PROFIT", exitPrice: position.takePrice };
    }
  }

  if (position.side === "SHORT") {
    if (candle.high >= position.stopPrice) {
      return { reason: "STOP_LOSS", exitPrice: position.stopPrice };
    }

    if (candle.low <= position.takePrice) {
      return { reason: "TAKE_PROFIT", exitPrice: position.takePrice };
    }
  }

  return null;
}

function closePosition({ position, exitPrice, reason, balance }) {
  const grossPnl =
    position.side === "LONG"
      ? (exitPrice - position.entryPrice) * position.size
      : (position.entryPrice - exitPrice) * position.size;

  const fees = (position.entryPrice + exitPrice) * position.size * position.feeRate;
  const netPnl = round(grossPnl - fees);
  const nextBalance = round(balance + netPnl);

  return {
    nextBalance,
    trade: {
      ...position,
      status: "CLOSED",
      exitPrice,
      exitRule: reason,
      closedAt: new Date().toISOString(),
      grossPnl: round(grossPnl),
      fees: round(fees),
      netPnl,
      balanceAfterClose: nextBalance,
    },
  };
}

function tradeNetPnl(trade) {
  return Number(trade.netPnl ?? trade.netPnlUsdt ?? 0);
}

function tradeGrossPnl(trade) {
  return Number(trade.grossPnl ?? trade.grossPnlUsdt ?? 0);
}

function tradeFees(trade) {
  return Number(trade.fees ?? trade.feeUsdt ?? 0);
}

function sumNetPnl(trades) {
  return trades.reduce((sum, trade) => sum + tradeNetPnl(trade), 0);
}

function buildTradeStats(trades) {
  const stats = {
    count: trades.length,
    wins: 0,
    losses: 0,
    breakeven: 0,
    grossPnl: 0,
    fees: 0,
    netPnl: 0,
    winrate: 0,
  };

  for (const trade of trades) {
    const netPnl = tradeNetPnl(trade);

    stats.netPnl += netPnl;
    stats.grossPnl += tradeGrossPnl(trade);
    stats.fees += tradeFees(trade);

    if (netPnl > 0) stats.wins += 1;
    else if (netPnl < 0) stats.losses += 1;
    else stats.breakeven += 1;
  }

  stats.winrate = stats.count > 0 ? round((stats.wins / stats.count) * 100, 1) : 0;

  return stats;
}

function groupPnlByStrategy(trades) {
  const grouped = new Map();

  for (const trade of trades) {
    const key = trade.strategyName ?? trade.strategy ?? trade.strategyId ?? "Unknown strategy";
    const current =
      grouped.get(key) ?? {
        count: 0,
        wins: 0,
        losses: 0,
        breakeven: 0,
        grossPnl: 0,
        fees: 0,
        netPnl: 0,
      };

    const netPnl = tradeNetPnl(trade);

    current.count += 1;
    current.netPnl += netPnl;
    current.grossPnl += tradeGrossPnl(trade);
    current.fees += tradeFees(trade);

    if (netPnl > 0) current.wins += 1;
    else if (netPnl < 0) current.losses += 1;
    else current.breakeven += 1;

    grouped.set(key, current);
  }

  return [...grouped.entries()]
    .map(([strategy, value]) => {
      const sign = value.netPnl >= 0 ? "+" : "";
      const winrate = value.count > 0 ? round((value.wins / value.count) * 100, 1) : 0;

      return `- ${strategy}: ${value.count} trades, net ${sign}${round(value.netPnl, 2)} USDT, winrate ${winrate}%, fees ${round(value.fees, 2)} USDT`;
    })
    .join("\n");
}

function formatLastTrades(trades, limit = 3) {
  if (!trades.length) return "- no closed trades yet";

  return trades
    .slice(-limit)
    .reverse()
    .map((trade) => {
      const strategy = trade.strategyName ?? trade.strategy ?? trade.strategyId ?? "Unknown strategy";
      const symbol = trade.symbol ?? trade.asset ?? "UNKNOWN";
      const side = trade.side ?? "UNKNOWN";
      const exitRule = trade.exitRule ?? trade.reasonExit ?? "UNKNOWN_EXIT";
      const netPnl = tradeNetPnl(trade);
      const sign = netPnl >= 0 ? "+" : "";

      return `- ${symbol} | ${side} | ${exitRule} | ${sign}${round(netPnl, 2)} USDT | ${strategy}`;
    })
    .join("\n");
}

function formatStrategyHealth(trades) {
  const grouped = new Map();

  for (const trade of trades) {
    const key = trade.strategyName ?? trade.strategy ?? trade.strategyId ?? "Unknown strategy";
    const current = grouped.get(key) ?? { count: 0, wins: 0, losses: 0, netPnl: 0 };
    const netPnl = tradeNetPnl(trade);

    current.count += 1;
    current.netPnl += netPnl;

    if (netPnl > 0) current.wins += 1;
    if (netPnl < 0) current.losses += 1;

    grouped.set(key, current);
  }

  if (!grouped.size) return "- no closed trades yet";

  return [...grouped.entries()]
    .map(([strategy, value]) => {
      let status = "not enough data";

      if (value.count >= 5) {
        if (value.netPnl > 0 && value.wins >= value.losses) status = "profitable";
        else if (value.netPnl < 0 && value.losses > value.wins) status = "losing";
        else status = "mixed";
      }

      return `- ${strategy}: ${status} (${value.count} trades)`;
    })
    .join("\n");
}

async function notifyStatusIfDue(state, trades) {
  if (!baseConfig.telegramEnabled) return;

  const lastStatusMs = state.lastStatusAt ? Date.parse(state.lastStatusAt) : 0;
  const ageHours = lastStatusMs ? (Date.now() - lastStatusMs) / (60 * 60 * 1000) : Infinity;

  if (Number.isFinite(ageHours) && ageHours < STATUS_INTERVAL_HOURS) {
    return;
  }

  const stats = buildTradeStats(trades);
  const totalPnl = round(sumNetPnl(trades), 2);
  const startBalance = baseConfig.initialBalance ?? 1000;
  const pnlPct = startBalance > 0 ? round((totalPnl / startBalance) * 100, 3) : 0;
  const pnlSign = totalPnl >= 0 ? "+" : "";
  const grossSign = stats.grossPnl >= 0 ? "+" : "";
  const netSign = stats.netPnl >= 0 ? "+" : "";
  const strategyLines = groupPnlByStrategy(trades) || "- no closed trades yet";
  const lastTrades = formatLastTrades(trades, 3);
  const healthLines = formatStrategyHealth(trades);

  const message =
    `📊 ZenBlade PAPER STATUS\n` +
    `Mode: paper only — no real trading\n` +
    `Balance: ${round(state.balance, 2)} USDT\n` +
    `Total PnL: ${pnlSign}${totalPnl} USDT (${pnlSign}${pnlPct}%)\n` +
    `Open positions: ${state.openPositions.length}\n` +
    `Closed trades: ${trades.length}\n` +
    `Wins/Losses: ${stats.wins}/${stats.losses} | Winrate: ${stats.winrate}%\n` +
    `Gross PnL: ${grossSign}${round(stats.grossPnl, 2)} USDT\n` +
    `Fees: ${round(stats.fees, 2)} USDT\n` +
    `Net PnL: ${netSign}${round(stats.netPnl, 2)} USDT\n\n` +
    `PnL by strategy:\n${strategyLines}\n\n` +
    `Last closed trades:\n${lastTrades}\n\n` +
    `Strategy health:\n${healthLines}`;

  try {
    await sendTelegramMessage(message);
    state.lastStatusAt = new Date().toISOString();
    console.log(`TELEGRAM | STATUS_SENT | closed ${trades.length} | netPnL ${round(stats.netPnl, 2)}`);
  } catch (error) {
    console.error(`TELEGRAM | STATUS_FAILED | ${error.message}`);
  }
}

async function notifyOpen(position) {
  if (!baseConfig.telegramEnabled || !baseConfig.notifyOnBuy) return;

  await sendTelegramMessage(
    `🟢 ZenBlade PAPER OPEN\n` +
      `Strategy: ${position.strategyName}\n` +
      `Strategy ID: ${position.strategyId}\n` +
      `Symbol: ${position.symbol}\n` +
      `Side: ${position.side}\n` +
      `Entry: ${position.entryPrice}\n` +
      `TP: ${position.takePrice}\n` +
      `SL: ${position.stopPrice}\n` +
      `Size: ${position.size}\n` +
      `Position Value: ${position.positionValue} USDT\n` +
      `Mode: paper only\n` +
      `Reason: ${position.signalReason}`
  );
}

async function notifyClose(trade) {
  if (!baseConfig.telegramEnabled || !baseConfig.notifyOnClose) return;

  await sendTelegramMessage(
    `${trade.netPnl >= 0 ? "✅" : "🔴"} ZenBlade PAPER CLOSE\n` +
      `Strategy: ${trade.strategyName}\n` +
      `Strategy ID: ${trade.strategyId}\n` +
      `Symbol: ${trade.symbol}\n` +
      `Side: ${trade.side}\n` +
      `Entry: ${trade.entryPrice}\n` +
      `Exit: ${trade.exitPrice}\n` +
      `Exit Rule: ${trade.exitRule}\n` +
      `Gross PnL: ${trade.grossPnl} USDT\n` +
      `Fees: ${trade.fees} USDT\n` +
      `Net PnL: ${trade.netPnl} USDT\n` +
      `Balance: ${trade.balanceAfterClose} USDT\n` +
      `Mode: paper only`
  );
}

async function monitorOpenPositions(state, trades) {
  const remaining = [];

  for (const position of state.openPositions) {
    const candles = await fetchHistoricalCandles({
      symbol: position.symbol,
      bar: position.strategyId === "qorbBasket" ? "1H" : "5m",
      targetLimit: 5,
    });

    const lastCandle = candles[candles.length - 1];
    if (!lastCandle) {
      remaining.push(position);
      continue;
    }

    const closeDecision = shouldClosePosition(position, lastCandle);

    if (!closeDecision) {
      remaining.push(position);
      console.log(
        `OPEN | ${position.strategyName} | ${position.symbol} | ${position.side} | entry ${position.entryPrice} | last ${lastCandle.close}`
      );
      continue;
    }

    const closed = closePosition({
      position,
      exitPrice: closeDecision.exitPrice,
      reason: closeDecision.reason,
      balance: state.balance,
    });

    state.balance = closed.nextBalance;
    trades.push(closed.trade);

    console.log(
      `CLOSE | ${position.strategyName} | ${position.symbol} | ${position.side} | ${closeDecision.reason} | netPnL ${closed.trade.netPnl}`
    );

    await notifyClose(closed.trade);
  }

  state.openPositions = remaining;
}

async function evaluateStrategySymbol({ strategy, symbol, state }) {
  const key = positionKey(strategy.strategyId, symbol);

  if (hasOpenPosition(state, strategy.strategyId, symbol)) {
    return;
  }

  const config = buildConfig(strategy, symbol);

  const candles = await fetchHistoricalCandles({
    symbol,
    bar: strategy.bar,
    targetLimit: strategy.candlesLimit,
  });

  const lastCandle = candles[candles.length - 1];

  if (!lastCandle) {
    console.log(`SKIP | ${strategy.strategyName} | ${symbol} | no candles`);
    return;
  }

  if (state.lastProcessedCandleByKey[key] === lastCandle.time) {
    if (LOG_WAIT) {
        console.log(`WAIT | ${strategy.strategyName} | ${symbol} | candle already processed`);
    }
    return;
  }

  let htfCandles = null;

  if (strategy.htfBar) {
    htfCandles = await fetchHistoricalCandles({
      symbol,
      bar: strategy.htfBar,
      targetLimit: strategy.htfCandlesLimit,
    });
  }

  const signal = getSignal({
    candles,
    config,
    htfCandles,
  });

  state.lastProcessedCandleByKey[key] = lastCandle.time;

  const expectedAction = strategy.side === "LONG" ? "BUY" : "SELL_SHORT";

  console.log(
    `SCAN | ${strategy.strategyName} | ${symbol} | ${signal.action} | ${signal.reason}`
  );

  if (signal.action !== expectedAction) {
    return;
  }

  if (!passesExtraFilters(strategy, signal, candles)) {
    console.log(`FILTERED | ${strategy.strategyName} | ${symbol} | extra filters not passed`);
    return;
  }

  const sigKey = signalKey(strategy, symbol, signal, lastCandle);

  if (state.usedSignalKeys[sigKey]) {
    console.log(`SKIP | ${strategy.strategyName} | ${symbol} | signal already used`);
    return;
  }

  const position = planPosition({
    strategy,
    symbol,
    signal,
    candles,
    config,
    balance: state.balance,
  });

  if (!position) {
    console.log(`SKIP | ${strategy.strategyName} | ${symbol} | position plan failed`);
    return;
  }

  state.openPositions.push(position);
  state.usedSignalKeys[sigKey] = new Date().toISOString();

  console.log(
    `OPEN | ${position.strategyName} | ${position.symbol} | ${position.side} | entry ${position.entryPrice} | TP ${position.takePrice} | SL ${position.stopPrice}`
  );

  await notifyOpen(position);
}

export async function runStrategyPortfolioOnce() {
  if (baseConfig.paperOnly !== true) {
    throw new Error("Safety stop: paperOnly must be true");
  }

  const state = loadState();
  const trades = loadTrades();

  console.log("=== ZenBlade Strategy Paper Portfolio ===");
  console.log("Mode: paper only — no real trading");
  console.log(`Balance: ${state.balance} USDT`);
  console.log(`Open positions: ${state.openPositions.length}`);
  console.log();

  await monitorOpenPositions(state, trades);

  for (const strategy of STRATEGIES) {
    for (const symbol of strategy.symbols) {
      await evaluateStrategySymbol({
        strategy,
        symbol,
        state,
      });
    }
  }

  await notifyStatusIfDue(state, trades);
  saveAll(state, trades);

  console.log();
  console.log(`Done. Balance: ${state.balance} USDT`);
  console.log(`Open positions: ${state.openPositions.length}`);
  console.log(`Trades closed: ${trades.length}`);
}

const isDirectRun =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  runStrategyPortfolioOnce().catch((error) => {
    console.error("Strategy paper portfolio failed:", error);
    process.exitCode = 1;
  });
}
