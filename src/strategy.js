import { getStrategySignal } from "./strategies/index.js";

export function getSignal({ candles, config, htfCandles = null }) {
  const strategyName = config.activeStrategy || "trendMomentum";
  return getStrategySignal({
    strategyName,
    candles,
    config,
    htfCandles,
  });
}
