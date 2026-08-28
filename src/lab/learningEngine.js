import {
  candidateParameterKey,
  generateCandidates,
  mutationGroups,
  SUPPORTED_LAB_STRATEGIES,
} from "./candidateGenerator.js";

const META_KEYS = new Set([
  "candidateId",
  "split",
  "folds",
  "validation",
  "learning",
  "parentHoldoutStatus",
]);

function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

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

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function groupValue(parameters, group) {
  return group.keys.length === 1
    ? parameters[group.keys[0]]
    : group.keys.map((key) => parameters[key]);
}

function assignGroup(parameters, group, value) {
  if (group.keys.length === 1) {
    parameters[group.keys[0]] = value;
    return;
  }
  group.keys.forEach((key, index) => {
    parameters[key] = value[index];
  });
}

export function cleanStrategyParameters(parameters = {}) {
  return Object.fromEntries(
    Object.entries(parameters).filter(([key]) => !META_KEYS.has(key))
  );
}

function evidenceMetrics(experiment) {
  if (experiment.experimentType === "strategy_lab_walk_forward") {
    const aggregate = experiment.metrics?.aggregate ?? {};
    return {
      returnPct: finite(aggregate.totalReturnPct),
      profitFactor: finite(aggregate.medianProfitFactor),
      trades: finite(aggregate.totalTrades),
      drawdownPct: finite(aggregate.maxDrawdownPct, 100),
      score: finite(experiment.metrics?.score),
    };
  }

  const test = experiment.metrics?.test ?? {};
  return {
    returnPct: finite(test.returnPct),
    profitFactor: finite(test.profitFactor),
    trades: finite(test.totalTrades),
    drawdownPct: finite(test.maxDrawdownPct, 100),
    score: finite(experiment.metrics?.score),
  };
}

function statusWeight(experiment) {
  if (experiment.experimentType === "strategy_lab_walk_forward") {
    if (experiment.status === "validated") return 120;
    if (experiment.status === "watch") return 65;
    return -100;
  }

  if (experiment.status === "candidate") return 80;
  if (experiment.status === "watch") return 40;
  return -100;
}

export function parentQuality(experiment) {
  const metrics = evidenceMetrics(experiment);
  return (
    statusWeight(experiment) +
    metrics.score * 0.2 +
    metrics.returnPct * 8 +
    Math.min(metrics.profitFactor, 3) * 10 +
    Math.min(metrics.trades, 50) * 0.4 -
    metrics.drawdownPct * 2
  );
}

export function isEligibleParent(experiment) {
  if (!experiment?.strategyId || !experiment?.market) return false;
  if (!SUPPORTED_LAB_STRATEGIES.includes(experiment.strategyId)) return false;
  if (!["strategy_lab_holdout", "strategy_lab_walk_forward"].includes(experiment.experimentType)) {
    return false;
  }

  const metrics = evidenceMetrics(experiment);
  if (experiment.experimentType === "strategy_lab_walk_forward") {
    return (
      ["validated", "watch"].includes(experiment.status) &&
      metrics.returnPct > 0 &&
      metrics.profitFactor >= 1.05 &&
      metrics.trades >= 15 &&
      metrics.drawdownPct <= 15
    );
  }

  return (
    ["candidate", "watch"].includes(experiment.status) &&
    metrics.returnPct > 0 &&
    metrics.profitFactor >= 1.05 &&
    metrics.trades >= 5 &&
    metrics.drawdownPct <= 15
  );
}

export function selectLearningParents(experiments, strategyName, options = {}) {
  const maxParents = options.maxParents ?? 6;
  const selected = [];
  const seen = new Set();

  const candidates = experiments
    .filter((item) => item.strategyId === strategyName && isEligibleParent(item))
    .sort((a, b) => {
      const qualityDiff = parentQuality(b) - parentQuality(a);
      if (qualityDiff !== 0) return qualityDiff;
      return String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""));
    });

  for (const experiment of candidates) {
    const parameters = cleanStrategyParameters(experiment.parameters);
    const key = `${experiment.market}|${candidateParameterKey(strategyName, parameters)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push({
      experiment,
      parameters,
      quality: Math.round(parentQuality(experiment) * 100) / 100,
      evidence: evidenceMetrics(experiment),
    });
    if (selected.length >= maxParents) break;
  }

  return selected;
}

function normalizedParentParameters(strategyName, parentParameters, random) {
  const normalized = {};
  for (const group of mutationGroups(strategyName)) {
    const current = groupValue(parentParameters, group);
    const exact = group.values.find((value) => sameValue(value, current));
    const selected = exact ?? group.values[Math.floor(random() * group.values.length)];
    assignGroup(normalized, group, selected);
  }
  return normalized;
}

export function mutateParentParameters(strategyName, parentParameters, seed) {
  const random = makeRandom(`${seed}:${strategyName}`);
  const groups = mutationGroups(strategyName);
  const parameters = normalizedParentParameters(strategyName, parentParameters, random);
  const mutationCount = random() < 0.72 ? 1 : 2;
  const available = [...groups];

  for (let mutation = 0; mutation < mutationCount && available.length; mutation += 1) {
    const groupIndex = Math.floor(random() * available.length);
    const group = available.splice(groupIndex, 1)[0];
    const current = groupValue(parameters, group);
    const currentIndex = group.values.findIndex((value) => sameValue(value, current));

    let nextIndex;
    if (currentIndex < 0) {
      nextIndex = Math.floor(random() * group.values.length);
    } else if (group.values.length === 2) {
      nextIndex = currentIndex === 0 ? 1 : 0;
    } else {
      const direction = random() < 0.5 ? -1 : 1;
      nextIndex = Math.max(0, Math.min(group.values.length - 1, currentIndex + direction));
      if (nextIndex === currentIndex) {
        nextIndex = currentIndex === 0 ? 1 : currentIndex - 1;
      }
    }

    assignGroup(parameters, group, group.values[nextIndex]);
  }

  return parameters;
}

function defaultSeed() {
  return process.env.LAB_SEED || `learning-engine-v1:${new Date().toISOString().slice(0, 10)}`;
}

export function generateLearningCandidates({
  experiments = [],
  strategies = SUPPORTED_LAB_STRATEGIES,
  candidatesPerStrategy = 20,
  seed = defaultSeed(),
  explorationFraction = 0.35,
  maxParents = 6,
} = {}) {
  const output = [];

  for (const strategyName of strategies) {
    if (!SUPPORTED_LAB_STRATEGIES.includes(strategyName)) {
      throw new Error(`Learning Engine v1 does not support strategy: ${strategyName}`);
    }

    const parents = selectLearningParents(experiments, strategyName, { maxParents });
    const desiredExploration = parents.length
      ? Math.max(1, Math.round(candidatesPerStrategy * explorationFraction))
      : candidatesPerStrategy;
    const desiredLearned = Math.max(0, candidatesPerStrategy - desiredExploration);
    const seen = new Set();

    const exploration = generateCandidates({
      strategies: [strategyName],
      candidatesPerStrategy: desiredExploration,
      seed: `${seed}:explore:${strategyName}`,
    });

    for (const candidate of exploration) {
      seen.add(candidateParameterKey(strategyName, candidate.parameters));
      output.push({ ...candidate, origin: "exploration" });
    }

    let learnedCreated = 0;
    let attempts = 0;
    while (learnedCreated < desiredLearned && parents.length) {
      attempts += 1;
      if (attempts > Math.max(100, desiredLearned * 40)) break;

      const parent = parents[(attempts - 1) % parents.length];
      const mutationSeed = `${seed}:learn:${strategyName}:${parent.experiment.fingerprint}:${attempts}`;
      const parameters = mutateParentParameters(strategyName, parent.parameters, mutationSeed);
      const key = candidateParameterKey(strategyName, parameters);
      if (seen.has(key)) continue;
      seen.add(key);
      learnedCreated += 1;

      const seedTag = hashSeed(mutationSeed).toString(16).padStart(8, "0").slice(0, 6);
      output.push({
        candidateId: `${strategyName}-learned-${seedTag}-${String(learnedCreated).padStart(3, "0")}`,
        strategyName,
        researchSeed: seed,
        origin: "learned",
        parameters,
        lineage: {
          parentFingerprint: parent.experiment.fingerprint,
          parentExperimentId: parent.experiment.id,
          parentMarket: parent.experiment.market,
          parentStatus: parent.experiment.status,
          parentExperimentType: parent.experiment.experimentType,
          parentQuality: parent.quality,
          parentEvidence: parent.evidence,
        },
      });
    }

    if (learnedCreated < desiredLearned) {
      const fillCount = desiredLearned - learnedCreated;
      const fill = generateCandidates({
        strategies: [strategyName],
        candidatesPerStrategy: fillCount * 3,
        seed: `${seed}:fallback:${strategyName}`,
      });

      for (const candidate of fill) {
        if (learnedCreated >= desiredLearned) break;
        const key = candidateParameterKey(strategyName, candidate.parameters);
        if (seen.has(key)) continue;
        seen.add(key);
        learnedCreated += 1;
        output.push({ ...candidate, origin: "exploration-fallback" });
      }
    }
  }

  return output;
}
