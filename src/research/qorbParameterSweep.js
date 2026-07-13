/**
 * QORB Parameter Sweep
 * Research only — no real orders, no live trading.
 *
 * Uses reports/qorb-missed-opportunities.json produced by:
 * QORB_PROFILE=basket QORB_CANDLES=1500 npm run research:qorb-missed
 *
 * Goal:
 * - compare possible QORB v2 filters;
 * - keep EXPIRED disabled;
 * - test score/change/status combinations before touching live paper loop.
 */

import fs from "node:fs";

const INPUT_REPORT = process.env.QORB_MISSED_REPORT ?? "reports/qorb-missed-opportunities.json";
const OUTPUT_JSON = "reports/qorb-parameter-sweep.json";
const OUTPUT_CSV = "reports/qorb-parameter-sweep.csv";

const STATUS_SETS = {
  strict: ["READY", "READY_LATE"],
  plus_watch: ["READY", "READY_LATE", "WATCH"],
  plus_wait: ["READY", "READY_LATE", "WAIT"],
  plus_watch_wait: ["READY", "READY_LATE", "WATCH", "WAIT"],
};

const SCORE_VALUES = (process.env.QORB_SWEEP_SCORES ?? "35,33,30,28")
  .split(",")
  .map((v) => Number.parseFloat(v.trim()))
  .filter(Number.isFinite);

const CHANGE_LOWER_VALUES = (process.env.QORB_SWEEP_CHANGE_LOWERS ?? "-20,-25,-30")
  .split(",")
  .map((v) => Number.parseFloat(v.trim()))
  .filter(Number.isFinite);

const CHANGE_UPPER = Number.parseFloat(process.env.QORB_SWEEP_CHANGE_UPPER ?? "5");

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function readReport() {
  if (!fs.existsSync(INPUT_REPORT)) {
    throw new Error(
      `Missing ${INPUT_REPORT}. Run first: QORB_PROFILE=basket QORB_CANDLES=1500 npm run research:qorb-missed`
    );
  }

  const data = JSON.parse(fs.readFileSync(INPUT_REPORT, "utf8"));

  if (!Array.isArray(data.records)) {
    throw new Error(`${INPUT_REPORT} does not contain records[]`);
  }

  return data;
}

function eventKey(record) {
  return [
    record.symbol,
    record.eventTime,
    record.eventPrice,
  ].join("|");
}

function isEligible(record, config) {
  if (record.status === "EXPIRED") return false;
  if (!config.allowedStatuses.includes(record.status)) return false;

  if ((record.score ?? -999) < config.minScore) return false;

  if (record.strategyLabel === "WATCH_ONLY") return false;

  const change = record.changeSinceEventPct;
  if (!Number.isFinite(change)) return false;

  if (change < config.changeLower) return false;
  if (change > config.changeUpper) return false;

  return true;
}

function selectTrades(records, config) {
  const sorted = [...records].sort(
    (a, b) => new Date(a.signalTime).getTime() - new Date(b.signalTime).getTime()
  );

  const selected = [];
  const usedEvents = new Set();

  for (const record of sorted) {
    if (!isEligible(record, config)) continue;

    const key = eventKey(record);
    if (usedEvents.has(key)) continue;

    usedEvents.add(key);
    selected.push(record);
  }

  return selected;
}

function analyze(records, config) {
  const selected = selectTrades(records, config);

  const count = selected.length;
  const tp = selected.filter((r) => r.simulatedOutcome === "TAKE_PROFIT").length;
  const sl = selected.filter((r) => r.simulatedOutcome === "STOP_LOSS").length;
  const timeExit = selected.filter((r) => r.simulatedOutcome === "TIME_EXIT").length;

  const wins = selected.filter((r) => (r.simulatedGrossPct ?? 0) > 0).length;
  const losses = selected.filter((r) => (r.simulatedGrossPct ?? 0) < 0).length;

  const grossPctSum = selected.reduce((sum, r) => sum + (r.simulatedGrossPct ?? 0), 0);
  const avgGrossPct = count > 0 ? grossPctSum / count : 0;

  const avgBounce24hPct =
    count > 0
      ? selected.reduce((sum, r) => sum + (r.maxBounce24hPct ?? 0), 0) / count
      : 0;

  const avgDrop24hPct =
    count > 0
      ? selected.reduce((sum, r) => sum + (r.maxDrop24hPct ?? 0), 0) / count
      : 0;

  const byStatus = {};
  for (const r of selected) {
    byStatus[r.status] ??= 0;
    byStatus[r.status] += 1;
  }

  return {
    configName: config.name,
    allowedStatuses: config.allowedStatuses.join("+"),
    minScore: config.minScore,
    changeLower: config.changeLower,
    changeUpper: config.changeUpper,

    trades: count,
    takeProfit: tp,
    stopLoss: sl,
    timeExit,
    wins,
    losses,
    winRatePct: count > 0 ? round((wins / count) * 100, 1) : 0,
    takeProfitRatePct: count > 0 ? round((tp / count) * 100, 1) : 0,
    stopLossRatePct: count > 0 ? round((sl / count) * 100, 1) : 0,
    totalGrossPct: round(grossPctSum, 2),
    avgGrossPct: round(avgGrossPct, 2),
    avgBounce24hPct: round(avgBounce24hPct, 2),
    avgDrop24hPct: round(avgDrop24hPct, 2),
    byStatus,
    selectedExamples: selected.slice(0, 5).map((r) => ({
      symbol: r.symbol,
      signalTime: r.signalTime,
      status: r.status,
      score: r.score,
      changeSinceEventPct: r.changeSinceEventPct,
      outcome: r.simulatedOutcome,
      grossPct: r.simulatedGrossPct,
      reason: r.reason,
    })),
  };
}

function recommendation(result) {
  if (result.trades < 10) return "too_few_trades";
  if (result.avgGrossPct <= 0) return "reject_negative_avg";
  if (result.stopLossRatePct >= 45) return "reject_too_many_stops";
  if (result.avgBounce24hPct >= 9) return "risky_high_bounce";
  if (result.winRatePct >= 60 && result.avgGrossPct >= 3) return "candidate";
  return "watch";
}

function csvValue(value) {
  if (value === null || value === undefined) return "";
  const s = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

function writeReports(results, inputMeta) {
  fs.mkdirSync("reports", { recursive: true });

  const ranked = [...results].sort((a, b) => {
    if (b.trades !== a.trades) {
      // Prefer enough trades, but not just the highest trade count.
      const aEnough = a.trades >= 10 ? 1 : 0;
      const bEnough = b.trades >= 10 ? 1 : 0;
      if (bEnough !== aEnough) return bEnough - aEnough;
    }

    if (b.avgGrossPct !== a.avgGrossPct) return b.avgGrossPct - a.avgGrossPct;
    return b.winRatePct - a.winRatePct;
  });

  fs.writeFileSync(
    OUTPUT_JSON,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        mode: "research / paper only — no real trading",
        inputReport: INPUT_REPORT,
        inputMeta,
        note: "EXPIRED is intentionally disabled in every tested config.",
        results: ranked,
      },
      null,
      2
    )
  );

  const headers = [
    "rank",
    "recommendation",
    "configName",
    "allowedStatuses",
    "minScore",
    "changeLower",
    "changeUpper",
    "trades",
    "wins",
    "losses",
    "winRatePct",
    "takeProfit",
    "stopLoss",
    "timeExit",
    "takeProfitRatePct",
    "stopLossRatePct",
    "totalGrossPct",
    "avgGrossPct",
    "avgBounce24hPct",
    "avgDrop24hPct",
    "byStatus",
  ];

  const rows = [
    headers.join(","),
    ...ranked.map((r, idx) =>
      headers.map((h) => {
        if (h === "rank") return idx + 1;
        if (h === "recommendation") return recommendation(r);
        return csvValue(r[h]);
      }).join(",")
    ),
  ];

  fs.writeFileSync(OUTPUT_CSV, `${rows.join("\n")}\n`);

  return ranked;
}

function printTop(ranked) {
  console.log("\n=== QORB Parameter Sweep Ranking ===");
  console.log("Mode: research / paper only — no real trading");
  console.log("EXPIRED: disabled in all configs");
  console.log("");

  for (const [idx, r] of ranked.slice(0, 15).entries()) {
    console.log(
      `#${idx + 1} ${recommendation(r)} | ${r.configName} | statuses ${r.allowedStatuses} | ` +
      `score>=${r.minScore} | change ${r.changeLower}..${r.changeUpper} | ` +
      `trades ${r.trades} | win ${r.winRatePct}% | TP ${r.takeProfit} | SL ${r.stopLoss} | ` +
      `avgGross ${r.avgGrossPct}% | bounce ${r.avgBounce24hPct}%`
    );
  }

  console.log("\nBaseline-like configs:");
  for (const r of ranked.filter(
    (x) =>
      x.allowedStatuses === "READY+READY_LATE" &&
      x.minScore === 35 &&
      x.changeLower === -20
  )) {
    console.log(
      `${r.configName} | trades ${r.trades} | win ${r.winRatePct}% | ` +
      `avgGross ${r.avgGrossPct}% | TP ${r.takeProfit} | SL ${r.stopLoss}`
    );
  }

  console.log("\nReports:");
  console.log(`- ${OUTPUT_JSON}`);
  console.log(`- ${OUTPUT_CSV}`);
}

function run() {
  const report = readReport();
  const records = report.records;

  console.log("=== ZenBlade QORB Parameter Sweep ===");
  console.log("Mode: research / paper only — no real trading");
  console.log(`Input: ${INPUT_REPORT}`);
  console.log(`Records: ${records.length}`);
  console.log("EXPIRED: disabled");
  console.log("");

  const configs = [];

  for (const [statusSetName, allowedStatuses] of Object.entries(STATUS_SETS)) {
    for (const minScore of SCORE_VALUES) {
      for (const changeLower of CHANGE_LOWER_VALUES) {
        configs.push({
          name: `${statusSetName}_score${minScore}_change${changeLower}`,
          allowedStatuses,
          minScore,
          changeLower,
          changeUpper: CHANGE_UPPER,
        });
      }
    }
  }

  const results = configs.map((config) => analyze(records, config));
  const ranked = writeReports(results, {
    profile: report.profile,
    totalRecords: records.length,
    sourceGeneratedAt: report.generatedAt,
    qorbConfig: report.config,
  });

  printTop(ranked);
}

const isDirectRun =
  process.argv[1] && import.meta.url === "file://" + process.argv[1];

if (isDirectRun) {
  try {
    run();
  } catch (err) {
    console.error("QORB parameter sweep failed:", err);
    process.exitCode = 1;
  }
}
