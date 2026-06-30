import { config } from "./config.js";
import { getSignal } from "./strategy.js";
import { logInfo } from "./logger.js";
import { fetchCandles } from "./okxClient.js";

export class PaperEngine {
  constructor() {
    this.balance = config.initialBalance;
    this.position = null;
    this.trades = [];
  }

  async runOnce() {
    const candles = await fetchCandles({
      symbol: config.symbol,
      bar: config.bar,
      limit: config.candlesLimit,
    });

    const lastCandle = candles[0];
    const lastPrice = lastCandle.close;

    const signal = getSignal({ candles });

    logInfo(`Баланс: ${this.balance} USDT`);
    logInfo(`Символ: ${config.symbol}`);
    logInfo(`Остання ціна: ${lastPrice} USDT`);
    logInfo(`Свічок отримано: ${candles.length}`);
    logInfo(`Сигнал: ${signal.action}`);
    logInfo(`Причина: ${signal.reason}`);
  }
}
