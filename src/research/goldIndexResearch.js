/**
 * ZenBlade Gold Index Strategy — Phase 1 research/data audit.
 *
 * Research only:
 * - no live execution
 * - no paper-loop integration
 * - no real orders
 * - no private API keys
 *
 * Goal:
 * Check whether OKX has usable gold proxy candles and test a simple question:
 * after gold-proxy rises over 2 days, do BTC/ETH/SOL have better forward returns?
 */

import fs from "node:fs";
import { fetchHistoricalCandles } from "../okxClient.js";

const BAR = process.env.GOLD_INDEX_BAR ?? "1D";
const TARGET_CANDLES = Number.parseInt(process.env.GOLD_INDEX_CANDLES ?? "500", 10);
const GOLD_MIN_2D_PCT = Number.parseFloat(process.env.GOLD_INDEX_MIN_GOLD_2D ?? "0.7");

const CRYPTO_SYMBOLS = parseCsv(
  process.env.GOLD_INDEX_CRYPTO_SYMBOLS ?? "BTC-USDT,ETH-USDT,SOL-USDT"
);

const GOLD_PROXIES = parseCsv(
  process.env.GOLD_INDEX_GOLD_PROXIES ?? "XAUT-USDT,PAXG-USDT"
);

const HOLD_DAYS = [1, 2, 3, 5];

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

function avg(values) {
  const valid = values.filter(Number.isFinite);
  if (valid.length === 0) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
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

function buildGoldSignalMap(goldCandles) {
  const map = new Map();

  for (let i = 2; i < goldCandles.length; i++) {
    const goldChange2dPct = pctChange(goldCandles, i, 2);
    if (!Number.isFinite(goldChange2dPct)) continue;

    const candle = goldCandles[i];

    map.set(dateKeyFromTime(candle.time), {
      date: dateKeyFromTime(candle.time),
      goldClose: candle.close,
      goldChange2dPct,
    });
  }

  return map;
}

function buildCryptoForwardMap(cryptoCandles) {
  const map = new Map();

  for (let i = 0; i < cryptoCandles.length; i++) {
    const candle = cryptoCandles[i];

    const record = {
      date: dateKeyFromTime(candle.time),
      cryptoClose: candle.close,
    };

    for (const holdDays of HOLD_DAYS) {
      record[`forward${holdDays}dPct`] = forwardReturnPct(cryptoCandles, i, holdDays);
    }

    map.set(record.date, record);
  }

  return map;
}

function summarizeRecords(records) {
  const summary = {
    count: records.length,
    avgGoldChange2dPct: round(avg(records.map((item) => item.goldChange2dPct))),
  };

  for (const holdDays of HOLD_DAYS) {
    const key = `forward${holdDays}dPct`;
    summary[`avgForward${holdDays}dPct`] = round(avg(records.map((item) => item[key])));
    summary[`hitRateForward${holdDays}dPct`] = round(hitRatePositive(records.map((item) => item[key])), 1);
  }

  return summary;
}

function analyzePair({ goldSymbol, goldCandles, cryptoSymbol, cryptoCandles }) {
  const goldSignals = buildGoldSignalMap(goldCandles);
  const cryptoForwards = buildCryptoForwardMap(cryptoCandles);

  const aligned = [];

  for (const [date, goldRecord] of goldSignals.entries()) {
    const cryptoRecord = cryptoForwards.get(date);
    if (!cryptoRecord) continue;

    aligned.push({
      goldSymbol,
      cryptoSymbol,
      date,
      goldClose: goldRecord.goldClose,
      goldChange2dPct: goldRecord.goldChange2dPct,
      cryptoClose: cryptoRecord.cryptoClose,
      forward1dPct: cryptoRecord.forward1dPct,
      forward2dPct: cryptoRecord.forward2dPct,
      forward3dPct: cryptoRecord.forward3dPct,
      forward5dPct: cryptoRecord.forward5dPct,
    });
  }

  const goldUpSignals = aligned.filter(
    (item) => Number.isFinite(item.goldChange2dPct) && item.goldChange2dPct >= GOLD_MIN_2D_PCT
  );

  const allStats = summarizeRecords(aligned);
  const signalStats = summarizeRecords(goldUpSignals);

  const candidate =
    signalStats.count >= 10 &&
    Number.isFinite(signalStats.avgForward2dPct) &&
    Number.isFinite(allStats.avgForward2dPct) &&
    signalStats.avgForward2dPct > allStats.avgForward2dPct &&
    signalStats.hitRateForward2dPct >= 50;

  return {
    goldSymbol,
    cryptoSymbol,
    threshold: {
      goldMin2dPct: GOLD_MIN_2D_PCT,
    },
    alignedDays: aligned.length,
    signalDays: goldUpSignals.length,
    allStats,
    signalStats,
    candidate,
    interpretation: candidate
      ? "PROMISING_DATA_SOURCE: gold-up 2D signal outperformed baseline on 2D forward return."
      : "NOT_CONFIRMED_YET: gold-up 2D signal did not clearly outperform baseline or sample is too small.",
  };
}

function writeReports({ sourceStatus, results }) {
  fs.mkdirSync("reports", { recursive: true });

  const report = {
    strategyId: "gold-index",
    strategyName: "ZenBlade Gold Index Strategy",
    mode: "research_only",
    phase: "data_audit_and_event_study",
    createdAt: new Date().toISOString(),
    config: {
      bar: BAR,
      targetCandles: TARGET_CANDLES,
      cryptoSymbols: CRYPTO_SYMBOLS,
      goldProxies: GOLD_PROXIES,
      goldMin2dPct: GOLD_MIN_2D_PCT,
      holdDays: HOLD_DAYS,
    },
    sourceStatus,
    results,
    restrictions: [
      "No live trading",
      "No real orders",
      "No private API keys",
      "No Railway paper-loop changes",
      "Reports are research artifacts and should not be committed",
    ],
  };

  fs.writeFileSync("reports/gold-index-research.json", JSON.stringify(report, null, 2));

  const rows = [
    [
      "goldSymbol",
      "cryptoSymbol",
      "alignedDays",
      "signalDays",
      "allAvgForward2dPct",
      "signalAvgForward2dPct",
      "signalHitRateForward2dPct",
      "candidate",
      "interpretation",
    ].join(","),
    ...results.map((item) =>
      [
        item.goldSymbol,
        item.cryptoSymbol,
        item.alignedDays,
        item.signalDays,
        item.allStats.avgForward2dPct ?? "N/A",
        item.signalStats.avgForward2dPct ?? "N/A",
        item.signalStats.hitRateForward2dPct ?? "N/A",
        item.candidate,
        `"${item.interpretation}"`,
      ].join(",")
    ),
  ];

  fs.writeFileSync("reports/gold-index-research.csv", `${rows.join("\n")}\n`);
}

export async function runGoldIndexResearch() {
  console.log("=== ZenBlade Gold Index Research ===");
  console.log("Mode: research only — no paper loop, no live trading, no real orders");
  console.log(`Bar: ${BAR}`);
  console.log(`Target candles: ${TARGET_CANDLES}`);
  console.log(`Gold 2D threshold: >= ${GOLD_MIN_2D_PCT}%`);
  console.log(`Crypto symbols: ${CRYPTO_SYMBOLS.join(", ")}`);
  console.log(`Gold proxy candidates: ${GOLD_PROXIES.join(", ")}`);
  console.log("");
  console.log("Important: DXY source is not implemented in this repo yet.");
  console.log("This phase tests only OKX gold-proxy availability and simple gold-up event behavior.");
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

  const results = [];

  for (const [goldSymbol, goldCandles] of Object.entries(goldData)) {
    if (goldCandles.length < 30) {
      console.log(`${goldSymbol}: not enough candles for research, skipping pair analysis`);
      continue;
    }

    for (const [cryptoSymbol, cryptoCandles] of Object.entries(cryptoData)) {
      if (cryptoCandles.length < 30) {
        console.log(`${cryptoSymbol}: not enough candles for research, skipping`);
        continue;
      }

      results.push(
        analyzePair({
          goldSymbol,
          goldCandles,
          cryptoSymbol,
          cryptoCandles,
        })
      );
    }
  }

  console.log("");
  console.log("Results:");

  if (results.length === 0) {
    console.log("No usable Gold Index pair results. Most likely no OKX gold proxy data was available.");
  }

  for (const item of results) {
    console.log(
      `${item.goldSymbol} -> ${item.cryptoSymbol} | ` +
      `aligned ${item.alignedDays} | signals ${item.signalDays} | ` +
      `all avg 2D ${item.allStats.avgForward2dPct ?? "N/A"}% | ` +
      `signal avg 2D ${item.signalStats.avgForward2dPct ?? "N/A"}% | ` +
      `hit ${item.signalStats.hitRateForward2dPct ?? "N/A"}% | ` +
      `candidate ${item.candidate}`
    );
  }

  writeReports({ sourceStatus, results });

  console.log("");
  console.log("Reports written:");
  console.log("- reports/gold-index-research.json");
  console.log("- reports/gold-index-research.csv");
  console.log("");
  console.log("Next: review report, then update research/memory/gold-index.json and docs/research-journal.md.");
  console.log("Do not commit reports/ unless explicitly needed.");

  return { sourceStatus, results };
}

const isDirectRun =
  process.argv[1] && import.meta.url === "file://" + process.argv[1];

if (isDirectRun) {
  runGoldIndexResearch().catch((error) => {
    console.error("Gold Index research failed:", error);
    process.exitCode = 1;
  });
}
