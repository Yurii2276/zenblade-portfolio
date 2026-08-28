import fs from "node:fs";
import path from "node:path";
import { appendExperiment, loadExperiments } from "../brain/experimentStore.js";
import { buildRegimeEvidenceFromWalkForward } from "../intelligence/metaSelector.js";

const DEFAULT_MANIFEST = path.resolve(
  process.env.PAPER_APPROVED_MANIFEST || "data/brain/paper-approved.json"
);

export const DEFAULT_PAPER_GATE_POLICY = Object.freeze({
  minWalkForwardScore: 45,
  minTotalTrades: 30,
  minProfitableFoldRatio: 0.75,
  minMedianProfitFactor: 1.2,
  minTotalReturnPct: 1,
  maxDrawdownPct: 10,
  minWorstFoldReturnPct: -3,
  maxApprovedCandidates: 5,
  paperRiskPerTrade: 0.0025,
  paperMaxPositionValuePct: 0.1,
  maxOpenPositionsPerCandidate: 1,
  maxTotalOpenPositions: 3,
  maxDailyLossPct: 1,
  maxPaperDrawdownPct: 5,
  minPaperClosedTrades: 50,
  minPaperDays: 21,
});

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function cleanParameters(experiment) {
  const source = experiment.parameters ?? {};
  const {
    candidateId,
    folds,
    validation,
    split,
    learning,
    parentHoldoutStatus,
    ...strategyParameters
  } = source;
  return {
    candidateId: candidateId ?? null,
    strategyParameters,
    learning: learning ?? null,
  };
}

export function evaluatePaperPromotion(experiment, policy = DEFAULT_PAPER_GATE_POLICY) {
  const aggregate = experiment?.metrics?.aggregate ?? {};
  const score = finite(experiment?.metrics?.score, -Infinity);
  const reasons = [];

  if (experiment?.experimentType !== "strategy_lab_walk_forward") {
    reasons.push("not_walk_forward_result");
  }
  if (experiment?.status !== "validated") {
    reasons.push("walk_forward_not_validated");
  }
  if (score < policy.minWalkForwardScore) reasons.push("walk_forward_score_too_low");
  if (finite(aggregate.totalTrades) < policy.minTotalTrades) reasons.push("sample_too_small");
  if (finite(aggregate.profitableFoldRatio) < policy.minProfitableFoldRatio) {
    reasons.push("profitable_fold_ratio_too_low");
  }
  if (finite(aggregate.medianProfitFactor) < policy.minMedianProfitFactor) {
    reasons.push("median_profit_factor_too_low");
  }
  if (finite(aggregate.totalReturnPct) < policy.minTotalReturnPct) {
    reasons.push("walk_forward_return_too_low");
  }
  if (finite(aggregate.maxDrawdownPct, 100) > policy.maxDrawdownPct) {
    reasons.push("walk_forward_drawdown_too_high");
  }
  if (finite(aggregate.worstFoldReturnPct, -100) < policy.minWorstFoldReturnPct) {
    reasons.push("worst_fold_too_weak");
  }

  const rankScore =
    score +
    finite(aggregate.totalReturnPct) * 2 +
    finite(aggregate.medianProfitFactor) * 10 +
    finite(aggregate.profitableFoldRatio) * 20 -
    finite(aggregate.maxDrawdownPct) * 2;

  return {
    approved: reasons.length === 0,
    reasons,
    rankScore: Math.round(rankScore * 100) / 100,
  };
}

export function selectPaperCandidates(
  experiments,
  policy = DEFAULT_PAPER_GATE_POLICY
) {
  const latestByIdentity = new Map();

  for (const experiment of experiments ?? []) {
    if (experiment.experimentType !== "strategy_lab_walk_forward") continue;
    const { strategyParameters } = cleanParameters(experiment);
    const identity = `${experiment.strategyId}|${experiment.market}|${stableStringify(
      strategyParameters
    )}`;
    const current = latestByIdentity.get(identity);
    if (
      !current ||
      String(experiment.createdAt ?? "") > String(current.createdAt ?? "")
    ) {
      latestByIdentity.set(identity, experiment);
    }
  }

  return [...latestByIdentity.values()]
    .map((experiment) => ({
      experiment,
      verdict: evaluatePaperPromotion(experiment, policy),
    }))
    .filter((item) => item.verdict.approved)
    .sort((a, b) => b.verdict.rankScore - a.verdict.rankScore)
    .slice(0, policy.maxApprovedCandidates);
}

export function buildPaperApproval(item, policy = DEFAULT_PAPER_GATE_POLICY) {
  const { experiment, verdict } = item;
  const { candidateId, strategyParameters, learning } = cleanParameters(experiment);
  const approvedAt = new Date().toISOString();

  return {
    approvalId: `paper:${experiment.fingerprint}`,
    approvedAt,
    parentExperimentFingerprint: experiment.fingerprint,
    strategyId: experiment.strategyId,
    strategyName: experiment.strategyName ?? experiment.strategyId,
    candidateId,
    symbol: experiment.market,
    timeframe: experiment.timeframe ?? "5m",
    strategyParameters,
    learningLineage: learning,
    researchEvidence: {
      walkForwardScore: experiment.metrics?.score ?? null,
      aggregate: experiment.metrics?.aggregate ?? {},
      regimeEvidence: buildRegimeEvidenceFromWalkForward(experiment),
      rankScore: verdict.rankScore,
    },
    riskPolicy: {
      riskPerTrade: policy.paperRiskPerTrade,
      maxPositionValuePct: policy.paperMaxPositionValuePct,
      maxOpenPositionsPerCandidate: policy.maxOpenPositionsPerCandidate,
      maxTotalOpenPositions: policy.maxTotalOpenPositions,
      maxDailyLossPct: policy.maxDailyLossPct,
      maxPaperDrawdownPct: policy.maxPaperDrawdownPct,
    },
    graduationPolicy: {
      minClosedTrades: policy.minPaperClosedTrades,
      minDays: policy.minPaperDays,
      requiresManualLiveApproval: true,
    },
    mode: "paper",
    liveTradingAllowed: false,
  };
}

export function writePaperManifest(approvals, filePath = DEFAULT_MANIFEST) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: "paper-only",
    liveTradingAllowed: false,
    approvals,
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

export function runPaperPromotionGate(options = {}) {
  const policy = { ...DEFAULT_PAPER_GATE_POLICY, ...(options.policy ?? {}) };
  const experiments = options.experiments ?? loadExperiments(options.experimentsFile);
  const selected = selectPaperCandidates(experiments, policy);
  const approvals = selected.map((item) => buildPaperApproval(item, policy));
  const manifest = writePaperManifest(
    approvals,
    options.manifestFile ?? DEFAULT_MANIFEST
  );

  for (let index = 0; index < selected.length; index += 1) {
    const { experiment, verdict } = selected[index];
    const approval = approvals[index];
    appendExperiment(
      {
        strategyId: experiment.strategyId,
        strategyName: experiment.strategyName ?? experiment.strategyId,
        experimentType: "paper_promotion_gate",
        stage: "paper",
        status: "paper_approved",
        source: `paper-promotion-v1:${experiment.fingerprint}`,
        market: experiment.market,
        timeframe: experiment.timeframe,
        parameters: approval,
        metrics: {
          rankScore: verdict.rankScore,
          walkForward: experiment.metrics,
          regimeEvidence: approval.researchEvidence.regimeEvidence,
        },
        decision:
          "Approved for controlled paper trading only. Live trading remains disabled and requires a separate manual gate.",
        notes: [],
        tags: [
          "paper-promotion-v1",
          "paper-approved",
          "no-live",
          ...(approval.learningLineage?.origin ? [approval.learningLineage.origin] : []),
        ],
      },
      options.experimentStoreOptions ?? {}
    );
  }

  return { policy, selected, approvals, manifest };
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  try {
    const result = runPaperPromotionGate();
    console.log("=== Autonomous Paper Promotion Gate v1 ===");
    console.log("Mode: PAPER ONLY — live trading disabled");
    console.log(`Approved candidates: ${result.approvals.length}`);
    for (const approval of result.approvals) {
      console.log(
        `APPROVED ${approval.strategyId}/${approval.symbol} ` +
          `candidate=${approval.candidateId ?? "-"} ` +
          `risk=${approval.riskPolicy.riskPerTrade * 100}%/trade`
      );
    }
    console.log(`Manifest: ${DEFAULT_MANIFEST}`);
  } catch (error) {
    console.error("Paper promotion gate failed:", error);
    process.exitCode = 1;
  }
}
