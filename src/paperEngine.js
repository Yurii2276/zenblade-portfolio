import fs from "fs";
import path from "path";
import { getSignal } from "./strategy.js";
import { logInfo } from "./logger.js";
import { fetchCandles } from "./okxClient.js";
import { calculateLongTrade } from "./riskManager.js";

const DEFAULT_STATE = {
  balance: 1000,
  openPosition: null,
  lastProcessedCandleTime: null,
};

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
  constructor(config, options = {}) {
    this.config = config;
    this.candlesProvider = options.candlesProvider || null;
    this.statePath  = path.resolve(options.statePath  || "data/state.json");
    this.tradesPath = path.resolve(options.tradesPath || "data/trades.json");

    const state = loadJson(this.statePath, DEFAULT_STATE);
    this.balance                  = typeof state.balance === "number" ? state.balance : DEFAULT_STATE.balance;
    this.position                 = state.openPosition ?? null;
    this.lastProcessedCandleTime  = state.lastProcessedCandleTime ?? null;
    this.trades                   = loadJson(this.tradesPath, []);
  }

  saveState() {
    saveJson(this.statePath, {
      balance:                 this.balance,
      openPosition:            this.position,
      lastProcessedCandleTime: this.lastProcessedCandleTime,
    });
    saveJson(this.tradesPath, this.trades);
  }

  closePosition(exitPrice, reason) {
    const { entryPrice, size } = this.position;
    const grossPnl = (exitPrice - entryPrice) * size;
    const fees     = (entryPrice * size + exitPrice * size) * this.config.feeRate;
    const netPnl   = Math.round((grossPnl - fees) * 100) / 100;

    this.balance = Math.round((this.balance + netPnl) * 100) / 100;

    const trade = {
      ...this.position,
      exitPrice,
      closeReason: reason,
      grossPnl:    Math.round(grossPnl * 100) / 100,
      fees:        Math.round(fees     * 100) / 100,
      netPnl,
      closedAt:    new Date().toISOString(),
    };

    this.trades.push(trade);
    logInfo(`Позицію закрито: ${reason} | exitPrice: ${exitPrice} | netPnL: ${netPnl} USDT`);
    this.position = null;
  }

  async runOnce() {
    const candles = this.candlesProvider
      ? await this.candlesProvider()
      : await fetchCandles({
          symbol: this.config.symbol,
          bar:    this.config.bar,
          limit:  this.config.candlesLimit,
        });

    const lastCandle     = candles[candles.length - 1];
    const lastPrice      = lastCandle.close;
    const lastCandleTime = lastCandle.time;

    // ── D. Open position: always check TP/SL ─────────────────────────────
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
      logInfo(`Символ: ${this.config.symbol}`);
      logInfo(`Остання ціна: ${lastPrice} USDT`);
      return;
    }

    // ── E. No open position: guard duplicate processing ───────────────────
    const signal = getSignal({ candles, config: this.config });
    const ind    = signal.indicators;

    logInfo(`Баланс: ${this.balance} USDT`);
    logInfo(`Символ: ${this.config.symbol}`);
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

    if (this.lastProcessedCandleTime === lastCandleTime) {
      logInfo("Свічка вже оброблена, новий вхід не перевіряється");
      return;
    }

    // New candle — evaluate entry
    if (signal.action === "BUY" && ind) {
      const trade = calculateLongTrade({
        balance:    this.balance,
        entryPrice: lastPrice,
        atr:        ind.atr14,
        config:     this.config,
      });

      this.position = {
        symbol:        this.config.symbol,
        side:          "LONG",
        entryPrice:    trade.entryPrice,
        stopPrice:     trade.stopPrice,
        takePrice:     trade.takePrice,
        size:          trade.size,
        positionValue: trade.positionValue,
        openedAt:      new Date().toISOString(),
        reason:        signal.reason,
      };

      logInfo(`Paper-position відкрита: entry=${trade.entryPrice} | stop=${trade.stopPrice} | take=${trade.takePrice} | size=${trade.size} | value=${trade.positionValue} USDT`);
    }

    // Mark candle as processed regardless of BUY/HOLD
    this.lastProcessedCandleTime = lastCandleTime;
    this.saveState();
  }
}
