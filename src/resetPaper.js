import fs from "fs";
import path from "path";

const STATE_PATH  = path.resolve("data/state.json");
const TRADES_PATH = path.resolve("data/trades.json");

const defaultState = {
  balance: 1000,
  openPosition: null,
  lastProcessedCandleTime: null,
};
const defaultTrades = [];

fs.writeFileSync(STATE_PATH,  JSON.stringify(defaultState,  null, 2));
fs.writeFileSync(TRADES_PATH, JSON.stringify(defaultTrades, null, 2));

console.log("Paper account reset complete");
console.log("Balance: 1000 USDT");
console.log("Open position: none");
console.log("Trades: 0");
