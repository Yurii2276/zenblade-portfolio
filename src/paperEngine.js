import fs from "fs";
import path from "path";
import { config } from "./config.js";
import { getSignal } from "./strategy.js";
import { logInfo } from "./logger.js";
import { fetchCandles } from "./okxClient.js";
import { calculateLongTrade } from "./riskManager.js";

const STATE_PATH = path.resolve("data/state.json");
const TRADES_PATH = path.resolve("data/trades.json");

const DEFAULT_STATE = { balance: 1000, openPosition: null };

function loadJson(filePath, defaultValue) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return defaultValue;
  }
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export class PaperEngine {
  constructor() {
    const state = loadJson(STATE_PATH, DEFAULT_STATE);
    this.balance = typeof state.balance === "number" ? state.balance : DEFAULT_STATE.balance;
    this.position = state.openPosition ?? null;
    this.trades = loadJson(TRADES_PATH, []);
  }

  saveState() {
    saveJson(STATE_PATH, { balance: this.balance, openPosition: this.position });
    saveJson(TRADES_PATH, this.trades);
  }

  closePosition(exitPrice, reason) {
    const { entryPrice, size } = this.position;
    const grossPnl = (exitPrice - entryPrice) * size;
    const fees = (entryPrice * size + exitPrice * size) * config.feeRate;
    const netPnl = Math.round((grossPnl - fees) * 100) / 100;

    this.balance = Math.round((this.balance + netPnl) * 100) / 100;

    const trade = {
      ...this.position,
      exitPrice,
      closeReason: reason,
      grossPnl: Math.round(grossPnl * 100) / 100,
      fees: Math.round(fees * 100) / 100,
      netPnl,
      closedAt: new Date().toISOString(),
    };

    this.trades.push(trade);
    logInfo(`Позицію закрито: ${reason} | exitPrice: ${exitPrice} | netPnL: ${netPnl} USDT`);
    this.position = null;
  }

  async runOnce() {
    const candles = await fetchCandles({
      symbol: config.symbol,
      bar: config.bar,
      limit: config.candlesLimit,
    });

    const lastCandle = candles[candles.length - 1];
    const lastPrice = lastCandle.close;

    if (this.position) {
      const { stopPrice, takePrice, entryPrice, size } = this.position;
      const unrealizedPnl = Math.round((lastPrice - entryPrice) * size * 100) / 100;

      if (lastPrice <= stopPrice) {
        this.closePosition(lastPrice, "STOP_LOSS");
      } else if (lastPrice >= takePrice) {
        this.closePosition(lastPrice, "TAKE_PROFIT");
      } else {
        logInfo(`Відкрита позиція: entry=${entryPrice} | stop=${stopPrice} | take=${takePrice} | size=${size} | unrealizedPnL=${unrealizedPnl} USDT`);
      }

      this.saveState();

      logInfo(`Баланс: ${this.balance} USDT`);
      logInfo(`Символ: ${config.symbol}`);
      logInfo(`Остання ціна: ${lastPrice} USDT`);
      return;
    }

    const signal = getSignal({ candles, config });
    const ind = signal.indicators;

    logInfo(`Баланс: ${this.balance} USDT`);
    logInfo(`Символ: ${config.symbol}`);
    logInfo(`Остання ціна: ${lastPrice} USDT`);
    logInfo(`Свічок отримано: ${candles.length}`);

    if (ind) {
      logInfo(`EMA20: ${ind.ema20}`);
      logInfo(`EMA50: ${ind.ema50}`);
      logInfo(`RSI14: ${ind.rsi14}`);
      logInfo(`ATR14: ${ind.atr14}`);
      logInfo(`Last Volume: ${ind.lastVolume}`);
      logInfo(`Volume SMA20: ${ind.volumeSma20}`);
    }

    logInfo(`Сигнал: ${signal.action}`);
    logInfo(`Причина: ${signal.reason}`);

    if (signal.action === "BUY" && ind) {
      const trade = calculateLongTrade({
        balance: this.balance,
        entryPrice: lastPrice,
        atr: ind.atr14,
        config,
      });

      this.position = {
        symbol: config.symbol,
        side: "LONG",
        entryPrice: trade.entryPrice,
        stopPrice: trade.stopPrice,
        takePrice: trade.takePrice,
        size: trade.size,
        positionValue: trade.positionValue,
        openedAt: new Date().toISOString(),
        reason: signal.reason,
      };

      this.saveState();

      logInfo(`Paper-position відкрита: entry=${trade.entryPrice} | stop=${trade.stopPrice} | take=${trade.takePrice} | size=${trade.size} | value=${trade.positionValue} USDT`);
    }
  }
}
