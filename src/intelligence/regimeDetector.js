function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function stddev(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function regimeKey(trend, volatility) {
  return `${trend}_${volatility}`;
}

export function classifyMarketRegime(candles, endIndex = candles.length - 1, options = {}) {
  const lookback = options.lookback ?? 96;
  const minLookback = options.minLookback ?? 48;
  const lowVolThresholdPct = options.lowVolThresholdPct ?? 1.0;
  const highVolThresholdPct = options.highVolThresholdPct ?? 2.5;
  const minTrendPct = options.minTrendPct ?? 0.4;
  const minEfficiency = options.minEfficiency ?? 0.18;

  if (!Array.isArray(candles) || candles.length === 0 || endIndex < 1) {
    return { trend: "unknown", volatility: "unknown", key: "unknown", confidence: 0 };
  }

  const safeEnd = Math.min(endIndex, candles.length - 1);
  const start = Math.max(0, safeEnd - lookback + 1);
  const window = candles.slice(start, safeEnd + 1);
  if (window.length < minLookback) {
    return { trend: "unknown", volatility: "unknown", key: "unknown", confidence: 0 };
  }

  const closes = window.map((candle) => Number(candle.close));
  const first = closes[0];
  const last = closes.at(-1);
  if (!(first > 0) || !(last > 0)) {
    return { trend: "unknown", volatility: "unknown", key: "unknown", confidence: 0 };
  }

  const logReturns = [];
  let pathDistance = 0;
  for (let index = 1; index < closes.length; index += 1) {
    if (!(closes[index - 1] > 0) || !(closes[index] > 0)) continue;
    logReturns.push(Math.log(closes[index] / closes[index - 1]));
    pathDistance += Math.abs(closes[index] - closes[index - 1]);
  }

  const trendPct = ((last / first) - 1) * 100;
  const directDistance = Math.abs(last - first);
  const efficiency = pathDistance > 0 ? directDistance / pathDistance : 0;
  const horizonVolPct = stddev(logReturns) * Math.sqrt(Math.max(logReturns.length, 1)) * 100;
  const adaptiveTrendThreshold = Math.max(minTrendPct, horizonVolPct * 0.35);

  let trend = "sideways";
  if (Math.abs(trendPct) >= adaptiveTrendThreshold && efficiency >= minEfficiency) {
    trend = trendPct > 0 ? "bull" : "bear";
  }

  let volatility = "normal_vol";
  if (horizonVolPct < lowVolThresholdPct) volatility = "low_vol";
  else if (horizonVolPct >= highVolThresholdPct) volatility = "high_vol";

  const trendStrength = adaptiveTrendThreshold > 0
    ? Math.min(2, Math.abs(trendPct) / adaptiveTrendThreshold)
    : 0;
  const confidence = Math.min(1, trendStrength * 0.45 + efficiency * 1.8 * 0.55);

  return {
    trend,
    volatility,
    key: regimeKey(trend, volatility),
    confidence: round(confidence, 3),
    trendPct: round(trendPct, 3),
    horizonVolPct: round(horizonVolPct, 3),
    efficiency: round(efficiency, 3),
    lookbackCandles: window.length,
  };
}

function candleIndexAtOrBefore(candles, timestamp) {
  let low = 0;
  let high = candles.length - 1;
  let answer = -1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (candles[mid].time <= timestamp) {
      answer = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return answer;
}

function summarizeBucket(bucket) {
  const grossWins = bucket.trades
    .filter((trade) => trade.netPnl > 0)
    .reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLosses = Math.abs(
    bucket.trades
      .filter((trade) => trade.netPnl < 0)
      .reduce((sum, trade) => sum + trade.netPnl, 0)
  );
  const netPnlUSDT = bucket.trades.reduce((sum, trade) => sum + trade.netPnl, 0);
  const wins = bucket.trades.filter((trade) => trade.netPnl > 0).length;

  return {
    trades: bucket.trades.length,
    wins,
    losses: bucket.trades.filter((trade) => trade.netPnl < 0).length,
    winRatePct: bucket.trades.length ? round((wins / bucket.trades.length) * 100, 2) : 0,
    netPnlUSDT: round(netPnlUSDT, 4),
    expectancyUSDT: bucket.trades.length ? round(netPnlUSDT / bucket.trades.length, 4) : 0,
    profitFactor: grossLosses > 0 ? round(grossWins / grossLosses, 3) : (grossWins > 0 ? 99 : 0),
  };
}

export function summarizeTradeRegimes(candles, trades, options = {}) {
  const buckets = new Map();
  const unknownTrades = [];

  for (const trade of trades ?? []) {
    const index = candleIndexAtOrBefore(candles, trade.entryTime);
    const regime = classifyMarketRegime(candles, index, options);
    if (regime.key === "unknown") {
      unknownTrades.push(trade);
      continue;
    }

    if (!buckets.has(regime.key)) {
      buckets.set(regime.key, { regime, trades: [] });
    }
    buckets.get(regime.key).trades.push(trade);
  }

  const byRegime = {};
  for (const [key, bucket] of buckets.entries()) {
    byRegime[key] = {
      regime: bucket.regime,
      ...summarizeBucket(bucket),
    };
  }

  const ranked = Object.entries(byRegime)
    .map(([key, value]) => ({ key, ...value }))
    .filter((item) => item.trades >= 2)
    .sort((a, b) => b.netPnlUSDT - a.netPnlUSDT);

  return {
    byRegime,
    regimesObserved: Object.keys(byRegime).length,
    unknownTrades: unknownTrades.length,
    bestRegime: ranked[0]?.key ?? null,
    worstRegime: ranked.at(-1)?.key ?? null,
    profitableRegimes: ranked.filter((item) => item.netPnlUSDT > 0).map((item) => item.key),
    losingRegimes: ranked.filter((item) => item.netPnlUSDT < 0).map((item) => item.key),
  };
}
