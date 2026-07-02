import { getTrendMomentumSignal } from "./trendMomentum.js";
import { getTrendPullbackSignal } from "./trendPullback.js";
import { getBreakoutRetestSignal } from "./breakoutRetest.js";

export function getStrategySignal({
  strategyName,
  candles,
  config,
  htfCandles = null,
}) {
  if (strategyName === "trendMomentum") {
    return getTrendMomentumSignal({ candles, config, htfCandles });
  }

  if (strategyName === "trendPullback") {
    return getTrendPullbackSignal({ candles, config, htfCandles });
  }

  if (strategyName === "breakoutRetest") {
    return getBreakoutRetestSignal({ candles, config, htfCandles });
  }

  throw new Error(`Unknown strategy: ${strategyName}`);
}
