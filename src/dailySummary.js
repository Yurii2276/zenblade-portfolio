import fs from "fs";
import path from "path";
import { config } from "./config.js";
import { sendTelegramMessage } from "./telegram.js";

const STATE_PATH  = path.resolve("data/state.json");
const TRADES_PATH = path.resolve("data/trades.json");

const DEFAULT_STATE  = { balance: 1000, openPosition: null, lastProcessedCandleTime: null };
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

const todayUtc = new Date().toISOString().slice(0, 10);

const tradesToday = trades.filter((t) => {
  const closeDate = t.closedAt ? t.closedAt.slice(0, 10) : null;
  return closeDate === todayUtc;
});

const winsToday   = tradesToday.filter((t) => t.netPnl > 0);
const lossesToday = tradesToday.filter((t) => t.netPnl < 0);
const netPnlToday = Math.round(tradesToday.reduce((s, t) => s + t.netPnl, 0) * 100) / 100;

const currentBalance = state.balance ?? 1000;
const openPosition   = state.openPosition ?? null;

const openPositionText = openPosition
  ? `${openPosition.symbol} ${openPosition.side} @ ${openPosition.entryPrice}`
  : "none";

const summary =
  `📊 ZenBlade Daily Summary\n` +
  `Balance: ${currentBalance} USDT\n` +
  `Trades today: ${tradesToday.length}\n` +
  `Wins: ${winsToday.length}\n` +
  `Losses: ${lossesToday.length}\n` +
  `Net PnL today: ${netPnlToday} USDT\n` +
  `Open position: ${openPositionText}`;

console.log(summary);

if (config.telegramEnabled) {
  await sendTelegramMessage(summary);
}
