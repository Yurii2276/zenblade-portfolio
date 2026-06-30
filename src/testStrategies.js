import { config } from "./config.js";
import { createBullishCandles } from "./mockScenarios.js";
import { getSignal } from "./strategy.js";
import { getStrategySignal } from "./strategies/index.js";

const candles = createBullishCandles();
const htfCandles = createBullishCandles();
const validActions = new Set(["HOLD", "BUY"]);

for (const strategyName of ["trendMomentum", "trendPullback"]) {
  const signal = getStrategySignal({
    strategyName,
    candles,
    config,
    htfCandles,
  });

  if (!validActions.has(signal.action)) {
    throw new Error(`${strategyName} returned invalid action: ${signal.action}`);
  }

  console.log(`${strategyName}: ${signal.action} — ${signal.reason}`);
}

const backwardCompatibleSignal = getSignal({
  candles,
  config,
  htfCandles,
});

if (!validActions.has(backwardCompatibleSignal.action)) {
  throw new Error(`getSignal returned invalid action: ${backwardCompatibleSignal.action}`);
}

let unknownStrategyError = null;

try {
  getStrategySignal({
    strategyName: "unknown",
    candles,
    config,
    htfCandles,
  });
} catch (error) {
  unknownStrategyError = error;
}

if (!unknownStrategyError || unknownStrategyError.message !== "Unknown strategy: unknown") {
  throw new Error("Unknown strategy did not throw the expected error");
}

console.log(`getSignal compatibility: ${backwardCompatibleSignal.action}`);
console.log(`unknown strategy: ${unknownStrategyError.message}`);
console.log("STRATEGIES SMOKE TEST: OK");
