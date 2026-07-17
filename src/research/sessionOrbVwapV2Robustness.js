import fs from "node:fs";
import path from "node:path";
import { runSessionOrbVwapV2Research } from "./sessionOrbVwapV2Research.js";

/**
 * Frozen-parameter robustness diagnostic for Session ORB + VWAP Reclaim v2.
 *
 * Research only. This script does not tune parameters and does not touch
 * Railway, paper trading, API keys, or real orders.
 *
 * It runs the existing v2 backtest, then evaluates the generated trades across:
 * - three chronological windows;
 * - symbols and sides;
 * - exit reasons;
 * - fee sensitivity while retaining the v2 slippage-adjusted fill prices.
 */

const REPORT_JSON = "reports/session-orb-vwap-v2-robustness.json";
const REPORT_CSV = "reports/session-orb-vwap-v2-robustness.csv";
const WINDOW_COUNT = Number.parseInt(process.env.SESSION_ORB_VWAP_V2_WINDOWS ?? "3", 10);
const FEE_RATES = (process.env.SESSION_ORB_VWAP_V2_FEE_RATES ?? "0.0004,0.0006,0.0008,0.001")
  .split(",")
  .map((value) => Number.parseFloat(value.trim()))
  .filter(Number.isFinite);

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function sum(values) {
  return values.reduce((acc, value) => acc + (Number.isFinite(value) ? value : 0), 0);
}

function summarizeTrades(trades) {
  const wins = trades.filter((trade) => trade.netPnl > 0);
  const losses = trades.filter((trade) => trade.netPnl < 0);
  const positiveNet = sum(wins.map((trade) => trade.netPnl));
  const negativeNet = Math.abs(sum(losses.map((trade) => trade.netPnl)));

  return {
    trades: trades.length,
    winRatePct: trades.length > 0 ? round((wins.length / trades.length) * 100, 1) : null,
    grossPnl: round(sum(trades.map((trade) => trade.grossPnl))),
    fees: round(sum(trades.map((trade) => trade.fees))),
    netPnl: round(sum(trades.map((trade) => trade.netPnl))),
    profitFactor: negativeNet > 0 ? round(positiveNet / negativeNet, 2) : null,
    avgHoldMinutes:
      trades.length > 0 ? round(sum(trades.map((trade) => trade.holdMinutes)) / trades.length, 1) : null,
  };
}

function summarizeBy(trades, keySelector) {
  const groups = new Map();
  for (const trade of trades) {
    const key = keySelector(trade) ?? "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trade);
  }

  return Array.from(groups.entries())
    .map(([key, rows]) => ({ key, ...summarizeTrades(rows) }))
    .sort((a, b) => b.netPnl - a.netPnl);
}

function buildTimeWindows(trades, count) {
  const timestamps = trades
    .map((trade) => Number(trade.entryTime))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (timestamps.length === 0 || count <= 0) return [];

  const minTime = timestamps[0];
  const maxTime = timestamps[timestamps.length - 1];
  const span = Math.max(1, maxTime - minTime + 1);
  const width = span / count;

  return Array.from({ length: count }, (_, index) => {
    const start = minTime + width * index;
    const end = index === count - 1 ? maxTime + 1 : minTime + width * (index + 1);
    return {
      id: `window_${index + 1}`,
      start,
      end,
      startIso: new Date(start).toISOString(),
      endIso: new Date(end - 1).toISOString(),
    };
  });
}

function recalculateAtFeeRate(trades, feeRate) {
  const recalculated = trades.map((trade) => {
    const notional = (trade.entryPrice + trade.closePrice) * trade.size;
    const fees = notional * feeRate;
    const netPnl = trade.grossPnl - fees;
    return { ...trade, fees, netPnl };
  });
  return { feeRate, ...summarizeTrades(recalculated) };
}

function analyzeScenario({ scenarioId, trades, windows }) {
  const overall = summarizeTrades(trades);
  const chronologicalWindows = windows.map((window) => {
    const windowTrades = trades.filter(
      (trade) => trade.entryTime >= window.start && trade.entryTime < window.end
    );
    return {
      windowId: window.id,
      startIso: window.startIso,
      endIso: window.endIso,
      ...summarizeTrades(windowTrades),
    };
  });

  const positiveWindows = chronologicalWindows.filter((window) => window.netPnl > 0).length;
  const nonNegativeWindows = chronologicalWindows.filter((window) => window.netPnl >= 0).length;
  const feeSensitivity = FEE_RATES.map((feeRate) => recalculateAtFeeRate(trades, feeRate));
  const currentFee = feeSensitivity.find((row) => Math.abs(row.feeRate - 0.0008) < 1e-10);
  const higherFee = feeSensitivity.find((row) => Math.abs(row.feeRate - 0.001) < 1e-10);

  const robustnessPass =
    overall.trades >= 20 &&
    overall.netPnl > 0 &&
    (overall.profitFactor === null || overall.profitFactor >= 1.1) &&
    positiveWindows >= Math.ceil(windows.length * 2 / 3) &&
    (currentFee?.netPnl ?? overall.netPnl) > 0 &&
    (higherFee?.netPnl ?? -Infinity) >= 0;

  return {
    scenarioId,
    robustnessPass,
    overall,
    positiveWindows,
    nonNegativeWindows,
    totalWindows: windows.length,
    chronologicalWindows,
    bySymbol: summarizeBy(trades, (trade) => trade.symbol),
    bySide: summarizeBy(trades, (trade) => trade.side),
    byEntryHourUtc: summarizeBy(trades, (trade) => trade.entryHourUtc),
    byExitReason: summarizeBy(trades, (trade) => trade.closeReason),
    feeSensitivity,
  };
}

function writeReports(payload) {
  fs.mkdirSync(path.dirname(REPORT_JSON), { recursive: true });
  fs.writeFileSync(REPORT_JSON, `${JSON.stringify(payload, null, 2)}\n`);

  const rows = [
    [
      "scenarioId",
      "robustnessPass",
      "trades",
      "grossPnl",
      "fees",
      "netPnl",
      "profitFactor",
      "positiveWindows",
      "totalWindows",
      "fee0008Net",
      "fee0010Net",
    ].join(","),
  ];

  for (const scenario of payload.scenarios) {
    const fee0008 = scenario.feeSensitivity.find((row) => Math.abs(row.feeRate - 0.0008) < 1e-10);
    const fee0010 = scenario.feeSensitivity.find((row) => Math.abs(row.feeRate - 0.001) < 1e-10);
    rows.push(
      [
        scenario.scenarioId,
        scenario.robustnessPass,
        scenario.overall.trades,
        scenario.overall.grossPnl,
        scenario.overall.fees,
        scenario.overall.netPnl,
        scenario.overall.profitFactor,
        scenario.positiveWindows,
        scenario.totalWindows,
        fee0008?.netPnl ?? "",
        fee0010?.netPnl ?? "",
      ].join(",")
    );
  }

  fs.writeFileSync(REPORT_CSV, `${rows.join("\n")}\n`);
}

function printScenario(result) {
  console.log(
    `${result.scenarioId} | trades ${result.overall.trades} | net ${result.overall.netPnl} | PF ${result.overall.profitFactor} | positive windows ${result.positiveWindows}/${result.totalWindows} | robustness ${result.robustnessPass}`
  );
  for (const window of result.chronologicalWindows) {
    console.log(
      `  ${window.windowId} | ${window.startIso.slice(0, 10)}..${window.endIso.slice(0, 10)} | trades ${window.trades} | net ${window.netPnl} | PF ${window.profitFactor}`
    );
  }
  console.log(
    `  fee sensitivity: ${result.feeSensitivity
      .map((row) => `${row.feeRate}=>${row.netPnl}`)
      .join(" | ")}`
  );
}

async function main() {
  console.log("=== Session ORB + VWAP Reclaim v2 Robustness ===");
  console.log("Mode: frozen-parameter research diagnostic only");
  console.log("Safety: no Railway changes, no live trading, no API keys, no real orders");

  const run = await runSessionOrbVwapV2Research();
  const allTrades = run.rawResults.flatMap((result) => result.trades ?? []);
  const windows = buildTimeWindows(allTrades, WINDOW_COUNT);
  const scenarioIds = Array.from(new Set(run.rawResults.map((result) => result.scenarioId)));

  const scenarios = scenarioIds.map((scenarioId) => {
    const trades = run.rawResults
      .filter((result) => result.scenarioId === scenarioId)
      .flatMap((result) => result.trades ?? [])
      .sort((a, b) => a.entryTime - b.entryTime);
    return analyzeScenario({ scenarioId, trades, windows });
  });

  const payload = {
    strategyId: "session-orb-vwap-v2-robustness",
    generatedAt: new Date().toISOString(),
    safety: {
      researchOnly: true,
      parametersFrozen: true,
      railwayTouched: false,
      liveTrading: false,
      realOrders: false,
      apiKeysRequired: false,
    },
    methodology: {
      windows: WINDOW_COUNT,
      windowDefinition: "equal chronological spans over generated v2 trades",
      feeRates: FEE_RATES,
      slippageNote: "Uses the v2 slippage-adjusted entry and exit prices; fee sensitivity recalculates fees only.",
      limitation: "Trade-level chronological validation; cooldown state can cross a window boundary because entries are generated in one frozen full-history run.",
    },
    windows,
    scenarios,
  };

  for (const scenario of scenarios) printScenario(scenario);
  writeReports(payload);

  console.log("\nReports:");
  console.log(`- ${REPORT_JSON}`);
  console.log(`- ${REPORT_CSV}`);

  if (scenarios.some((scenario) => scenario.robustnessPass)) {
    console.log("\nAt least one scenario passed the frozen-parameter robustness gate.");
    console.log("Do not integrate yet; next step is an independent out-of-sample or forward paper observation.");
  } else {
    console.log("\nNo scenario passed the frozen-parameter robustness gate. Do not integrate into paper loop.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
