import { config } from "../config.js";
import { fetchHistoricalCandles } from "../okxClient.js";
import { appendExperiment } from "../brain/experimentStore.js";
import { generateCandidates, SUPPORTED_LAB_STRATEGIES } from "./candidateGenerator.js";
import { runLongBacktest, validateCandles } from "./backtestEvaluator.js";
import { scoreCandidate } from "./strategyScorer.js";

function intEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function selectedSymbols() {
  const fromEnv = (process.env.LAB_SYMBOLS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return fromEnv.length ? fromEnv : config.symbols;
}

function selectedStrategies() {
  const fromEnv = (process.env.LAB_STRATEGIES ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return fromEnv.length ? fromEnv : SUPPORTED_LAB_STRATEGIES;
}

async function loadMarketData(symbol, candleLimit) {
  const candles = await fetchHistoricalCandles({
    symbol,
    bar: config.bar,
    targetLimit: candleLimit,
  });
  const quality = validateCandles(candles);
  if (!quality.ok) throw new Error(`${symbol}: ${quality.reason}`);

  const htfCandles = await fetchHistoricalCandles({
    symbol,
    bar: config.htfBar,
    targetLimit: Math.min(config.htfCandlesLimit, Math.max(300, Math.ceil(candleLimit / 12))),
  });

  return { candles, htfCandles };
}

function evaluateOne({ candidate, symbol, candles, htfCandles }) {
  const splitIndex = Math.max(100, Math.floor(candles.length * 0.7));
  const trainCandles = candles.slice(0, splitIndex);
  const testConfig = {
    ...config,
    ...candidate.parameters,
    activeStrategy: candidate.strategyName,
    paperOnly: true,
    mode: "research",
    telegramEnabled: false,
  };

  const train = runLongBacktest({
    candles: trainCandles,
    htfCandles,
    testConfig,
    initialBalance: config.initialBalance,
  });

  const test = runLongBacktest({
    candles,
    htfCandles,
    testConfig,
    initialBalance: config.initialBalance,
    allowEntriesFromIndex: splitIndex,
  });

  const verdict = scoreCandidate({
    trainMetrics: train.metrics,
    testMetrics: test.metrics,
  });

  return {
    candidate,
    symbol,
    splitIndex,
    trainMetrics: train.metrics,
    testMetrics: test.metrics,
    verdict,
    period: {
      from: new Date(candles[0].time).toISOString(),
      split: new Date(candles[splitIndex].time).toISOString(),
      to: new Date(candles.at(-1).time).toISOString(),
    },
  };
}

function persistResult(result) {
  const { candidate, symbol, trainMetrics, testMetrics, verdict, period } = result;
  return appendExperiment({
    strategyId: candidate.strategyName,
    strategyName: candidate.strategyName,
    experimentType: "strategy_lab_holdout",
    stage: "research",
    status: verdict.status,
    source: `strategy-lab-v1:${symbol}:${period.from}:${period.to}`,
    market: symbol,
    timeframe: config.bar,
    parameters: {
      candidateId: candidate.candidateId,
      ...candidate.parameters,
      split: "70/30 chronological holdout",
    },
    metrics: {
      score: verdict.score,
      train: trainMetrics,
      test: testMetrics,
    },
    decision: verdict.status === "candidate"
      ? "Candidate survived initial chronological holdout; requires walk-forward validation before paper promotion."
      : verdict.status === "watch"
        ? "Keep for observation/research; not ready for paper promotion."
        : "Reject this parameter set for the tested market period.",
    notes: verdict.reasons,
    tags: ["strategy-lab-v1", "holdout", verdict.status],
  });
}

export async function runStrategyLab() {
  const candleLimit = intEnv("LAB_CANDLES", 1500);
  const candidatesPerStrategy = intEnv("LAB_CANDIDATES", 8);
  const symbols = selectedSymbols();
  const strategies = selectedStrategies();
  const candidates = generateCandidates({ strategies, candidatesPerStrategy });

  console.log("=== Autonomous Strategy Lab v1 ===");
  console.log("Mode: RESEARCH ONLY — no real orders, no paper promotion");
  console.log(`Symbols: ${symbols.join(", ")}`);
  console.log(`Strategies: ${strategies.join(", ")}`);
  console.log(`Candidates: ${candidates.length}`);
  console.log(`Candles target: ${candleLimit}`);
  console.log("");

  const results = [];

  for (const symbol of symbols) {
    console.log(`Loading ${symbol}...`);
    let marketData;
    try {
      marketData = await loadMarketData(symbol, candleLimit);
    } catch (error) {
      console.error(`SKIP ${symbol}: ${error.message}`);
      continue;
    }

    console.log(`${symbol}: ${marketData.candles.length} candles loaded`);

    for (const candidate of candidates) {
      try {
        const result = evaluateOne({ candidate, symbol, ...marketData });
        const stored = persistResult(result);
        results.push(result);
        console.log(
          `${result.verdict.status.toUpperCase().padEnd(9)} ` +
          `${candidate.strategyName.padEnd(16)} ${symbol.padEnd(10)} ` +
          `score=${String(result.verdict.score).padStart(7)} ` +
          `OOS=${String(result.testMetrics.returnPct).padStart(7)}% ` +
          `PF=${String(result.testMetrics.profitFactor).padStart(5)} ` +
          `trades=${String(result.testMetrics.totalTrades).padStart(3)} ` +
          `${stored.created ? "stored" : "duplicate"}`
        );
      } catch (error) {
        console.error(`FAILED ${candidate.candidateId}/${symbol}: ${error.message}`);
      }
    }
  }

  results.sort((a, b) => b.verdict.score - a.verdict.score);
  const candidatesPassed = results.filter((result) => result.verdict.status === "candidate");
  const watch = results.filter((result) => result.verdict.status === "watch");

  console.log("\n=== Lab Summary ===");
  console.log(`Evaluated: ${results.length}`);
  console.log(`Candidates passed: ${candidatesPassed.length}`);
  console.log(`Watch: ${watch.length}`);
  console.log(`Rejected: ${results.length - candidatesPassed.length - watch.length}`);

  console.log("\nTop 10:");
  for (const [index, result] of results.slice(0, 10).entries()) {
    console.log(
      `${index + 1}. ${result.candidate.strategyName}/${result.symbol} ` +
      `score=${result.verdict.score}, OOS=${result.testMetrics.returnPct}%, ` +
      `PF=${result.testMetrics.profitFactor}, DD=${result.testMetrics.maxDrawdownPct}%, ` +
      `trades=${result.testMetrics.totalTrades}, status=${result.verdict.status}`
    );
  }

  return results;
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  runStrategyLab().catch((error) => {
    console.error("Strategy Lab failed:", error);
    process.exitCode = 1;
  });
}
