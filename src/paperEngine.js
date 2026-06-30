import { config } from "./config.js";
import { getSignal } from "./strategy.js";
import { logInfo } from "./logger.js";

export class PaperEngine {
  constructor() {
    this.balance = config.initialBalance;
    this.position = null;
    this.trades = [];
  }

  runOnce() {
    const marketData = {
      symbol: config.symbol,
      price: 65000,
      timestamp: new Date().toISOString(),
    };

    const signal = getSignal(marketData);

    logInfo(`Баланс: ${this.balance} USDT`);
    logInfo(`Символ: ${marketData.symbol}`);
    logInfo(`Сигнал: ${signal.action}`);
    logInfo(`Причина: ${signal.reason}`);
  }
}
