function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

export function scoreCandidate({ trainMetrics, testMetrics }) {
  const trainTrades = finite(trainMetrics.totalTrades);
  const testTrades = finite(testMetrics.totalTrades);
  const testReturn = finite(testMetrics.returnPct);
  const testPf = finite(testMetrics.profitFactor);
  const testDd = finite(testMetrics.maxDrawdownPct, 100);
  const trainReturn = finite(trainMetrics.returnPct);
  const trainPf = finite(trainMetrics.profitFactor);

  const reasons = [];
  if (trainTrades < 12) reasons.push("train_sample_too_small");
  if (testTrades < 5) reasons.push("test_sample_too_small");
  if (trainReturn <= 0) reasons.push("train_not_profitable");
  if (testReturn <= 0) reasons.push("test_not_profitable");
  if (trainPf < 1.05) reasons.push("train_profit_factor_weak");
  if (testPf < 1.1) reasons.push("test_profit_factor_weak");
  if (testDd > 12) reasons.push("test_drawdown_too_high");

  const score =
    testReturn * 5 +
    Math.min(testPf, 3) * 12 +
    Math.min(testTrades, 40) * 0.4 +
    finite(testMetrics.winRatePct) * 0.08 -
    testDd * 2 +
    Math.min(trainReturn, testReturn * 2) * 1.5;

  let status = "rejected";
  if (reasons.length === 0 && testTrades >= 10 && testPf >= 1.2 && testReturn > 0.5) {
    status = "candidate";
  } else if (
    testReturn > 0 &&
    testPf >= 1.05 &&
    testDd <= 15 &&
    testTrades >= 5
  ) {
    status = "watch";
  }

  return {
    score: Math.round(score * 100) / 100,
    status,
    reasons,
  };
}
