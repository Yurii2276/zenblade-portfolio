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

const state = loadJson(STATE_PATH, {
  balance: baseConfig.initialBalance ?? 1000,
  openPositions: [],
});

const trades = loadJson(TRADES_PATH, []);

const totalPnl = trades.reduce((sum, trade) => sum + tradeNetPnl(trade), 0);
const startBalance = baseConfig.initialBalance ?? 1000;
const pnlPct = startBalance > 0 ? (totalPnl / startBalance) * 100 : 0;

const byStrategy = new Map();

for (const trade of trades) {
  const key = trade.strategyName ?? trade.strategy ?? trade.strategyId ?? "Unknown strategy";
  const current = byStrategy.get(key) ?? { count: 0, pnl: 0 };
  current.count += 1;
  current.pnl += tradeNetPnl(trade);
  byStrategy.set(key, current);
}

console.log("=== ZenBlade Paper Report ===");
console.log("Mode: paper only — no real trading");
console.log(`Balance: ${round(state.balance, 2)} USDT`);
console.log(`Open positions: ${Array.isArray(state.openPositions) ? state.openPositions.length : 0}`);
console.log(`Closed trades: ${trades.length}`);
console.log(`Total PnL: ${round(totalPnl, 2)} USDT (${round(pnlPct, 3)}%)`);
console.log();

console.log("PnL by strategy:");
if (byStrategy.size === 0) {
  console.log("- no closed trades yet");
} else {
  for (const [strategy, value] of byStrategy.entries()) {
    console.log(`- ${strategy}: ${value.count} trades, ${round(value.pnl, 2)} USDT`);
  }
}

console.log();

console.log("Last 10 closed trades:");
for (const trade of trades.slice(-10)) {
  const strategy = trade.strategyName ?? trade.strategy ?? trade.strategyId ?? "Unknown strategy";
  const symbol = trade.symbol ?? trade.asset ?? "UNKNOWN";
  const side = trade.side ?? "UNKNOWN";
  const exitRule = trade.exitRule ?? trade.reasonExit ?? "UNKNOWN_EXIT";
  const pnl = round(tradeNetPnl(trade), 2);

  console.log(
    `- ${trade.closedAt ?? trade.exitTime ?? "no-exit-time"} | ${strategy} | ${symbol} | ${side} | ${exitRule} | netPnL ${pnl} USDT`
  );
}
