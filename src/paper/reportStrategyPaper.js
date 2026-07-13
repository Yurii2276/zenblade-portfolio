import fs from "node:fs";
import path from "node:path";
import { config as baseConfig } from "../config.js";

const STATE_PATH = path.resolve("data/strategy-paper-state.json");
const TRADES_PATH = path.resolve("data/strategy-paper-trades.json");

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
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

function groupByStrategy(trades) {
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

  return grouped;
}

function strategyHealth(value) {
  if (value.count < 5) return "not enough data";
  if (value.netPnl > 0 && value.wins >= value.losses) return "profitable";
  if (value.netPnl < 0 && value.losses > value.wins) return "losing";
  return "mixed";
}

const state = loadJson(STATE_PATH, {
  balance: baseConfig.initialBalance ?? 1000,
  openPositions: [],
});

const trades = loadJson(TRADES_PATH, []);
const stats = buildTradeStats(trades);
const startBalance = baseConfig.initialBalance ?? 1000;
const pnlPct = startBalance > 0 ? (stats.netPnl / startBalance) * 100 : 0;
const byStrategy = groupByStrategy(trades);

console.log("=== ZenBlade Paper Report ===");
console.log("Mode: paper only — no real trading");
console.log(`Balance: ${round(state.balance, 2)} USDT`);
console.log(`Open positions: ${Array.isArray(state.openPositions) ? state.openPositions.length : 0}`);
console.log(`Closed trades: ${trades.length}`);
console.log(`Wins/Losses/Breakeven: ${stats.wins}/${stats.losses}/${stats.breakeven}`);
console.log(`Winrate: ${stats.winrate}%`);
console.log(`Gross PnL: ${round(stats.grossPnl, 2)} USDT`);
console.log(`Fees: ${round(stats.fees, 2)} USDT`);
console.log(`Net PnL: ${round(stats.netPnl, 2)} USDT (${round(pnlPct, 3)}%)`);
console.log();

console.log("PnL by strategy:");
if (byStrategy.size === 0) {
  console.log("- no closed trades yet");
} else {
  for (const [strategy, value] of byStrategy.entries()) {
    const winrate = value.count > 0 ? round((value.wins / value.count) * 100, 1) : 0;

    console.log(
      `- ${strategy}: ${value.count} trades | wins/losses ${value.wins}/${value.losses} | winrate ${winrate}% | gross ${round(value.grossPnl, 2)} | fees ${round(value.fees, 2)} | net ${round(value.netPnl, 2)} USDT | ${strategyHealth(value)}`
    );
  }
}

console.log();

console.log("Last 10 closed trades:");
if (!trades.length) {
  console.log("- no closed trades yet");
} else {
  for (const trade of trades.slice(-10).reverse()) {
    const strategy = trade.strategyName ?? trade.strategy ?? trade.strategyId ?? "Unknown strategy";
    const symbol = trade.symbol ?? trade.asset ?? "UNKNOWN";
    const side = trade.side ?? "UNKNOWN";
    const exitRule = trade.exitRule ?? trade.reasonExit ?? "UNKNOWN_EXIT";
    const gross = round(tradeGrossPnl(trade), 2);
    const fees = round(tradeFees(trade), 2);
    const net = round(tradeNetPnl(trade), 2);

    console.log(
      `- ${trade.closedAt ?? trade.exitTime ?? "no-exit-time"} | ${strategy} | ${symbol} | ${side} | ${exitRule} | gross ${gross} | fees ${fees} | net ${net} USDT`
    );
  }
}
