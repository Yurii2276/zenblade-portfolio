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
  minScoreForEntry: [65, 70, 75, 80, 85],
  pullbackLookback: [5, 8, 12],
  pullbackTolerancePct: [0.0015, 0.002, 0.003],
  breakoutLookback: [20, 30, 40],
  breakoutRecentLookback: [6, 10, 15],
  breakoutBufferPct: [0, 0.001, 0.002],
  retestTolerancePct: [0.0015, 0.0025, 0.004],
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
    minScoreForEntry: pick(SEARCH_SPACE.minScoreForEntry, random),
  };

  if (strategyName === "trendPullback") {
    return {
      ...common,
      pullbackLookback: pick(SEARCH_SPACE.pullbackLookback, random),
      pullbackTolerancePct: pick(SEARCH_SPACE.pullbackTolerancePct, random),
    };
  }

  if (strategyName === "breakoutRetest") {
    return {
      ...common,
      breakoutLookback: pick(SEARCH_SPACE.breakoutLookback, random),
      breakoutRecentLookback: pick(SEARCH_SPACE.breakoutRecentLookback, random),
      breakoutBufferPct: pick(SEARCH_SPACE.breakoutBufferPct, random),
      retestTolerancePct: pick(SEARCH_SPACE.retestTolerancePct, random),
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
    while (candidates.filter((candidate) => candidate.strategyName === strategyName).length < candidatesPerStrategy) {
      attempts += 1;
      if (attempts > candidatesPerStrategy * 50) break;

      const parameters = buildParameters(strategyName, random);
      const key = stableKey(strategyName, parameters);
      if (seen.has(key)) continue;
      seen.add(key);

      candidates.push({
        candidateId: `${strategyName}-${String(candidates.length + 1).padStart(4, "0")}`,
        strategyName,
        parameters,
      });
    }
  }

  return candidates;
}

export const SUPPORTED_LAB_STRATEGIES = LONG_STRATEGIES;
