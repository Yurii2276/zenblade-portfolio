/**
 * ZenBlade Macro Gold + DXY — Phase 4 walk-forward / window validation.
 *
 * Research only:
 * - no live execution
 * - no paper-loop integration
 * - no real orders
 * - no private API keys
 *
 * Validates the strongest Phase 3 scenario:
 * - DXY 2D change <= -0.3%
 * - XAUT 2D change >= +1.0%
 */

import fs from "node:fs";
import { fetchHistoricalCandles } from "../okxClient.js";

const BAR = process.env.MACRO_WF_BAR ?? "1D";
const TARGET_CANDLES = Number.parseInt(process.env.MACRO_WF_CANDLES ?? "500", 10);
const LOOKBACK_DAYS = Number.parseInt(process.env.MACRO_WF_LOOKBACK_DAYS ?? "2", 10);
const WINDOW_COUNT = Number.parseInt(process.env.MACRO_WF_WINDOWS ?? "5", 10);

const MAX_ABS_MACRO_CHANGE_2D_PCT = Number.parseFloat(
  process.env.MACRO_WF_MAX_ABS_MACRO_CHANGE_2D_PCT ?? "5"
);

const DXY_MAX_2D_PCT = Number.parseFloat(process.env.MACRO_WF_DXY_MAX_2D_PCT ?? "-0.3");
const XAUT_MIN_2D_PCT = Number.parseFloat(process.env.MACRO_WF_XAUT_MIN_2D_PCT ?? "1.0");

const CRYPTO_SYMBOLS = parseCsv(process.env.MACRO_WF_CRYPTO_SYMBOLS ?? "ETH-USDT,BTC-USDT,SOL-USDT");
const GOLD_SYMBOL = process.env.MACRO_WF_GOLD_SYMBOL ?? "XAUT-USDT";
const DXY_SYMBOL = process.env.MACRO_WF_DXY_SYMBOL ?? "DX-Y.NYB";
const HOLD_DAYS = parseCsv(process.env.MACRO_WF_HOLD_DAYS ?? "1,2,3,5")
  .map((value) => Number.parseInt(value, 10))
  .filter(Number.isFinite);

function parseCsv(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
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

  if (!Number.isFinite(previous) || !Number.isFinite(current) || previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

function forwardReturnPct(candles, index, holdDays) {
  if (!Array.isArray(candles) || index + holdDays >= candles.length) return null;

  const entry = candles[index]?.close;
  const exit = candles[index + holdDays]?.close;

  if (!Number.isFinite(entry) || !Number.isFinite(exit) || entry <= 0) return null;
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
  return (valid.filter((value) => value > 0).length / valid.length) * 100;
}

async function loadOkxCandles(symbol) {
  console.log(`Loading OKX ${symbol} ${BAR} candles, target ${TARGET_CANDLES}...`);

  const candles = await fetchHistoricalCandles({
    symbol,
    bar: BAR,
    targetLimit: TARGET_CANDLES,
  });

  console.log(`${symbol}: loaded ${candles.length} candles`);
  return candles;
}

async function loadYahooDailyCandles(label, symbol) {
  console.log(`Loading Yahoo ${label} (${symbol}) daily candles...`);

  const range = process.env.MACRO_WF_YAHOO_RANGE ?? "2y";
  const encoded = encodeURIComponent(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?range=${range}&interval=1d`;

  const response = await fetch(url, {
    headers: { "user-agent": "ZenBladeResearch/1.0" },
  });

  if (!response.ok) {
    console.log(`${label}: Yahoo HTTP ${response.status}, returning empty dataset`);
    return [];
  }

  const json = await response.json();
  const result = json?.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];

  if (!result?.timestamp?.length || !quote) {
    console.log(`${label}: no Yahoo quote data`);
    return [];
  }

  const candles = result.timestamp
    .map((seconds, index) => {
      const close = Number(quote.close?.[index]);

      // Yahoo may return zero-close placeholders. These create fake DXY -100% moves.
      if (!Number.isFinite(close) || close <= 0) return null;

      const open = Number(quote.open?.[index]);
      const high = Number(quote.high?.[index]);
      const low = Number(quote.low?.[index]);
      const volume = Number(quote.volume?.[index] ?? 0);

      return {
        time: seconds * 1000,
        open: Number.isFinite(open) && open > 0 ? open : close,
        high: Number.isFinite(high) && high > 0 ? high : close,
        low: Number.isFinite(low) && low > 0 ? low : close,
        close,
        volume: Number.isFinite(volume) ? volume : 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);

  console.log(`${label}: loaded ${candles.length} cleaned candles`);
  return candles;
}

function buildIndicatorMap(candles, lookbackDays, { filterExtremeMacro = false } = {}) {
  const map = new Map();

  for (let i = lookbackDays; i < candles.length; i++) {
    const candle = candles[i];
    const change2dPct = pctChange(candles, i, lookbackDays);

    if (!Number.isFinite(change2dPct)) continue;

    if (
      filterExtremeMacro &&
      Math.abs(change2dPct) > MAX_ABS_MACRO_CHANGE_2D_PCT
    ) {
      continue;
    }

    map.set(dateKeyFromTime(candle.time), {
      date: dateKeyFromTime(candle.time),
      close: candle.close,
      change2dPct,
    });
  }

  return map;
}

function buildCryptoForwardRows(candles, symbol) {
  const rows = [];

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];

    const row = {
      symbol,
      date: dateKeyFromTime(candle.time),
      time: candle.time,
      close: candle.close,
    };

    for (const holdDays of HOLD_DAYS) {
      row[`forward${holdDays}dPct`] = forwardReturnPct(candles, i, holdDays);
      row[`mae${holdDays}dPct`] = maxAdversePct(candles, i, holdDays);
      row[`mfe${holdDays}dPct`] = maxFavorablePct(candles, i, holdDays);
    }

    rows.push(row);
  }

  return rows;
}

function passesStrictMacro(row, dxyMap, goldMap) {
  const dxy = dxyMap.get(row.date);
  const gold = goldMap.get(row.date);

  if (!dxy || !gold) return false;
  if (dxy.change2dPct > DXY_MAX_2D_PCT) return false;
  if (gold.change2dPct < XAUT_MIN_2D_PCT) return false;

  return true;
}

function withMacroFields(row, dxyMap, goldMap) {
  const dxy = dxyMap.get(row.date);
  const gold = goldMap.get(row.date);

  return {
    ...row,
    dxyChange2dPct: dxy?.change2dPct ?? null,
    goldChange2dPct: gold?.change2dPct ?? null,
  };
}

function summarizeRows(rows) {
  const summary = {
    days: rows.length,
    avgDxyChange2dPct: round(avg(rows.map((item) => item.dxyChange2dPct))),
    avgGoldChange2dPct: round(avg(rows.map((item) => item.goldChange2dPct))),
  };

  for (const holdDays of HOLD_DAYS) {
    summary[`avgForward${holdDays}dPct`] = round(
      avg(rows.map((item) => item[`forward${holdDays}dPct`]))
    );
    summary[`hitRateForward${holdDays}dPct`] = round(
      hitRatePositive(rows.map((item) => item[`forward${holdDays}dPct`])),
      1
    );
    summary[`avgMae${holdDays}dPct`] = round(
      avg(rows.map((item) => item[`mae${holdDays}dPct`]))
    );
    summary[`worstMae${holdDays}dPct`] = round(
      min(rows.map((item) => item[`mae${holdDays}dPct`]))
    );
    summary[`avgMfe${holdDays}dPct`] = round(
      avg(rows.map((item) => item[`mfe${holdDays}dPct`]))
    );
  }

  return summary;
}

function splitRowsIntoWindows(rows) {
  const sorted = [...rows].sort((a, b) => a.time - b.time);
  const size = Math.floor(sorted.length / WINDOW_COUNT);
  const windows = [];

  for (let i = 0; i < WINDOW_COUNT; i++) {
    const start = i * size;
    const end = i === WINDOW_COUNT - 1 ? sorted.length : start + size;
    const windowRows = sorted.slice(start, end);

    windows.push({
      window: i + 1,
      startDate: windowRows[0]?.date ?? null,
      endDate: windowRows.at(-1)?.date ?? null,
      rows: windowRows,
    });
  }

  return windows;
}

function analyzeSymbol({ symbol, cryptoCandles, dxyMap, goldMap }) {
  const rows = buildCryptoForwardRows(cryptoCandles, symbol);
  const windows = splitRowsIntoWindows(rows);

  const totalBaselineRows = rows;
  const totalSignalRows = rows
    .filter((row) => passesStrictMacro(row, dxyMap, goldMap))
    .map((row) => withMacroFields(row, dxyMap, goldMap));

  const totalBaseline = summarizeRows(totalBaselineRows);
  const totalSignal = summarizeRows(totalSignalRows);

  const windowResults = windows.map((window) => {
    const baselineRows = window.rows;
    const signalRows = window.rows
      .filter((row) => passesStrictMacro(row, dxyMap, goldMap))
      .map((row) => withMacroFields(row, dxyMap, goldMap));

    const baseline = summarizeRows(baselineRows);
    const signal = summarizeRows(signalRows);

    const edge2dPct =
      Number.isFinite(signal.avgForward2dPct) &&
      Number.isFinite(baseline.avgForward2dPct)
        ? round(signal.avgForward2dPct - baseline.avgForward2dPct)
        : null;

    return {
      symbol,
      window: window.window,
      startDate: window.startDate,
      endDate: window.endDate,
      baseline,
      signal,
      edge2dPct,
      positiveEdge2d: Number.isFinite(edge2dPct) && edge2dPct > 0,
      positiveSignal2d: Number.isFinite(signal.avgForward2dPct) && signal.avgForward2dPct > 0,
    };
  });

  const windowsWithSignals = windowResults.filter((item) => item.signal.days > 0).length;
  const positiveEdgeWindows = windowResults.filter((item) => item.positiveEdge2d).length;
  const positiveSignalWindows = windowResults.filter((item) => item.positiveSignal2d).length;

  const totalEdge2dPct =
    Number.isFinite(totalSignal.avgForward2dPct) &&
    Number.isFinite(totalBaseline.avgForward2dPct)
      ? round(totalSignal.avgForward2dPct - totalBaseline.avgForward2dPct)
      : null;

  const candidate =
    totalSignal.days >= 25 &&
    windowsWithSignals >= Math.min(4, WINDOW_COUNT) &&
    positiveEdgeWindows >= Math.min(3, WINDOW_COUNT) &&
    positiveSignalWindows >= Math.min(3, WINDOW_COUNT) &&
    Number.isFinite(totalSignal.avgForward2dPct) &&
    totalSignal.avgForward2dPct > 0.3 &&
    Number.isFinite(totalEdge2dPct) &&
    totalEdge2dPct > 0.3 &&
    Number.isFinite(totalSignal.hitRateForward2dPct) &&
    totalSignal.hitRateForward2dPct >= 53 &&
    (!Number.isFinite(totalSignal.avgMae2dPct) || totalSignal.avgMae2dPct > -4);

  return {
    symbol,
    scenario: "dxy_down_gold_up_strict",
    goldSymbol: GOLD_SYMBOL,
    dxySymbol: DXY_SYMBOL,
    thresholds: {
      dxyMax2dPct: DXY_MAX_2D_PCT,
      goldMin2dPct: XAUT_MIN_2D_PCT,
    },
    totalBaseline,
    totalSignal,
    totalEdge2dPct,
    windows: windowResults,
    windowSummary: {
      windowCount: WINDOW_COUNT,
      windowsWithSignals,
      positiveEdgeWindows,
      positiveSignalWindows,
    },
    candidate,
    interpretation: candidate
      ? "WALK_FORWARD_PROMISING: signal survived window validation requirements."
      : "NOT_VALIDATED: signal did not survive window validation requirements.",
  };
}

function writeReports({ sourceStatus, results }) {
  fs.mkdirSync("reports", { recursive: true });

  const report = {
    strategyId: "macro-gold-dxy-index",
    strategyName: "ZenBlade Macro Gold + DXY Walk-Forward Research",
    mode: "research_only",
    phase: "phase4_walk_forward_validation",
    createdAt: new Date().toISOString(),
    config: {
      bar: BAR,
      targetCandles: TARGET_CANDLES,
      lookbackDays: LOOKBACK_DAYS,
      windowCount: WINDOW_COUNT,
      dxySymbol: DXY_SYMBOL,
      goldSymbol: GOLD_SYMBOL,
      cryptoSymbols: CRYPTO_SYMBOLS,
      holdDays: HOLD_DAYS,
      dxyMax2dPct: DXY_MAX_2D_PCT,
      xautMin2dPct: XAUT_MIN_2D_PCT,
      maxAbsMacroChange2dPct: MAX_ABS_MACRO_CHANGE_2D_PCT,
    },
    sourceStatus,
    results,
    restrictions: [
      "No live trading",
      "No real orders",
      "No private API keys",
      "No Railway paper-loop changes",
      "Reports are generated artifacts and should not be committed",
    ],
  };

  fs.writeFileSync(
    "reports/macro-gold-dxy-walk-forward.json",
    JSON.stringify(report, null, 2)
  );

  const rows = [
    [
      "symbol",
      "candidate",
      "signalDays",
      "baselineAvg2d",
      "signalAvg2d",
      "edge2d",
      "hit2d",
      "avgMae2d",
      "worstMae2d",
      "windowsWithSignals",
      "positiveEdgeWindows",
      "positiveSignalWindows",
      "interpretation",
    ].join(","),
    ...results.map((item) =>
      [
        item.symbol,
        item.candidate,
        item.totalSignal.days,
        item.totalBaseline.avgForward2dPct ?? "N/A",
        item.totalSignal.avgForward2dPct ?? "N/A",
        item.totalEdge2dPct ?? "N/A",
        item.totalSignal.hitRateForward2dPct ?? "N/A",
        item.totalSignal.avgMae2dPct ?? "N/A",
        item.totalSignal.worstMae2dPct ?? "N/A",
        item.windowSummary.windowsWithSignals,
        item.windowSummary.positiveEdgeWindows,
        item.windowSummary.positiveSignalWindows,
        `"${item.interpretation}"`,
      ].join(",")
    ),
  ];

  fs.writeFileSync("reports/macro-gold-dxy-walk-forward.csv", `${rows.join("\n")}\n`);

  const windowRows = [
    [
      "symbol",
      "window",
      "startDate",
      "endDate",
      "signalDays",
      "baselineAvg2d",
      "signalAvg2d",
      "edge2d",
      "hit2d",
      "avgMae2d",
      "worstMae2d",
      "positiveEdge2d",
      "positiveSignal2d",
    ].join(","),
    ...results.flatMap((item) =>
      item.windows.map((window) =>
        [
          item.symbol,
          window.window,
          window.startDate,
          window.endDate,
          window.signal.days,
          window.baseline.avgForward2dPct ?? "N/A",
          window.signal.avgForward2dPct ?? "N/A",
          window.edge2dPct ?? "N/A",
          window.signal.hitRateForward2dPct ?? "N/A",
          window.signal.avgMae2dPct ?? "N/A",
          window.signal.worstMae2dPct ?? "N/A",
          window.positiveEdge2d,
          window.positiveSignal2d,
        ].join(",")
      )
    ),
  ];

  fs.writeFileSync(
    "reports/macro-gold-dxy-walk-forward-windows.csv",
    `${windowRows.join("\n")}\n`
  );
}

export async function runMacroGoldDxyWalkForward() {
  console.log("=== ZenBlade Macro Gold + DXY Walk-Forward Validation ===");
  console.log("Mode: research only — no paper loop, no live trading, no real orders");
  console.log(`Scenario: DXY ${DXY_MAX_2D_PCT}% or lower over 2D + XAUT ${XAUT_MIN_2D_PCT}% or higher over 2D`);
  console.log(`Windows: ${WINDOW_COUNT}`);
  console.log(`Crypto symbols: ${CRYPTO_SYMBOLS.join(", ")}`);
  console.log("");

  const dxyCandles = await loadYahooDailyCandles("dxy", DXY_SYMBOL);
  const xautCandles = await loadOkxCandles(GOLD_SYMBOL);

  const dxyMap = buildIndicatorMap(dxyCandles, LOOKBACK_DAYS, { filterExtremeMacro: true });
  const goldMap = buildIndicatorMap(xautCandles, LOOKBACK_DAYS, { filterExtremeMacro: false });

  const cryptoData = {};
  for (const symbol of CRYPTO_SYMBOLS) {
    cryptoData[symbol] = await loadOkxCandles(symbol);
  }

  const sourceStatus = {
    dxy: {
      symbol: DXY_SYMBOL,
      candles: dxyCandles.length,
      mappedDays: dxyMap.size,
      firstDate: dxyCandles[0] ? dateKeyFromTime(dxyCandles[0].time) : null,
      lastDate: dxyCandles.at(-1) ? dateKeyFromTime(dxyCandles.at(-1).time) : null,
    },
    gold: {
      symbol: GOLD_SYMBOL,
      candles: xautCandles.length,
      mappedDays: goldMap.size,
      firstDate: xautCandles[0] ? dateKeyFromTime(xautCandles[0].time) : null,
      lastDate: xautCandles.at(-1) ? dateKeyFromTime(xautCandles.at(-1).time) : null,
    },
    crypto: Object.fromEntries(
      Object.entries(cryptoData).map(([symbol, candles]) => [
        symbol,
        {
          candles: candles.length,
          firstDate: candles[0] ? dateKeyFromTime(candles[0].time) : null,
          lastDate: candles.at(-1) ? dateKeyFromTime(candles.at(-1).time) : null,
        },
      ])
    ),
  };

  const results = Object.entries(cryptoData)
    .filter(([, candles]) => candles.length >= 30)
    .map(([symbol, candles]) =>
      analyzeSymbol({
        symbol,
        cryptoCandles: candles,
        dxyMap,
        goldMap,
      })
    )
    .sort((a, b) => {
      if (a.candidate !== b.candidate) return a.candidate ? -1 : 1;
      return (b.totalEdge2dPct ?? -999) - (a.totalEdge2dPct ?? -999);
    });

  console.log("");
  console.log("Summary:");
  for (const item of results) {
    console.log(
      `${item.symbol} | candidate ${item.candidate} | signals ${item.totalSignal.days} | ` +
      `base2D ${item.totalBaseline.avgForward2dPct ?? "N/A"}% | ` +
      `sig2D ${item.totalSignal.avgForward2dPct ?? "N/A"}% | ` +
      `edge ${item.totalEdge2dPct ?? "N/A"}% | ` +
      `hit ${item.totalSignal.hitRateForward2dPct ?? "N/A"}% | ` +
      `avgMAE ${item.totalSignal.avgMae2dPct ?? "N/A"}% | ` +
      `windows signals ${item.windowSummary.windowsWithSignals}/${WINDOW_COUNT} | ` +
      `edge+ ${item.windowSummary.positiveEdgeWindows}/${WINDOW_COUNT}`
    );

    for (const window of item.windows) {
      console.log(
        `  W${window.window} ${window.startDate}..${window.endDate} | ` +
        `signals ${window.signal.days} | base2D ${window.baseline.avgForward2dPct ?? "N/A"}% | ` +
        `sig2D ${window.signal.avgForward2dPct ?? "N/A"}% | edge ${window.edge2dPct ?? "N/A"}% | ` +
        `hit ${window.signal.hitRateForward2dPct ?? "N/A"}%`
      );
    }
  }

  writeReports({ sourceStatus, results });

  console.log("");
  console.log("Reports written:");
  console.log("- reports/macro-gold-dxy-walk-forward.json");
  console.log("- reports/macro-gold-dxy-walk-forward.csv");
  console.log("- reports/macro-gold-dxy-walk-forward-windows.csv");
  console.log("");
  console.log("Do not commit reports/.");
  console.log("No paper-loop changes were made.");

  return { sourceStatus, results };
}

const isDirectRun =
  process.argv[1] && import.meta.url === "file://" + process.argv[1];

if (isDirectRun) {
  runMacroGoldDxyWalkForward().catch((error) => {
    console.error("Macro Gold + DXY walk-forward failed:", error);
    process.exitCode = 1;
  });
}
