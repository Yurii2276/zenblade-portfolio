function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function buildRegimeEvidenceFromWalkForward(experiment) {
  const folds = experiment?.metrics?.folds ?? [];
  const buckets = new Map();

  for (const fold of folds) {
    const byRegime = fold?.test?.regimeSummary?.byRegime ?? {};
    for (const [key, metrics] of Object.entries(byRegime)) {
      if (!buckets.has(key)) {
        buckets.set(key, {
          key,
          foldsObserved: 0,
          positiveFolds: 0,
          negativeFolds: 0,
          trades: 0,
          netPnlUSDT: 0,
          weightedProfitFactorNumerator: 0,
          weightedProfitFactorDenominator: 0,
        });
      }

      const bucket = buckets.get(key);
      const trades = finite(metrics.trades);
      const netPnl = finite(metrics.netPnlUSDT);
      const pf = finite(metrics.profitFactor);
      bucket.foldsObserved += 1;
      bucket.trades += trades;
      bucket.netPnlUSDT += netPnl;
      if (netPnl > 0) bucket.positiveFolds += 1;
      if (netPnl < 0) bucket.negativeFolds += 1;
      if (trades > 0 && pf > 0 && pf < 99) {
        bucket.weightedProfitFactorNumerator += pf * trades;
        bucket.weightedProfitFactorDenominator += trades;
      }
    }
  }

  const byRegime = {};
  for (const [key, bucket] of buckets.entries()) {
    const positiveFoldRatio = bucket.foldsObserved
      ? bucket.positiveFolds / bucket.foldsObserved
      : 0;
    const weightedProfitFactor = bucket.weightedProfitFactorDenominator
      ? bucket.weightedProfitFactorNumerator / bucket.weightedProfitFactorDenominator
      : (bucket.netPnlUSDT > 0 ? 99 : 0);

    byRegime[key] = {
      foldsObserved: bucket.foldsObserved,
      positiveFolds: bucket.positiveFolds,
      negativeFolds: bucket.negativeFolds,
      positiveFoldRatio: round(positiveFoldRatio, 3),
      trades: bucket.trades,
      netPnlUSDT: round(bucket.netPnlUSDT, 4),
      weightedProfitFactor: round(weightedProfitFactor, 3),
    };
  }

  return { byRegime };
}

export function regimeCompatibility(approval, currentRegimeKey) {
  const evidence = approval?.researchEvidence?.regimeEvidence?.byRegime?.[currentRegimeKey];
  if (!evidence) {
    return {
      status: "neutral",
      scoreAdjustment: 0,
      reason: "no_regime_evidence",
      evidence: null,
    };
  }

  const trades = finite(evidence.trades);
  const folds = finite(evidence.foldsObserved);
  const netPnl = finite(evidence.netPnlUSDT);
  const pf = finite(evidence.weightedProfitFactor);
  const positiveFoldRatio = finite(evidence.positiveFoldRatio);

  if (trades < 5 || folds < 2) {
    return {
      status: "neutral",
      scoreAdjustment: 0,
      reason: "regime_sample_too_small",
      evidence,
    };
  }

  if (netPnl > 0 && pf >= 1.15 && positiveFoldRatio >= 0.5) {
    const bonus = Math.min(
      35,
      12 + Math.min(pf, 2.5) * 6 + positiveFoldRatio * 10 + Math.min(trades, 30) * 0.2
    );
    return {
      status: "supportive",
      scoreAdjustment: round(bonus, 2),
      reason: "validated_regime_edge",
      evidence,
    };
  }

  if (netPnl < 0 && (pf < 0.9 || positiveFoldRatio < 0.4)) {
    const penalty = Math.min(
      40,
      15 + Math.max(0, 1 - pf) * 12 + Math.max(0, 0.5 - positiveFoldRatio) * 20
    );
    return {
      status: "adverse",
      scoreAdjustment: -round(penalty, 2),
      reason: "historically_weak_in_current_regime",
      evidence,
    };
  }

  return {
    status: "neutral",
    scoreAdjustment: 0,
    reason: "mixed_regime_evidence",
    evidence,
  };
}

export function rankApprovalsForRegime(approvals, regimeBySymbol = {}) {
  return (approvals ?? [])
    .map((approval) => {
      const currentRegime = regimeBySymbol[approval.symbol] ?? null;
      const compatibility = currentRegime?.key
        ? regimeCompatibility(approval, currentRegime.key)
        : {
            status: "neutral",
            scoreAdjustment: 0,
            reason: "current_regime_unknown",
            evidence: null,
          };
      const baseRank = finite(approval?.researchEvidence?.rankScore);
      return {
        approval,
        currentRegime,
        compatibility,
        metaScore: round(baseRank + compatibility.scoreAdjustment, 2),
      };
    })
    .sort((a, b) => {
      const diff = b.metaScore - a.metaScore;
      if (diff !== 0) return diff;
      return String(a.approval.approvalId).localeCompare(String(b.approval.approvalId));
    });
}
