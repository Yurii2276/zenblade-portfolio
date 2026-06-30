import fs from "fs";
import path from "path";

const STATE_PATH  = path.resolve("data/state.json");
const TRADES_PATH = path.resolve("data/trades.json");

const DEFAULT_STATE  = { balance: 1000, openPosition: null };
const DEFAULT_TRADES = [];

function loadJson(filePath, defaultValue) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2));
    return defaultValue;
  }
}

const state  = loadJson(STATE_PATH,  DEFAULT_STATE);
const trades = loadJson(TRADES_PATH, DEFAULT_TRADES);

const currentBalance = state.balance ?? 1000;
const openPosition   = state.openPosition ?? null;

const totalTrades = trades.length;
const wins   = trades.filter((t) => t.netPnl > 0);
const losses = trades.filter((t) => t.netPnl < 0);

const winCount  = wins.length;
const lossCount = losses.length;
const winRate   = totalTrades > 0
  ? ((winCount / totalTrades) * 100).toFixed(2) + "%"
  : "N/A";

const grossPnlTotal = Math.round(trades.reduce((s, t) => s + (t.grossPnl ?? 0), 0) * 100) / 100;
const feesTotal     = Math.round(trades.reduce((s, t) => s + (t.fees     ?? 0), 0) * 100) / 100;
const netPnlTotal   = Math.round(trades.reduce((s, t) => s + (t.netPnl   ?? 0), 0) * 100) / 100;

const totalWinsPnl   = wins.reduce((s, t) => s + t.netPnl, 0);
const totalLossesPnl = losses.reduce((s, t) => s + t.netPnl, 0);

const avgWin  = winCount  > 0 ? Math.round((totalWinsPnl  / winCount)  * 100) / 100 : 0;
const avgLoss = lossCount > 0 ? Math.round((totalLossesPnl / lossCount) * 100) / 100 : 0;

const profitFactor = lossCount > 0
  ? Math.round((totalWinsPnl / Math.abs(totalLossesPnl)) * 100) / 100
  : "N/A";

console.log("=== ZenBlade Paper Stats ===");
console.log(`Current Balance:  ${currentBalance} USDT`);
console.log(`Open Position:    ${openPosition ? "YES" : "none"}`);
console.log(`Total Trades:     ${totalTrades}`);
console.log(`Wins:             ${winCount}`);
console.log(`Losses:           ${lossCount}`);
console.log(`Win Rate:         ${winRate}`);
console.log(`Gross PnL:        ${grossPnlTotal} USDT`);
console.log(`Fees:             ${feesTotal} USDT`);
console.log(`Net PnL:          ${netPnlTotal} USDT`);
console.log(`Average Win:      ${avgWin} USDT`);
console.log(`Average Loss:     ${avgLoss} USDT`);
console.log(`Profit Factor:    ${profitFactor}`);

if (openPosition) {
  console.log("\n── Open Position ──");
  console.log(`  Symbol:    ${openPosition.symbol}`);
  console.log(`  Side:      ${openPosition.side}`);
  console.log(`  Entry:     ${openPosition.entryPrice}`);
  console.log(`  Stop:      ${openPosition.stopPrice}`);
  console.log(`  Take:      ${openPosition.takePrice}`);
  console.log(`  Size:      ${openPosition.size}`);
  console.log(`  Opened At: ${openPosition.openedAt}`);
  console.log(`  Reason:    ${openPosition.reason}`);
}
