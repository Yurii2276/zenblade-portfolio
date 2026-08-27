import { config } from "../config.js";
import { fetchHistoricalCandles } from "../okxClient.js";
import { appendExperiment, loadExperiments } from "../brain/experimentStore.js";
import { validateCandles } from "./backtestEvaluator.js";
import { runWalkForwardCandidate } from "./walkForwardValidator.js";

function intEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function csvEnv(name) {
  return (process.env[name] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function strategyParameters(experiment) {
  const { candidateId, split, ...parameters } = experiment.parameters ?? {};
  return {
    candidateId: candidateId ?? null,
    parameters,
  };
}

export function selectHoldoutCandidates(experiments, options = {}) {
  const symbols = new Set(options.symbols ?? []);
  const strategies = new Set(options.strategies ?? []);
  const maxCandidates = options.maxCandidates ?? 20;

  const filtered = experiments
    .filter((item) =>
      item.experimentType === "strategy_lab_holdout" &&
      item.status === "candidate" &&
      item.market &&
      item.strategyId
    )
    .filter((item) => symbols.size === 0 || symbols.has(item.market))
    .filter((item) => strategies.size === 0 || strategies.has(item.strategyId))
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));

  const selected = [];
  const seen = new Set();

  for (const experiment of filtered) {
    const { parameters } = strategyParameters(experiment);
    const key = `${experiment.strategyId}|${experiment.market}|${stableStringify(parameters)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(experiment);
    if (selected.length >= maxCandidates) break;
  }

  return selected;
}

async function loadMarketData(symbol, candleLimit) {
  const candles = await fetchHistoricalCandles({
    symbol,
    bar: config.bar,
    targetLimit: candleLimit,
  });
  const quality = validateCandles(candles);
  if (!quality.ok) throw new Error(`${symbol}: ${quality.reason}`);

  const htfTarget = Math.min(
    Math.max(config.htfCandlesLimit, 500),
    Math.max(500, Math.ceil(candleLimit / 12) + 150)
  );
  const htfCandles = await fetchHistoricalCandles({
    symbol,
    bar: config.htfBar,
    targetLimit: htfTarget,
  });

  return { candles, htfCandles };
}

function persistWalkForward({ experiment, result, candles, folds }) {
  const { candidateId, parameters } = strategyParameters(experiment);
  const foldMetrics = result.foldResults.map((fold) => ({
    fold: fold.fold,
    period: fold.period,
    train: fold.trainMetrics,
    test: fold.testMetrics,
  }));

  return appendExperiment({
    strategyId: experiment.strategyId,
    strategyName: experiment.strategyName ?? experiment.strategyId,
    experimentType: "strategy_lab_walk_forward",
    stage: "research",
    status: result.verdict.status,
    source: `walk-forward-v1:${experiment.fingerprint}:${candles[0].time}:${candles.at(-1).time}`,
    market: experiment.market,
    timeframe: experiment.timeframe ?? config.bar,
    parameters: {
      candidateId,
      ...parameters,
      folds,
      validation: "expanding-window chronological walk-forward",
    },
    metrics: {
      score: result.verdict.score,
      aggregate: result.aggregate,
      folds: foldMetrics,
      parentHoldoutScore: experiment.metrics?.score ?? null,
    },
    decision: result.verdict.status === "validated"
      ? "Walk-forward validated. Eligible for a separate paper-promotion gate; no automatic paper or live activation."
      : result.verdict.status === "watch"
        ? "Walk-forward is mixed. Keep in research and collect more evidence."
        : "Rejected by walk-forward validation for this market and parameter set.",
    notes: result.verdict.reasons,
    tags: ["strategy-lab", "walk-forward-v1", result.verdict.status],
  });
}

export async function runWalkForwardLab() {
  const candleLimit = intEnv("WF_CANDLES", 3000);
  const folds = intEnv("WF_FOLDS", 4);
  const minTrainCandles = intEnv("WF_MIN_TRAIN", 600);
  const minTestCandles = intEnv("WF_MIN_TEST", 150);
  const maxCandidates = intEnv("WF_MAX_CANDIDATES", 20);
  const symbols = csvEnv("WF_SYMBOLS");
  const strategies = csvEnv("WF_STRATEGIES");

  const experiments = loadExperiments();
  const candidates = selectHoldoutCandidates(experiments, {
    symbols,
    strategies,
    maxCandidates,
  });

  console.log("=== Autonomous Walk-Forward Validator v1 ===");
  console.log("Mode: RESEARCH ONLY — no real orders, no automatic paper promotion");
  console.log(`Holdout candidates selected: ${candidates.length}`);
  console.log(`Candles target: ${candleLimit}`);
  console.log(`Folds: ${folds} | min train: ${minTrainCandles} | min test: ${minTestCandles}`);

  if (candidates.length === 0) {
    console.log("No holdout candidates found. Run `npm run lab:run` first.");
    return [];
  }

  const cache = new Map();
  const results = [];

  for (const experiment of candidates) {
    const symbol = experiment.market;
    if (!cache.has(symbol)) {
      console.log(`Loading walk-forward history for ${symbol}...`);
      try {
        cache.set(symbol, await loadMarketData(symbol, candleLimit));
      } catch (error) {
        console.error(`SKIP ${symbol}: ${error.message}`);
        cache.set(symbol, null);
      }
    }

    const marketData = cache.get(symbol);
    if (!marketData) continue;

    const { candidateId, parameters } = strategyParameters(experiment);
    const testConfig = {
      ...config,
      ...parameters,
      activeStrategy: experiment.strategyId,
      paperOnly: true,
      mode: "research",
      telegramEnabled: false,
    };

    try {
      const result = runWalkForwardCandidate({
        ...marketData,
        testConfig,
        initialBalance: config.initialBalance,
        folds,
        minTrainCandles,
        minTestCandles,
      });
      const stored = persistWalkForward({
        experiment,
        result,
        candles: marketData.candles,
        folds,
      });

      results.push({ experiment, result });
      console.log(
        `${result.verdict.status.toUpperCase().padEnd(10)} ` +
        `${experiment.strategyId.padEnd(16)} ${symbol.padEnd(10)} ` +
        `${String(candidateId ?? "-").padEnd(22)} ` +
        `score=${String(result.verdict.score).padStart(7)} ` +
        `folds+%=${String(Math.round(result.aggregate.profitableFoldRatio * 100)).padStart(3)} ` +
        `ret=${String(result.aggregate.totalReturnPct).padStart(7)}% ` +
        `PFmed=${String(result.aggregate.medianProfitFactor).padStart(5)} ` +
        `DD=${String(result.aggregate.maxDrawdownPct).padStart(6)}% ` +
        `${stored.created ? "stored" : "duplicate"}`
      );
    } catch (error) {
      console.error(`FAILED ${experiment.strategyId}/${symbol}/${candidateId ?? "candidate"}: ${error.message}`);
    }
  }

  results.sort((a, b) => b.result.verdict.score - a.result.verdict.score);
  const validated = results.filter((item) => item.result.verdict.status === "validated");
  const watch = results.filter((item) => item.result.verdict.status === "watch");

  console.log("\n=== Walk-Forward Summary ===");
  console.log(`Evaluated: ${results.length}`);
  console.log(`Validated: ${validated.length}`);
  console.log(`Watch: ${watch.length}`);
  console.log(`Rejected: ${results.length - validated.length - watch.length}`);

  if (validated.length) {
    console.log("\nValidated candidates (still research-only):");
    validated.slice(0, 10).forEach((item, index) => {
      const aggregate = item.result.aggregate;
      console.log(
        `${index + 1}. ${item.experiment.strategyId}/${item.experiment.market} ` +
        `score=${item.result.verdict.score}, total=${aggregate.totalReturnPct}%, ` +
        `profitable folds=${aggregate.profitableFolds}/${aggregate.folds}, ` +
        `PF median=${aggregate.medianProfitFactor}, DD=${aggregate.maxDrawdownPct}%`
      );
    });
  }

  return results;
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  runWalkForwardLab().catch((error) => {
    console.error("Walk-forward lab failed:", error);
    process.exitCode = 1;
  });
}
