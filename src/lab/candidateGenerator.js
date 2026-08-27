const LONG_STRATEGIES = ["trendMomentum", "trendPullback", "breakoutRetest"];

const SEARCH_SPACE = {
  emaPairs: [
    [9, 21],
    [12, 26],
    [20, 50],
    [30, 100],
  ],
  rsiRanges: [
    [42, 64],
    [45, 65],
    [48, 68],
    [50, 70],
  ],
  minVolumeFactor: [0.9, 1.0, 1.05, 1.15, 1.25],
  atrStopMultiplier: [0.8, 1.0, 1.2, 1.5],
  atrTakeMultiplier: [1.5, 1.8, 2.2, 2.6],
  useHtfFilter: [true, false],
  pullbackLookback: [5, 8, 12],
  pullbackTolerancePct: [0.0015, 0.002, 0.003],
  breakoutLookback: [20, 30, 40],
  breakoutRecentLookback: [6, 10, 15],
  breakoutBufferPct: [0, 0.001, 0.002],
  retestTolerancePct: [0.0015, 0.0025, 0.004],
  breakoutRegimePairs: [
    [20, 60],
    [30, 100],
    [50, 150],
  ],
  breakoutMinEmaSpreadPct: [null, 0, 0.1, 0.25],
  breakoutMaxAtrPct: [null, 1.5, 2.5, 4],
  breakoutMinRsi: [null, 45, 50, 55],
};

function hashSeed(text) {
  let hash = 2166136261;
  for (const char of text) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function makeRandom(seedText) {
  let state = hashSeed(seedText) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function pick(values, random) {
  return values[Math.floor(random() * values.length)];
}

function buildParameters(strategyName, random) {
  const [emaFast, emaSlow] = pick(SEARCH_SPACE.emaPairs, random);
  const [minRsiForLong, maxRsiForLong] = pick(SEARCH_SPACE.rsiRanges, random);

  const common = {
    emaFast,
    emaSlow,
    minRsiForLong,
    maxRsiForLong,
    minVolumeFactor: pick(SEARCH_SPACE.minVolumeFactor, random),
    atrStopMultiplier: pick(SEARCH_SPACE.atrStopMultiplier, random),
    atrTakeMultiplier: pick(SEARCH_SPACE.atrTakeMultiplier, random),
    useHtfFilter: pick(SEARCH_SPACE.useHtfFilter, random),
  };

  if (strategyName === "trendPullback") {
    return {
      ...common,
      pullbackLookback: pick(SEARCH_SPACE.pullbackLookback, random),
      pullbackTolerancePct: pick(SEARCH_SPACE.pullbackTolerancePct, random),
    };
  }

  if (strategyName === "breakoutRetest") {
    const [breakoutRegimeEmaFast, breakoutRegimeEmaSlow] = pick(
      SEARCH_SPACE.breakoutRegimePairs,
      random
    );
    return {
      ...common,
      breakoutLookback: pick(SEARCH_SPACE.breakoutLookback, random),
      breakoutRecentLookback: pick(SEARCH_SPACE.breakoutRecentLookback, random),
      breakoutBufferPct: pick(SEARCH_SPACE.breakoutBufferPct, random),
      retestTolerancePct: pick(SEARCH_SPACE.retestTolerancePct, random),
      breakoutRegimeEmaFast,
      breakoutRegimeEmaSlow,
      breakoutMinEmaSpreadPct: pick(SEARCH_SPACE.breakoutMinEmaSpreadPct, random),
      breakoutMaxAtrPct: pick(SEARCH_SPACE.breakoutMaxAtrPct, random),
      breakoutMinRsi: pick(SEARCH_SPACE.breakoutMinRsi, random),
    };
  }

  return common;
}

function stableKey(strategyName, parameters) {
  const entries = Object.entries(parameters).sort(([a], [b]) => a.localeCompare(b));
  return `${strategyName}|${entries.map(([key, value]) => `${key}=${value}`).join("|")}`;
}

export function generateCandidates({
  strategies = LONG_STRATEGIES,
  candidatesPerStrategy = 20,
  seed = "strategy-lab-v1",
} = {}) {
  const candidates = [];
  const seen = new Set();

  for (const strategyName of strategies) {
    if (!LONG_STRATEGIES.includes(strategyName)) {
      throw new Error(`Strategy Lab v1 does not support strategy: ${strategyName}`);
    }

    const random = makeRandom(`${seed}:${strategyName}`);
    let attempts = 0;
    let createdForStrategy = 0;

    while (createdForStrategy < candidatesPerStrategy) {
      attempts += 1;
      if (attempts > candidatesPerStrategy * 50) break;

      const parameters = buildParameters(strategyName, random);
      const key = stableKey(strategyName, parameters);
      if (seen.has(key)) continue;
      seen.add(key);
      createdForStrategy += 1;

      candidates.push({
        candidateId: `${strategyName}-${String(createdForStrategy).padStart(4, "0")}`,
        strategyName,
        parameters,
      });
    }
  }

  return candidates;
}

export const SUPPORTED_LAB_STRATEGIES = LONG_STRATEGIES;
