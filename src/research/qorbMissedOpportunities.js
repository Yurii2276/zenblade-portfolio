/**
 * QORB Missed Opportunities Audit
 * Research only — no real orders, no live trading.
 *
 * Goal:
 * - inspect QORB HOLD / rejected signals;
 * - measure what happened after READY / READY_LATE / WATCH / EXPIRED statuses;
 * - estimate whether missed shorts would have hit TP or SL in paper model.
 */

import fs from "node:fs";
import { config as baseConfig } from "../config.js";
import { fetchHistoricalCandles } from "../okxClient.js";
import { getQorbPumpReversalShortSignal } from "../strategies/qorbPumpReversalShort.js";

const TARGET_HTF_CANDLES = Number.parseInt(process.env.QORB_CANDLES ?? "3000", 10);
const QORB_PROFILE = process.env.QORB_PROFILE ?? "basket";
const QORB_SYMBOLS = (process.env.QORB_SYMBOLS ?? "")
  .split(",")
  .map((symbol) => symbol.trim())
  .filter(Boolean);

const QORB_PROFILES = {
  default: {},
  selected: {
    qorbMinPumpWeak: 12,
    qorbMinVolumeSpike: 1.3,
    qorbMinOpenScore: 35,
    qorbMinVolumeUSDT: 50000,
  },
  watch: {
    qorbMinPumpWeak: 12,
    qorbMinVolumeSpike: 1.3,
    qorbMinOpenScore: 35,
    qorbMinVolumeUSDT: 50000,
  },
  basket: {
    qorbMinPumpWeak: 12,
    qorbMinVolumeSpike: 1.3,
    qorbMinOpenScore: 35,
    qorbMinVolumeUSDT: 50000,
  },
};

const profileOverrides = QORB_PROFILES[QORB_PROFILE] ?? QORB_PROFILES.default;

const qorbConfig = {
  ...baseConfig,
  qorbMinPumpWeak: Number.parseFloat(
    process.env.QORB_MIN_PUMP_WEAK ??
      String(profileOverrides.qorbMinPumpWeak ?? baseConfig.qorbMinPumpWeak ?? 30)
  ),
  qorbMinVolumeSpike: Number.parseFloat(
    process.env.QORB_MIN_VOLUME_SPIKE ??
      String(profileOverrides.qorbMinVolumeSpike ?? baseConfig.qorbMinVolumeSpike ?? 3)
  ),
  qorbMinOpenScore: Number.parseFloat(
    process.env.QORB_MIN_OPEN_SCORE ??
      String(profileOverrides.qorbMinOpenScore ?? baseConfig.qorbMinOpenScore ?? 70)
  ),
  qorbMinVolumeUSDT: Number.parseFloat(
    process.env.QORB_MIN_VOLUME_USDT ??
      String(profileOverrides.qorbMinVolumeUSDT ?? baseConfig.qorbMinVolumeUSDT ?? 300000)
  ),
  paperOnly: true,
};

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function toIso(time) {
  if (!Number.isFinite(time)) return String(time);
  return new Date(time).toISOString();
}

function pctChange(from, to) {
  if (!from || from === 0) return 0;
  return ((to - from) / from) * 100;
}

function getSymbols() {
  if (QORB_SYMBOLS.length > 0) return QORB_SYMBOLS;

  if (QORB_PROFILE === "selected") {
    return baseConfig.qorbSelectedSymbols ?? baseConfig.qorbSymbols ?? baseConfig.symbols;
  }

  if (QORB_PROFILE === "watch") {
    return baseConfig.qorbWatchSymbols ??
      baseConfig.qorbSelectedSymbols ??
      baseConfig.qorbSymbols ??
      baseConfig.symbols;
  }

  if (QORB_PROFILE === "basket") {
    return baseConfig.qorbBasketSymbols ??
      baseConfig.qorbWatchSymbols ??
      baseConfig.qorbSelectedSymbols ??
      baseConfig.qorbSymbols ??
      baseConfig.symbols;
  }

  return baseConfig.qorbSymbols ?? baseConfig.symbols;
}

function futureWindowStats({ candles, entryIndex, entryPrice, horizonsHours }) {
  const timeframeHours = qorbConfig.qorbTimeframeHours ?? 1;
  const out = {};

  for (const hours of horizonsHours) {
    const candlesForward = Math.ceil(hours / timeframeHours);
    const endIndex = Math.min(candles.length - 1, entryIndex + candlesForward);

    if (endIndex <= entryIndex) {
      out[`${hours}h`] = null;
      continue;
    }

    const future = candles.slice(entryIndex + 1, endIndex + 1);
    const minLow = Math.min(...future.map((c) => c.low));
    const maxHigh = Math.max(...future.map((c) => c.high));
    const lastClose = future[future.length - 1].close;

    out[`${hours}h`] = {
      maxDropPct: round(pctChange(entryPrice, minLow) * -1),
      maxBouncePct: round(pctChange(entryPrice, maxHigh)),
      shortCloseReturnPct: round(pctChange(lastClose, entryPrice)),
      lastClose: round(lastClose, 8),
    };
  }

  return out;
}

function simulateShortOutcome({ candles, entryIndex, entryPrice }) {
  const timeframeHours = qorbConfig.qorbTimeframeHours ?? 1;
  const tpPct = qorbConfig.qorbTpPct ?? 15;
  const slPct = qorbConfig.qorbSlPct ?? 10;
  const maxHoldHours = qorbConfig.qorbMaxHoldHours ?? 72;
  const maxHoldCandles = Math.ceil(maxHoldHours / timeframeHours);

  const takePrice = entryPrice * (1 - tpPct / 100);
  const stopPrice = entryPrice * (1 + slPct / 100);
  const endIndex = Math.min(candles.length - 1, entryIndex + maxHoldCandles);

  for (let i = entryIndex + 1; i <= endIndex; i += 1) {
    const candle = candles[i];

    const stopHit = candle.high >= stopPrice;
    const takeHit = candle.low <= takePrice;

    // Conservative rule: if both TP and SL are inside the same candle, count SL first.
    if (stopHit) {
      return {
        outcome: "STOP_LOSS",
        exitTime: toIso(candle.time),
        exitPrice: round(stopPrice, 8),
        grossPct: round(-slPct),
        hoursHeld: round((i - entryIndex) * timeframeHours),
      };
    }

    if (takeHit) {
      return {
        outcome: "TAKE_PROFIT",
        exitTime: toIso(candle.time),
        exitPrice: round(takePrice, 8),
        grossPct: round(tpPct),
        hoursHeld: round((i - entryIndex) * timeframeHours),
      };
    }
  }

  const last = candles[endIndex];
  const grossPct = pctChange(last.close, entryPrice);

  return {
    outcome: "TIME_EXIT",
    exitTime: toIso(last.time),
    exitPrice: round(last.close, 8),
    grossPct: round(grossPct),
    hoursHeld: round((endIndex - entryIndex) * timeframeHours),
  };
}

async function auditSymbol(symbol) {
  console.log(`Loading ${symbol} 1H candles (target ${TARGET_HTF_CANDLES})...`);

  const candles = await fetchHistoricalCandles({
    symbol,
    bar: baseConfig.htfBar,
    targetLimit: TARGET_HTF_CANDLES,
  });

  if (candles.length === 0) {
    console.log(`${symbol}: no candles loaded`);
    return [];
  }

  console.log(`${symbol}: ${candles.length} candles loaded`);

  const pumpLookback = qorbConfig.qorbPumpLookbackHours ?? 24;
  const volumeLookback = qorbConfig.qorbVolumeLookbackHours ?? 24;
  const minStart = pumpLookback + volumeLookback + 5;

  const records = [];
  const seen = new Set();

  for (let i = minStart; i < candles.length - 1; i += 1) {
    const historicalCandles = candles.slice(0, i + 1);
    const signal = getQorbPumpReversalShortSignal({
      candles: historicalCandles,
      config: qorbConfig,
    });

    const indicators = signal.indicators;
    if (!indicators?.eventKey || !indicators.status) continue;

    const key = `${symbol}|${indicators.eventKey}|${indicators.status}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const currentCandle = candles[i];
    const entryPrice = currentCandle.close;
    const forward = futureWindowStats({
      candles,
      entryIndex: i,
      entryPrice,
      horizonsHours: [1, 3, 6, 12, 24],
    });

    const simulated = simulateShortOutcome({
      candles,
      entryIndex: i,
      entryPrice,
    });

    records.push({
      symbol,
      signalTime: toIso(currentCandle.time),
      action: signal.action,
      reason: signal.reason,
      status: indicators.status,
      strategyLabel: indicators.strategyLabel,
      score: indicators.score,
      pump24h: indicators.pump24h,
      ageHours: indicators.ageHours,
      changeSinceEventPct: indicators.changeSinceEventPct,
      volumeSpike: indicators.volumeSpike,
      volumeUSDT: indicators.volumeUSDT,
      eventTime: toIso(indicators.eventTimestamp),
      eventPrice: indicators.eventPrice,
      signalPrice: round(entryPrice, 8),
      maxDrop24hPct: forward["24h"]?.maxDropPct ?? null,
      maxBounce24hPct: forward["24h"]?.maxBouncePct ?? null,
      shortCloseReturn24hPct: forward["24h"]?.shortCloseReturnPct ?? null,
      simulatedOutcome: simulated.outcome,
      simulatedGrossPct: simulated.grossPct,
      simulatedHoursHeld: simulated.hoursHeld,
      simulatedExitPrice: simulated.exitPrice,
      simulatedExitTime: simulated.exitTime,
      forward,
    });
  }

  console.log(`${symbol}: audit records ${records.length}`);
  return records;
}

function summarize(records) {
  const byStatus = {};

  for (const r of records) {
    byStatus[r.status] ??= {
      count: 0,
      sellShortSignals: 0,
      takeProfit: 0,
      stopLoss: 0,
      timeExit: 0,
      positiveSimulated: 0,
      grossPctSum: 0,
      maxDrop24hSum: 0,
      maxBounce24hSum: 0,
    };

    const s = byStatus[r.status];
    s.count += 1;
    if (r.action === "SELL_SHORT") s.sellShortSignals += 1;
    if (r.simulatedOutcome === "TAKE_PROFIT") s.takeProfit += 1;
    if (r.simulatedOutcome === "STOP_LOSS") s.stopLoss += 1;
    if (r.simulatedOutcome === "TIME_EXIT") s.timeExit += 1;
    if ((r.simulatedGrossPct ?? 0) > 0) s.positiveSimulated += 1;
    s.grossPctSum += r.simulatedGrossPct ?? 0;
    s.maxDrop24hSum += r.maxDrop24hPct ?? 0;
    s.maxBounce24hSum += r.maxBounce24hPct ?? 0;
  }

  for (const s of Object.values(byStatus)) {
    s.winRatePct = s.count > 0 ? round((s.positiveSimulated / s.count) * 100, 1) : 0;
    s.takeProfitRatePct = s.count > 0 ? round((s.takeProfit / s.count) * 100, 1) : 0;
    s.stopLossRatePct = s.count > 0 ? round((s.stopLoss / s.count) * 100, 1) : 0;
    s.avgSimulatedGrossPct = s.count > 0 ? round(s.grossPctSum / s.count, 2) : 0;
    s.avgMaxDrop24hPct = s.count > 0 ? round(s.maxDrop24hSum / s.count, 2) : 0;
    s.avgMaxBounce24hPct = s.count > 0 ? round(s.maxBounce24hSum / s.count, 2) : 0;

    delete s.grossPctSum;
    delete s.maxDrop24hSum;
    delete s.maxBounce24hSum;
  }

  return byStatus;
}

function csvValue(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

function writeReports({ records, summary }) {
  fs.mkdirSync("reports", { recursive: true });

  fs.writeFileSync(
    "reports/qorb-missed-opportunities.json",
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        mode: "research / paper only — no real trading",
        profile: QORB_PROFILE,
        config: {
          qorbMinPumpWeak: qorbConfig.qorbMinPumpWeak,
          qorbMinVolumeSpike: qorbConfig.qorbMinVolumeSpike,
          qorbMinOpenScore: qorbConfig.qorbMinOpenScore,
          qorbMinVolumeUSDT: qorbConfig.qorbMinVolumeUSDT,
          qorbTpPct: qorbConfig.qorbTpPct,
          qorbSlPct: qorbConfig.qorbSlPct,
          qorbMaxHoldHours: qorbConfig.qorbMaxHoldHours,
        },
        summary,
        records,
      },
      null,
      2
    )
  );

  const headers = [
    "symbol",
    "signalTime",
    "status",
    "action",
    "reason",
    "strategyLabel",
    "score",
    "pump24h",
    "ageHours",
    "changeSinceEventPct",
    "volumeSpike",
    "signalPrice",
    "maxDrop24hPct",
    "maxBounce24hPct",
    "shortCloseReturn24hPct",
    "simulatedOutcome",
    "simulatedGrossPct",
    "simulatedHoursHeld",
  ];

  const rows = [
    headers.join(","),
    ...records.map((r) =>
      headers.map((h) => csvValue(r[h])).join(",")
    ),
  ];

  fs.writeFileSync("reports/qorb-missed-opportunities.csv", `${rows.join("\n")}\n`);
}

function printSummary(summary, records) {
  console.log("\n=== QORB Missed Opportunities Summary ===");
  console.log("Mode: research / paper only — no real trading");
  console.log(`Total audit records: ${records.length}`);
  console.log("");

  for (const [status, s] of Object.entries(summary)) {
    console.log(
      `${status} | count ${s.count} | TP ${s.takeProfit} | SL ${s.stopLoss} | ` +
      `win ${s.winRatePct}% | avgGross ${s.avgSimulatedGrossPct}% | ` +
      `avgDrop24h ${s.avgMaxDrop24hPct}% | avgBounce24h ${s.avgMaxBounce24hPct}%`
    );
  }

  const bestMissed = records
    .filter((r) => r.action !== "SELL_SHORT")
    .sort((a, b) => (b.simulatedGrossPct ?? -999) - (a.simulatedGrossPct ?? -999))
    .slice(0, 10);

  const worstAvoided = records
    .filter((r) => r.action !== "SELL_SHORT")
    .sort((a, b) => (a.simulatedGrossPct ?? 999) - (b.simulatedGrossPct ?? 999))
    .slice(0, 10);

  console.log("\nBest missed paper shorts:");
  for (const r of bestMissed) {
    console.log(
      `${r.symbol} | ${r.status} | ${r.signalTime} | gross ${r.simulatedGrossPct}% | ` +
      `${r.simulatedOutcome} | reason: ${r.reason}`
    );
  }

  console.log("\nWorst avoided paper shorts:");
  for (const r of worstAvoided) {
    console.log(
      `${r.symbol} | ${r.status} | ${r.signalTime} | gross ${r.simulatedGrossPct}% | ` +
      `${r.simulatedOutcome} | reason: ${r.reason}`
    );
  }
}

async function run() {
  const symbols = getSymbols();

  console.log("=== ZenBlade QORB Missed Opportunities Audit ===");
  console.log("Mode: research / paper only — no real trading");
  console.log(`Profile: ${QORB_PROFILE}`);
  console.log(`Symbols: ${symbols.join(", ")}`);
  console.log(`Target candles: ${TARGET_HTF_CANDLES}`);
  console.log(
    `Filters: pump >= ${qorbConfig.qorbMinPumpWeak}% | ` +
    `volumeSpike >= ${qorbConfig.qorbMinVolumeSpike} | ` +
    `score >= ${qorbConfig.qorbMinOpenScore} | ` +
    `minVolumeUSDT >= ${qorbConfig.qorbMinVolumeUSDT}`
  );
  console.log("");

  const records = [];

  for (const symbol of symbols) {
    const symbolRecords = await auditSymbol(symbol);
    records.push(...symbolRecords);
  }

  const summary = summarize(records);
  printSummary(summary, records);
  writeReports({ records, summary });

  console.log("\nReports:");
  console.log("- reports/qorb-missed-opportunities.json");
  console.log("- reports/qorb-missed-opportunities.csv");
}

const isDirectRun =
  process.argv[1] && import.meta.url === "file://" + process.argv[1];

if (isDirectRun) {
  run().catch((err) => {
    console.error("QORB missed opportunities audit failed:", err);
    process.exitCode = 1;
  });
}
