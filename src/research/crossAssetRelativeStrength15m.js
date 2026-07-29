/**
 * ZenBlade Cross-Asset Relative Strength 15m.
 *
 * Research only:
 * - no Railway integration
 * - no paper-loop integration
 * - no real orders
 * - no private API keys
 */

import fs from "node:fs";
import { fetchHistoricalCandles } from "../okxClient.js";

const SYMBOLS = (
  process.env.CROSS_RS_SYMBOLS ??
  "BTC-USDT,ETH-USDT,SOL-USDT"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const BAR = process.env.CROSS_RS_BAR ?? "15m";

const TARGET_CANDLES = Number.parseInt(
  process.env.CROSS_RS_CANDLES ?? "6000",
  10
);

const COST_PER_LEG_PCT = Number.parseFloat(
  process.env.CROSS_RS_COST_PCT ?? "0.20"
);

const LOOKBACKS = [16, 48, 96];

const HORIZONS = {
  "1h": 4,
  "4h": 16,
  "8h": 32,
  "12h": 48,
};

function round(value, decimals = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function mean(values) {
  const valid = values.filter(Number.isFinite);

  if (valid.length === 0) return null;

  return valid.reduce(
    (sum, value) => sum + value,
    0
  ) / valid.length;
}

function median(values) {
  const valid = values
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (valid.length === 0) return null;

  const middle = Math.floor(
    valid.length / 2
  );

  return valid.length % 2 === 0
    ? (
        valid[middle - 1] +
        valid[middle]
      ) / 2
    : valid[middle];
}

function pctChange(from, to) {
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from <= 0
  ) {
    return null;
  }

  return ((to - from) / from) * 100;
}

function tStat(values) {
  const valid = values.filter(Number.isFinite);

  if (valid.length < 2) return null;

  const average = mean(valid);

  const variance =
    valid.reduce(
      (sum, value) =>
        sum + (value - average) ** 2,
      0
    ) /
    (valid.length - 1);

  const stdDev = Math.sqrt(variance);

  if (!Number.isFinite(stdDev) || stdDev === 0) {
    return null;
  }

  return average /
    (stdDev / Math.sqrt(valid.length));
}

async function loadAlignedRows() {
  const maps = {};

  for (const symbol of SYMBOLS) {
    console.log(
      `Loading ${symbol} ${BAR}, target ${TARGET_CANDLES}...`
    );

    const candles =
      await fetchHistoricalCandles({
        symbol,
        bar: BAR,
        targetLimit: TARGET_CANDLES,
      });

    if (candles.length === 0) {
      throw new Error(
        `${symbol}: no candles loaded`
      );
    }

    maps[symbol] = new Map(
      candles.map((candle) => [
        candle.time,
        candle,
      ])
    );

    console.log(
      `${symbol}: ${candles.length} candles`
    );
  }

  const times = [
    ...maps[SYMBOLS[0]].keys(),
  ]
    .filter((time) =>
      SYMBOLS.every((symbol) =>
        maps[symbol].has(time)
      )
    )
    .sort((a, b) => a - b);

  return times.map((time) => ({
    time,
    candles: Object.fromEntries(
      SYMBOLS.map((symbol) => [
        symbol,
        maps[symbol].get(time),
      ])
    ),
  }));
}

function closeAt(rows, index, symbol) {
  return rows[index]?.candles?.[symbol]?.close;
}

function trailingReturn(
  rows,
  index,
  symbol,
  lookback
) {
  if (index - lookback < 0) return null;

  return pctChange(
    closeAt(
      rows,
      index - lookback,
      symbol
    ),
    closeAt(rows, index, symbol)
  );
}

function futureReturn(
  rows,
  index,
  symbol,
  horizon
) {
  if (index + horizon >= rows.length) {
    return null;
  }

  return pctChange(
    closeAt(rows, index, symbol),
    closeAt(
      rows,
      index + horizon,
      symbol
    )
  );
}

function buildSignal(rows, index) {
  const scores = Object.fromEntries(
    SYMBOLS.map((symbol) => [
      symbol,
      0,
    ])
  );

  for (const lookback of LOOKBACKS) {
    const returns = Object.fromEntries(
      SYMBOLS.map((symbol) => [
        symbol,
        trailingReturn(
          rows,
          index,
          symbol,
          lookback
        ),
      ])
    );

    if (
      Object.values(returns).some(
        (value) =>
          !Number.isFinite(value)
      )
    ) {
      return null;
    }

    const crossMean = mean(
      Object.values(returns)
    );

    for (const symbol of SYMBOLS) {
      scores[symbol] +=
        returns[symbol] - crossMean;
    }
  }

  for (const symbol of SYMBOLS) {
    scores[symbol] /= LOOKBACKS.length;
  }

  const ranked = [...SYMBOLS].sort(
    (a, b) => scores[b] - scores[a]
  );

  const market24h = mean(
    SYMBOLS.map((symbol) =>
      trailingReturn(
        rows,
        index,
        symbol,
        96
      )
    )
  );

  return {
    strongest: ranked[0],
    weakest: ranked.at(-1),
    regime:
      market24h >= 0
        ? "RISK_ON"
        : "RISK_OFF",
    market24h,
    scores,
  };
}

function summarize(observations) {
  const pairNet = observations.map(
    (item) => item.pairNetPct
  );

  const wins = pairNet.filter(
    (value) => value > 0
  ).length;

  return {
    observations: observations.length,

    strongestAvgFuturePct: round(
      mean(
        observations.map(
          (item) =>
            item.strongestFuturePct
        )
      )
    ),

    weakestAvgFuturePct: round(
      mean(
        observations.map(
          (item) =>
            item.weakestFuturePct
        )
      )
    ),

    longStrongAvgNetPct: round(
      mean(
        observations.map(
          (item) =>
            item.longStrongNetPct
        )
      )
    ),

    shortWeakAvgNetPct: round(
      mean(
        observations.map(
          (item) =>
            item.shortWeakNetPct
        )
      )
    ),

    pairAvgNetPct: round(
      mean(pairNet)
    ),

    pairMedianNetPct: round(
      median(pairNet)
    ),

    pairHitRatePct:
      observations.length > 0
        ? round(
            wins /
              observations.length *
              100,
            2
          )
        : null,

    pairTStatApprox: round(
      tStat(pairNet),
      3
    ),
  };
}

async function run() {
  console.log(
    "=== ZenBlade Cross-Asset Relative Strength 15m ==="
  );

  console.log(
    "Mode: research only — no real trading"
  );

  console.log(
    `Symbols: ${SYMBOLS.join(", ")}`
  );

  console.log(
    `Cost per leg: ${COST_PER_LEG_PCT}%`
  );

  const rows = await loadAlignedRows();

  console.log(
    `Aligned candles: ${rows.length}`
  );

  console.log(
    `Period: ${new Date(
      rows[0].time
    ).toISOString()} .. ${new Date(
      rows.at(-1).time
    ).toISOString()}`
  );

  const startIndex = Math.max(
    ...LOOKBACKS
  );

  const report = {
    generatedAt: new Date().toISOString(),

    mode:
      "research only — no paper-loop integration",

    config: {
      symbols: SYMBOLS,
      bar: BAR,
      targetCandles: TARGET_CANDLES,
      alignedCandles: rows.length,
      costPerLegPct:
        COST_PER_LEG_PCT,
      lookbacks: LOOKBACKS,
      horizons: HORIZONS,
    },

    results: {},
  };

  console.log(
    "\n=== NON-OVERLAPPING SUMMARY ==="
  );

  for (
    const [
      horizonName,
      horizonBars,
    ] of Object.entries(HORIZONS)
  ) {
    const observations = [];

    for (
      let index = startIndex;
      index + horizonBars < rows.length;
      index += horizonBars
    ) {
      const signal =
        buildSignal(rows, index);

      if (!signal) continue;

      const strongestFuture =
        futureReturn(
          rows,
          index,
          signal.strongest,
          horizonBars
        );

      const weakestFuture =
        futureReturn(
          rows,
          index,
          signal.weakest,
          horizonBars
        );

      if (
        !Number.isFinite(
          strongestFuture
        ) ||
        !Number.isFinite(
          weakestFuture
        )
      ) {
        continue;
      }

      observations.push({
        signalTime: new Date(
          rows[index].time
        ).toISOString(),

        regime: signal.regime,

        strongest:
          signal.strongest,

        weakest:
          signal.weakest,

        strongestFuturePct:
          strongestFuture,

        weakestFuturePct:
          weakestFuture,

        longStrongNetPct:
          strongestFuture -
          COST_PER_LEG_PCT,

        shortWeakNetPct:
          -weakestFuture -
          COST_PER_LEG_PCT,

        pairNetPct:
          strongestFuture -
          weakestFuture -
          COST_PER_LEG_PCT * 2,
      });
    }

    const allSummary =
      summarize(observations);

    const riskOnSummary = summarize(
      observations.filter(
        (item) =>
          item.regime === "RISK_ON"
      )
    );

    const riskOffSummary = summarize(
      observations.filter(
        (item) =>
          item.regime === "RISK_OFF"
      )
    );

    report.results[horizonName] = {
      all: allSummary,
      riskOn: riskOnSummary,
      riskOff: riskOffSummary,
    };

    console.log(
      `${horizonName} | ` +
      `n ${allSummary.observations} | ` +
      `longStrong ${allSummary.longStrongAvgNetPct}% | ` +
      `shortWeak ${allSummary.shortWeakAvgNetPct}% | ` +
      `pair ${allSummary.pairAvgNetPct}% | ` +
      `median ${allSummary.pairMedianNetPct}% | ` +
      `hit ${allSummary.pairHitRatePct}% | ` +
      `t~${allSummary.pairTStatApprox}`
    );
  }

  fs.mkdirSync(
    "reports",
    {
      recursive: true,
    }
  );

  fs.writeFileSync(
    "reports/cross-asset-relative-strength-15m.json",
    `${JSON.stringify(
      report,
      null,
      2
    )}\n`
  );

  console.log(
    "\nReport: reports/cross-asset-relative-strength-15m.json"
  );
}

run().catch((error) => {
  console.error(
    "Cross-asset research failed:",
    error
  );

  process.exitCode = 1;
});
