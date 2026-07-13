/**
 * ZenBlade Gold Index Strategy — Phase 2 threshold sweep.
 *
 * Research only:
 * - no live execution
 * - no paper-loop integration
 * - no real orders
 * - no private API keys
 *
 * Goal:
 * Test whether stronger 2D gold-proxy moves create better forward crypto returns.
 */

import fs from "node:fs";
import { fetchHistoricalCandles } from "../okxClient.js";

const BAR = process.env.GOLD_INDEX_BAR ?? "1D";
const TARGET_CANDLES = Number.parseInt(process.env.GOLD_INDEX_CANDLES ?? "500", 10);

const CRYPTO_SYMBOLS = parseCsv(
  process.env.GOLD_INDEX_CRYPTO_SYMBOLS ?? "BTC-USDT,ETH-USDT,SOL-USDT"
);

const GOLD_PROXIES = parseCsv(
  process.env.GOLD_INDEX_GOLD_PROXIES ?? "XAUT-USDT,PAXG-USDT"
);

const THRESHOLDS = parseCsv(process.env.GOLD_INDEX_THRESHOLDS ?? "0.7,1.0,1.5,2.0")
  .map(Number.parseFloat)
  .filter(Number.isFinite);

const HOLD_DAYS = parseCsv(process.env.GOLD_INDEX_HOLD_DAYS ?? "1,2,3,5")
  .map((value) => Number.parseInt(value, 10))
  .filter(Number.isFinite);

function parseCsv(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function dateKeyFromTime(time) {
  return new Date(time).toISOString().slice(0, 10);
}

function pctChange(candles, index, lookback) {
  if (!Array.isArray(candles) || index - lookback < 0) return null;

  const previous = candles[index - lookback]?.close;
  const current = candles[index]?.close;

  if (!Number.isFinite(previous) || !Number.isFinite(current) || previous <= 0) {
    return null;
  }

  return ((current - previous) / previous) * 100;
}

function forwardReturnPct(candles, index, holdDays) {
  if (!Array.isArray(candles) || index + holdDays >= candles.length) return null;

  const entry = candles[index]?.close;
  const exit = candles[index + holdDays]?.close;

  if (!Number.isFinite(entry) || !Number.isFinite(exit) || entry <= 0) {
    return null;
  }

  return ((exit - entry) / entry) * 100;
}

function maxAdversePct(candles, index, holdDays) {
  if (!Array.isArray(candles) || index + holdDays >= candles.length) return null;

  const entry = candles[index]?.close;
  if (!Number.isFinite(entry) || entry <= 0) return null;

  let minLow = Infinity;

  for (let i = index + 1; i <= index + holdDays; i++) {
    const low = candles[i]?.low;
    if (Number.isFinite(low)) minLow = Math.min(minLow, low);
  }

  if (!Number.isFinite(minLow)) return null;
  return ((minLow - entry) / entry) * 100;
}

function maxFavorablePct(candles, index, holdDays) {
  if (!Array.isArray(candles) || index + holdDays >= candles.length) return null;

  const entry = candles[index]?.close;
  if (!Number.isFinite(entry) || entry <= 0) return null;

  let maxHigh = -Infinity;

  for (let i = index + 1; i <= index + holdDays; i++) {
    const high = candles[i]?.high;
    if (Number.isFinite(high)) maxHigh = Math.max(maxHigh, high);
  }

  if (!Number.isFinite(maxHigh)) return null;
  return ((maxHigh - entry) / entry) * 100;
}

function avg(values) {
  const valid = values.filter(Number.isFinite);
  if (valid.length === 0) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function min(values) {
  const valid = values.filter(Number.isFinite);
  if (valid.length === 0) return null;
  return Math.min(...valid);
}

function hitRatePositive(values) {
  const valid = values.filter(Number.isFinite);
  if (valid.length === 0) return null;

  const wins = valid.filter((value) => value > 0).length;
  return (wins / valid.length) * 100;
}

async function loadCandles(symbol) {
  console.log(`Loading ${symbol} ${BAR} candles, target ${TARGET_CANDLES}...`);

  try {
    const candles = await fetchHistoricalCandles({
      symbol,
      bar: BAR,
      targetLimit: TARGET_CANDLES,
    });

    console.log(`${symbol}: loaded ${candles.length} candles`);
    return candles;
  } catch (error) {
    console.log(`${symbol}: failed to load candles — ${error.message}`);
    return [];
  }
}

function buildGoldMap(goldCandles) {
  const map = new Map();

  for (let i = 2; i < goldCandles.length; i++) {
    const candle = goldCandles[i];
    const goldChange2dPct = pctChange(goldCandles, i, 2);

    if (!Number.isFinite(goldChange2dPct)) continue;

    map.set(dateKeyFromTime(candle.time), {
      date: dateKeyFromTime(candle.time),
      goldClose: candle.close,
      goldChange2dPct,
    });
  }

  return map;
}

function buildCryptoMap(cryptoCandles) {
  const map = new Map();

  for (let i = 0; i < cryptoCandles.length; i++) {
    const candle = cryptoCandles[i];

    const record = {
      date: dateKeyFromTime(candle.time),
      cryptoClose: candle.close,
    };

    for (const holdDays of HOLD_DAYS) {
      record[`forward${holdDays}dPct`] = forwardReturnPct(cryptoCandles, i, holdDays);
      record[`mae${holdDays}dPct`] = maxAdversePct(cryptoCandles, i, holdDays);
      record[`mfe${holdDays}dPct`] = maxFavorablePct(cryptoCandles, i, holdDays);
    }

    map.set(record.date, record);
  }

  return map;
}

function alignRecords({ goldSymbol, goldCandles, cryptoSymbol, cryptoCandles }) {
  const goldMap = buildGoldMap(goldCandles);
  const cryptoMap = buildCryptoMap(cryptoCandles);
  const aligned = [];

  for (const [date, goldRecord] of goldMap.entries()) {
    const cryptoRecord = cryptoMap.get(date);
    if (!cryptoRecord) continue;

    aligned.push({
      goldSymbol,
      cryptoSymbol,
      date,
      goldClose: goldRecord.goldClose,
      goldChange2dPct: goldRecord.goldChange2dPct,
      cryptoClose: cryptoRecord.cryptoClose,
      ...Object.fromEntries(
        HOLD_DAYS.flatMap((holdDays) => [
          [`forward${holdDays}dPct`, cryptoRecord[`forward${holdDays}dPct`]],
          [`mae${holdDays}dPct`, cryptoRecord[`mae${holdDays}dPct`]],
          [`mfe${holdDays}dPct`, cryptoRecord[`mfe${holdDays}dPct`]],
        ])
      ),
    });
  }

  return aligned;
}

function summarize(records) {
  const summary = {
    count: records.length,
    avgGoldChange2dPct: round(avg(records.map((item) => item.goldChange2dPct))),
  };

  for (const holdDays of HOLD_DAYS) {
    summary[`avgForward${holdDays}dPct`] = round(
      avg(records.map((item) => item[`forward${holdDays}dPct`]))
    );

    summary[`hitRateForward${holdDays}dPct`] = round(
      hitRatePositive(records.map((item) => item[`forward${holdDays}dPct`])),
      1
    );

    summary[`avgMae${holdDays}dPct`] = round(
      avg(records.map((item) => item[`mae${holdDays}dPct`]))
    );

    summary[`worstMae${holdDays}dPct`] = round(
      min(records.map((item) => item[`mae${holdDays}dPct`]))
    );

    summary[`avgMfe${holdDays}dPct`] = round(
      avg(records.map((item) => item[`mfe${holdDays}dPct`]))
    );
  }

  return summary;
}

function evaluateCandidate({ baseline, signal }) {
  const sampleOk = signal.count >= 20;
  const avg2d = signal.avgForward2dPct;
  const base2d = baseline.avgForward2dPct;
  const hit2d = signal.hitRateForward2dPct;
  const mae2d = signal.avgMae2dPct;

  const edgeVsBaseline =
    Number.isFinite(avg2d) &&
    Number.isFinite(base2d) &&
    avg2d > base2d + 0.2;

  const positiveEdge = Number.isFinite(avg2d) && avg2d > 0.15;
  const hitOk = Number.isFinite(hit2d) && hit2d >= 52;
  const riskOk = !Number.isFinite(mae2d) || mae2d > -4;

  return sampleOk && edgeVsBaseline && positiveEdge && hitOk && riskOk;
}

function analyzePair({ goldSymbol, goldCandles, cryptoSymbol, cryptoCandles }) {
  const aligned = alignRecords({
    goldSymbol,
    goldCandles,
    cryptoSymbol,
    cryptoCandles,
  });

  const baseline = summarize(aligned);
  const rows = [];

  for (const threshold of THRESHOLDS) {
    const signals = aligned.filter(
      (item) =>
        Number.isFinite(item.goldChange2dPct) &&
        item.goldChange2dPct >= threshold
    );

    const signal = summarize(signals);
    const candidate = evaluateCandidate({ baseline, signal });

    rows.push({
      goldSymbol,
      cryptoSymbol,
      threshold,
      alignedDays: aligned.length,
      signalDays: signals.length,
      baseline,
      signal,
      edge2dPct:
        Number.isFinite(signal.avgForward2dPct) &&
        Number.isFinite(baseline.avgForward2dPct)
          ? round(signal.avgForward2dPct - baseline.avgForward2dPct)
          : null,
      candidate,
      interpretation: candidate
        ? "PROMISING_THRESHOLD: stronger gold-up condition improved 2D forward result enough for deeper research."
        : "NOT_CONFIRMED: threshold did not create enough forward edge or sample is too small.",
    });
  }

  return rows;
}

function writeReports({ sourceStatus, rows }) {
  fs.mkdirSync("reports", { recursive: true });

  const report = {
    strategyId: "gold-index",
    strategyName: "ZenBlade Gold Index Strategy",
    mode: "research_only",
    phase: "threshold_sweep",
    createdAt: new Date().toISOString(),
    config: {
      bar: BAR,
      targetCandles: TARGET_CANDLES,
      cryptoSymbols: CRYPTO_SYMBOLS,
      goldProxies: GOLD_PROXIES,
      thresholds: THRESHOLDS,
      holdDays: HOLD_DAYS,
    },
    sourceStatus,
    rows,
    restrictions: [
      "No live trading",
      "No real orders",
      "No private API keys",
      "No Railway paper-loop changes",
      "Reports are generated artifacts and should not be committed",
    ],
  };

  fs.writeFileSync(
    "reports/gold-index-threshold-sweep.json",
    JSON.stringify(report, null, 2)
  );

  const csvRows = [
    [
      "goldSymbol",
      "cryptoSymbol",
      "threshold",
      "alignedDays",
      "signalDays",
      "baselineAvg2d",
      "signalAvg2d",
      "edge2d",
      "signalHit2d",
      "signalAvgMae2d",
      "signalWorstMae2d",
      "signalAvgMfe2d",
      "candidate",
      "interpretation",
    ].join(","),
    ...rows.map((item) =>
      [
        item.goldSymbol,
        item.cryptoSymbol,
        item.threshold,
        item.alignedDays,
        item.signalDays,
        item.baseline.avgForward2dPct ?? "N/A",
        item.signal.avgForward2dPct ?? "N/A",
        item.edge2dPct ?? "N/A",
        item.signal.hitRateForward2dPct ?? "N/A",
        item.signal.avgMae2dPct ?? "N/A",
        item.signal.worstMae2dPct ?? "N/A",
        item.signal.avgMfe2dPct ?? "N/A",
        item.candidate,
        `"${item.interpretation}"`,
      ].join(",")
    ),
  ];

  fs.writeFileSync(
    "reports/gold-index-threshold-sweep.csv",
    `${csvRows.join("\n")}\n`
  );
}

export async function runGoldIndexThresholdSweep() {
  console.log("=== ZenBlade Gold Index Threshold Sweep ===");
  console.log("Mode: research only — no paper loop, no live trading, no real orders");
  console.log(`Bar: ${BAR}`);
  console.log(`Target candles: ${TARGET_CANDLES}`);
  console.log(`Crypto symbols: ${CRYPTO_SYMBOLS.join(", ")}`);
  console.log(`Gold proxies: ${GOLD_PROXIES.join(", ")}`);
  console.log(`Thresholds: ${THRESHOLDS.join(", ")}%`);
  console.log(`Hold days: ${HOLD_DAYS.join(", ")}`);
  console.log("");

  const cryptoData = {};
  for (const symbol of CRYPTO_SYMBOLS) {
    cryptoData[symbol] = await loadCandles(symbol);
  }

  console.log("");

  const goldData = {};
  for (const symbol of GOLD_PROXIES) {
    goldData[symbol] = await loadCandles(symbol);
  }

  const sourceStatus = {
    dxySource: "missing_in_repo",
    cryptoSources: Object.fromEntries(
      Object.entries(cryptoData).map(([symbol, candles]) => [
        symbol,
        {
          available: candles.length > 0,
          candles: candles.length,
          firstDate: candles[0] ? dateKeyFromTime(candles[0].time) : null,
          lastDate: candles.at(-1) ? dateKeyFromTime(candles.at(-1).time) : null,
        },
      ])
    ),
    goldProxySources: Object.fromEntries(
      Object.entries(goldData).map(([symbol, candles]) => [
        symbol,
        {
          available: candles.length > 0,
          candles: candles.length,
          firstDate: candles[0] ? dateKeyFromTime(candles[0].time) : null,
          lastDate: candles.at(-1) ? dateKeyFromTime(candles.at(-1).time) : null,
        },
      ])
    ),
  };

  const rows = [];

  for (const [goldSymbol, goldCandles] of Object.entries(goldData)) {
    if (goldCandles.length < 30) {
      console.log(`${goldSymbol}: not enough candles, skipping`);
      continue;
    }

    for (const [cryptoSymbol, cryptoCandles] of Object.entries(cryptoData)) {
      if (cryptoCandles.length < 30) {
        console.log(`${cryptoSymbol}: not enough candles, skipping`);
        continue;
      }

      rows.push(
        ...analyzePair({
          goldSymbol,
          goldCandles,
          cryptoSymbol,
          cryptoCandles,
        })
      );
    }
  }

  rows.sort((a, b) => {
    if (a.candidate !== b.candidate) return a.candidate ? -1 : 1;
    return (b.edge2dPct ?? -999) - (a.edge2dPct ?? -999);
  });

  console.log("");
  console.log("Top results:");
  for (const item of rows.slice(0, 12)) {
    console.log(
      `${item.goldSymbol} -> ${item.cryptoSymbol} | ` +
      `thr ${item.threshold}% | signals ${item.signalDays}/${item.alignedDays} | ` +
      `base2D ${item.baseline.avgForward2dPct ?? "N/A"}% | ` +
      `sig2D ${item.signal.avgForward2dPct ?? "N/A"}% | ` +
      `edge ${item.edge2dPct ?? "N/A"}% | ` +
      `hit ${item.signal.hitRateForward2dPct ?? "N/A"}% | ` +
      `avgMAE ${item.signal.avgMae2dPct ?? "N/A"}% | ` +
      `candidate ${item.candidate}`
    );
  }

  writeReports({ sourceStatus, rows });

  console.log("");
  console.log("Reports written:");
  console.log("- reports/gold-index-threshold-sweep.json");
  console.log("- reports/gold-index-threshold-sweep.csv");
  console.log("");
  console.log("Do not commit reports/.");

  return { sourceStatus, rows };
}

const isDirectRun =
  process.argv[1] && import.meta.url === "file://" + process.argv[1];

if (isDirectRun) {
  runGoldIndexThresholdSweep().catch((error) => {
    console.error("Gold Index threshold sweep failed:", error);
    process.exitCode = 1;
  });
}
