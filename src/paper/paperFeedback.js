import fs from "node:fs";
import path from "node:path";
import { appendExperiment } from "../brain/experimentStore.js";
import {
  AUTONOMOUS_PAPER_STATE_FILE,
  AUTONOMOUS_PAPER_TRADES_FILE,
  PAPER_FEEDBACK_FILE,
  PAPER_MANIFEST_FILE,
} from "../runtime/runtimePaths.js";

export const DEFAULT_PAPER_FEEDBACK_POLICY = Object.freeze({
  minAssessmentTrades: 12,
  minAssessmentDays: 3,
  demoteMaxLossPct: 1.5,
  demoteMaxDrawdownPct: 2.5,
  demoteMaxConsecutiveLosses: 6,
  demoteMinProfitFactor: 0.8,
  provenMinProfitFactor: 1.25,
  provenMinReturnPct: 1,
  provenMaxDrawdownPct: 5,
  provenMaxConsecutiveLosses: 5,
});

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(finite(value) * factor) / factor;
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return structuredClone(fallback);
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function tradeTimestamp(trade) {
  const closed = Date.parse(trade?.closedAt ?? "");
  if (Number.isFinite(closed)) return closed;
  const exitTime = Number(trade?.exitTime);
  if (Number.isFinite(exitTime)) return exitTime;
  const entryTime = Number(trade?.entryTime);
  return Number.isFinite(entryTime) ? entryTime : 0;
}

function daysSince(timestamp, now) {
  const start = Date.parse(timestamp ?? "");
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, (now.getTime() - start) / 86_400_000);
}

function maxConsecutiveLosses(trades) {
  let current = 0;
  let maximum = 0;
  for (const trade of trades) {
    if (finite(trade.netPnlUSDT) < 0) {
      current += 1;
      maximum = Math.max(maximum, current);
    } else {
      current = 0;
    }
  }
  return maximum;
}

function candidateDrawdownPct(trades, initialBalance) {
  let equity = initialBalance;
  let peak = initialBalance;
  let maxDrawdown = 0;

  for (const trade of trades) {
    equity += finite(trade.netPnlUSDT);
    peak = Math.max(peak, equity);
    if (peak > 0) {
      maxDrawdown = Math.max(maxDrawdown, ((peak - equity) / peak) * 100);
    }
  }

  return round(maxDrawdown, 3);
}

function regimeStats(trades) {
  const groups = {};
  for (const trade of trades) {
    const key = trade?.marketRegimeAtEntry?.key ?? "unknown";
    groups[key] ??= { trades: 0, wins: 0, losses: 0, netPnlUSDT: 0 };
    const group = groups[key];
    const pnl = finite(trade.netPnlUSDT);
    group.trades += 1;
    group.netPnlUSDT += pnl;
    if (pnl > 0) group.wins += 1;
    if (pnl < 0) group.losses += 1;
  }

  for (const group of Object.values(groups)) {
    group.netPnlUSDT = round(group.netPnlUSDT, 4);
    group.winRatePct = group.trades
      ? round((group.wins / group.trades) * 100, 2)
      : 0;
  }
  return groups;
}

export function summarizeApprovalPaperPerformance({
  approval,
  trades = [],
  initialBalance = 1000,
  now = new Date(),
}) {
  const closed = trades
    .filter((trade) => trade?.approvalId === approval.approvalId && trade?.status === "CLOSED")
    .sort((a, b) => tradeTimestamp(a) - tradeTimestamp(b));

  const wins = closed.filter((trade) => finite(trade.netPnlUSDT) > 0);
  const losses = closed.filter((trade) => finite(trade.netPnlUSDT) < 0);
  const grossWins = wins.reduce((sum, trade) => sum + finite(trade.netPnlUSDT), 0);
  const grossLosses = Math.abs(
    losses.reduce((sum, trade) => sum + finite(trade.netPnlUSDT), 0)
  );
  const netPnlUSDT = closed.reduce((sum, trade) => sum + finite(trade.netPnlUSDT), 0);
  const returnPct = initialBalance > 0 ? (netPnlUSDT / initialBalance) * 100 : 0;
  const profitFactor = grossLosses > 0
    ? grossWins / grossLosses
    : grossWins > 0
      ? 99
      : 0;

  return {
    approvalId: approval.approvalId,
    parentExperimentFingerprint: approval.parentExperimentFingerprint ?? null,
    candidateId: approval.candidateId ?? null,
    strategyId: approval.strategyId,
    symbol: approval.symbol,
    approvedAt: approval.approvedAt ?? null,
    daysInPaper: round(daysSince(approval.approvedAt, now), 2),
    closedTrades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: closed.length ? round((wins.length / closed.length) * 100, 2) : 0,
    netPnlUSDT: round(netPnlUSDT, 4),
    returnPct: round(returnPct, 3),
    profitFactor: round(profitFactor, 3),
    maxDrawdownPct: candidateDrawdownPct(closed, initialBalance),
    maxConsecutiveLosses: maxConsecutiveLosses(closed),
    expectancyUSDT: closed.length ? round(netPnlUSDT / closed.length, 4) : 0,
    totalFeesUSDT: round(
      closed.reduce((sum, trade) => sum + finite(trade.feesUSDT), 0),
      4
    ),
    firstTradeAt: closed.length
      ? new Date(tradeTimestamp(closed[0])).toISOString()
      : null,
    lastTradeAt: closed.length
      ? new Date(tradeTimestamp(closed.at(-1))).toISOString()
      : null,
    regimes: regimeStats(closed),
  };
}

export function evaluatePaperFeedback({
  approval,
  stats,
  policy = DEFAULT_PAPER_FEEDBACK_POLICY,
}) {
  const reasons = [];
  const enoughForAssessment =
    stats.closedTrades >= policy.minAssessmentTrades &&
    stats.daysInPaper >= policy.minAssessmentDays;

  if (
    stats.maxConsecutiveLosses >= policy.demoteMaxConsecutiveLosses &&
    stats.closedTrades >= policy.demoteMaxConsecutiveLosses
  ) {
    reasons.push("loss_streak_limit");
  }

  if (enoughForAssessment) {
    if (stats.returnPct <= -policy.demoteMaxLossPct) reasons.push("paper_loss_limit");
    if (stats.maxDrawdownPct >= policy.demoteMaxDrawdownPct) {
      reasons.push("candidate_drawdown_limit");
    }
    if (stats.profitFactor < policy.demoteMinProfitFactor) {
      reasons.push("paper_profit_factor_failed");
    }
  }

  if (reasons.length > 0) {
    return {
      status: "paper_demoted",
      reasons,
      microLiveCandidate: false,
      requiresManualLiveApproval: true,
    };
  }

  const graduation = approval.graduationPolicy ?? {};
  const minClosedTrades = finite(graduation.minClosedTrades, 50);
  const minDays = finite(graduation.minDays, 21);
  const proven =
    stats.closedTrades >= minClosedTrades &&
    stats.daysInPaper >= minDays &&
    stats.returnPct >= policy.provenMinReturnPct &&
    stats.profitFactor >= policy.provenMinProfitFactor &&
    stats.maxDrawdownPct <= policy.provenMaxDrawdownPct &&
    stats.maxConsecutiveLosses <= policy.provenMaxConsecutiveLosses;

  if (proven) {
    return {
      status: "paper_proven",
      reasons: [],
      microLiveCandidate: true,
      requiresManualLiveApproval: true,
    };
  }

  return {
    status: "paper_watch",
    reasons: stats.closedTrades === 0 ? ["no_closed_paper_trades_yet"] : ["collect_more_paper_evidence"],
    microLiveCandidate: false,
    requiresManualLiveApproval: true,
  };
}

export function applyFeedbackToManifest(manifest, evaluations) {
  const byApproval = new Map(
    evaluations.map((item) => [item.approval.approvalId, item])
  );

  const approvals = [];
  for (const approval of manifest.approvals ?? []) {
    const evaluation = byApproval.get(approval.approvalId);
    if (!evaluation) {
      approvals.push(approval);
      continue;
    }
    if (evaluation.verdict.status === "paper_demoted") continue;

    approvals.push({
      ...approval,
      paperFeedback: {
        status: evaluation.verdict.status,
        updatedAt: evaluation.updatedAt,
        microLiveCandidate: evaluation.verdict.microLiveCandidate,
        closedTrades: evaluation.stats.closedTrades,
        returnPct: evaluation.stats.returnPct,
        profitFactor: evaluation.stats.profitFactor,
        maxDrawdownPct: evaluation.stats.maxDrawdownPct,
      },
    });
  }

  return {
    ...manifest,
    generatedAt: new Date().toISOString(),
    mode: "paper-only",
    liveTradingAllowed: false,
    approvals,
  };
}

function feedbackDecision(status) {
  if (status === "paper_demoted") {
    return "Paper evidence failed the safety/edge gate. Disable new paper entries for this exact walk-forward candidate and feed the failure back into Brain.";
  }
  if (status === "paper_proven") {
    return "Paper evidence confirms the edge threshold. Mark as micro-live candidate, but live trading remains disabled and requires explicit manual approval.";
  }
  return "Keep in controlled paper trading and collect more out-of-sample evidence.";
}

export function runPaperFeedback(options = {}) {
  const manifestFile = options.manifestFile ?? PAPER_MANIFEST_FILE;
  const tradesFile = options.tradesFile ?? AUTONOMOUS_PAPER_TRADES_FILE;
  const stateFile = options.stateFile ?? AUTONOMOUS_PAPER_STATE_FILE;
  const feedbackFile = options.feedbackFile ?? PAPER_FEEDBACK_FILE;
  const now = options.now ?? new Date();
  const policy = { ...DEFAULT_PAPER_FEEDBACK_POLICY, ...(options.policy ?? {}) };

  const manifest = options.manifest ?? readJson(manifestFile, null);
  if (!manifest) {
    return { status: "no_manifest", evaluations: [], demoted: 0, proven: 0, watch: 0 };
  }
  if (manifest.mode !== "paper-only" || manifest.liveTradingAllowed !== false) {
    throw new Error("unsafe_paper_feedback_manifest");
  }

  const trades = options.trades ?? readJson(tradesFile, []);
  const state = options.state ?? readJson(stateFile, { initialBalance: 1000 });
  const initialBalance = finite(state.initialBalance, 1000);

  const evaluations = (manifest.approvals ?? []).map((approval) => {
    const stats = summarizeApprovalPaperPerformance({
      approval,
      trades,
      initialBalance,
      now,
    });
    const verdict = evaluatePaperFeedback({ approval, stats, policy });
    const updatedAt = now.toISOString();

    appendExperiment(
      {
        strategyId: approval.strategyId,
        strategyName: approval.strategyName ?? approval.strategyId,
        experimentType: "paper_feedback",
        stage: "paper",
        status: verdict.status,
        source: `paper-feedback-v1:${approval.approvalId}:${stats.closedTrades}:${stats.lastTradeAt ?? "none"}`,
        market: approval.symbol,
        timeframe: approval.timeframe,
        parameters: {
          approvalId: approval.approvalId,
          parentExperimentFingerprint: approval.parentExperimentFingerprint,
          candidateId: approval.candidateId,
          approvedAt: approval.approvedAt,
          strategyParameters: approval.strategyParameters ?? {},
          graduationPolicy: approval.graduationPolicy ?? {},
          learningLineage: approval.learningLineage ?? null,
        },
        metrics: stats,
        decision: feedbackDecision(verdict.status),
        notes: verdict.reasons,
        tags: [
          "paper-feedback-v1",
          verdict.status,
          verdict.microLiveCandidate ? "micro-live-candidate" : "no-live",
        ],
      },
      options.experimentStoreOptions ?? {}
    );

    return { approval, stats, verdict, updatedAt };
  });

  const nextManifest = applyFeedbackToManifest(manifest, evaluations);
  writeJson(manifestFile, nextManifest);

  const payload = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    mode: "paper-only",
    liveTradingAllowed: false,
    policy,
    evaluations: evaluations.map(({ approval, stats, verdict, updatedAt }) => ({
      approvalId: approval.approvalId,
      parentExperimentFingerprint: approval.parentExperimentFingerprint,
      strategyId: approval.strategyId,
      symbol: approval.symbol,
      updatedAt,
      status: verdict.status,
      microLiveCandidate: verdict.microLiveCandidate,
      reasons: verdict.reasons,
      stats,
    })),
  };
  writeJson(feedbackFile, payload);

  return {
    status: "success",
    evaluations,
    demoted: evaluations.filter((item) => item.verdict.status === "paper_demoted").length,
    proven: evaluations.filter((item) => item.verdict.status === "paper_proven").length,
    watch: evaluations.filter((item) => item.verdict.status === "paper_watch").length,
    activeApprovals: nextManifest.approvals.length,
    manifest: nextManifest,
    payload,
  };
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  try {
    const result = runPaperFeedback();
    console.log("=== Paper Feedback / Auto-Demotion v1 ===");
    console.log("Mode: PAPER ONLY — live trading disabled");
    console.log(`Status: ${result.status}`);
    console.log(`Watch: ${result.watch ?? 0}`);
    console.log(`Proven: ${result.proven ?? 0}`);
    console.log(`Demoted: ${result.demoted ?? 0}`);
    console.log(`Active paper approvals: ${result.activeApprovals ?? 0}`);
  } catch (error) {
    console.error("Paper feedback failed:", error);
    process.exitCode = 1;
  }
}
