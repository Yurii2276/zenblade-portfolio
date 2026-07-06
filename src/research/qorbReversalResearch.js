/**
 * QORB Pump Reversal Short — research/backtest script.
 * Tests the qorbPumpReversalShort strategy on historical 1H candles.
 * Research only — no real orders, paperOnly: true.
 */

import fs from "node:fs";
import { config as baseConfig } from "../config.js";
import { fetchHistoricalCandles, fetchOkxUsdtSpotSymbols } from "../okxClient.js";
import { getQorbPumpReversalShortSignal } from "../strategies/qorbPumpReversalShort.js";
import { calculateShortTrade } from "../riskManager.js";
import { closeResearchTrade } from "./tradeAccounting.js";

const INITIAL_BALANCE = baseConfig.initialBalance ?? 1000;
const TARGET_HTF_CANDLES = Number.parseInt(process.env.QORB_CANDLES ?? "3000", 10);
const QORB_SYMBOLS = (process.env.QORB_SYMBOLS ?? "")
  .split(",")
  .map((symbol) => symbol.trim())
  .filter(Boolean);

const QORB_PROFILE = process.env.QORB_PROFILE ?? "default";
const QORB_MAX_SYMBOLS = Number.parseInt(process.env.QORB_MAX_SYMBOLS ?? "40", 10);

const QORB_PROFILES = {
  default: {},
  selected: {
    qorbMinPumpWeak: 12,
    qorbMinVolumeSpike: 1.3,
    qorbMinOpenScore: 35,
    qorbMinVolumeUSDT: 50000,
  },
  auto: {
    qorbMinPumpWeak: 12,
    qorbMinVolumeSpike: 1.3,
    qorbMinOpenScore: 35,
    qorbMinVolumeUSDT: 50000,
  },
};

const profileOverrides = QORB_PROFILES[QORB_PROFILE] ?? QORB_PROFILES.default;

// Build a config overlay with QORB defaults merged
const qorbConfig = {
  ...baseConfig,
  symbols: [],

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

function calcMaxDrawdown(equityCurve) {
  let peak = equityCurve[0] ?? INITIAL_BALANCE;
  let maxDD = 0;
  for (const v of equityCurve) {
    if (v > peak) peak = v;
    maxDD = Math.max(maxDD, peak - v);
  }
  return round(maxDD);
}

function calcStats(trades, equity) {
  const wins   = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl < 0);
  const netPnl   = round(trades.reduce((s, t) => s + t.netPnl, 0));
  const winPnl   = wins.reduce((s, t) => s + t.netPnl, 0);
  const lossPnl  = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));

  return {
    trades:       trades.length,
    wins:         wins.length,
    losses:       losses.length,
    winRate:      trades.length > 0 ? round((wins.length / trades.length) * 100, 1) : null,
    netPnl,
    profitFactor: lossPnl > 0 ? round(winPnl / lossPnl) : (wins.length > 0 ? null : 0),
    maxDrawdown:  calcMaxDrawdown(equity),
    fees:         round(trades.reduce((s, t) => s + t.fees, 0)),
  };
}

function isCandidate(stats) {
  const pf = stats.profitFactor;
  const pfOk = pf === null ? true : pf > 1.1; // null = wins with no losses
  return (
    stats.trades >= 5 &&
    stats.netPnl > 0 &&
    pfOk &&
    stats.winRate != null &&
    stats.winRate >= 40
  );
}

async function backtestSymbol(symbol) {
  console.log(`Loading ${symbol} 1H candles (target ${TARGET_HTF_CANDLES})...`);
  const candles = await fetchHistoricalCandles({
    symbol,
    bar: baseConfig.htfBar, // "1H"
    targetLimit: TARGET_HTF_CANDLES,
  });

  if (candles.length === 0) {
    console.log(`${symbol}: no candles loaded, skipping`);
    return null;
  }

  console.log(`${symbol}: ${candles.length} 1H candles loaded`);

  const pumpLookback = qorbConfig.qorbPumpLookbackHours ?? 24;
  const minStart     = pumpLookback + 5;
  const maxHoldCandles = Math.ceil(
    (qorbConfig.qorbMaxHoldHours ?? 72) / (qorbConfig.qorbTimeframeHours ?? 1)
  );

  let balance     = INITIAL_BALANCE;
  let openPosition = null;
  const trades    = [];
  const equity    = [INITIAL_BALANCE];
  const usedEventKeys = new Set();

  for (let i = minStart; i < candles.length; i++) {
    const currentCandle = candles[i];

    // ── Manage open position ─────────────────────────────────────────────────
    if (openPosition) {
      const hitTake = currentCandle.low  <= openPosition.takePrice;
      const hitStop = currentCandle.high >= openPosition.stopPrice;
      const heldTooLong = (i - openPosition.entryIndex) >= maxHoldCandles;
      const isLast = i === candles.length - 1;

      let closeReason = null;
      let closePrice  = null;

      if (hitTake) {
        closeReason = "TAKE_PROFIT";
        closePrice  = openPosition.takePrice;
      } else if (hitStop) {
        closeReason = "STOP_LOSS";
        closePrice  = openPosition.stopPrice;
      } else if (heldTooLong) {
        closeReason = "TIME_EXIT";
        closePrice  = currentCandle.close;
      } else if (isLast) {
        closeReason = "END_OF_TEST";
        closePrice  = currentCandle.close;
      }

      if (closeReason) {
        openPosition.closeTime = currentCandle.time;
        const closed = closeResearchTrade({
          position:    openPosition,
          closePrice,
          closeReason,
          balance,
          feeRate: qorbConfig.feeRate,
        });
        balance = closed.balance;
        trades.push(closed.trade);
        equity.push(balance);
        openPosition = null;
      }

      if (closeReason && closeReason !== "END_OF_TEST") continue;
      if (openPosition) continue;
    }

    // ── Check for new entry ──────────────────────────────────────────────────
    const historicalCandles = candles.slice(0, i + 1);
    const signal = getQorbPumpReversalShortSignal({
      candles: historicalCandles,
      config:  qorbConfig,
    });

    if (signal.action !== "SELL_SHORT") continue;
    if (!signal.indicators) continue;
    if (signal.indicators.eventKey && usedEventKeys.has(signal.indicators.eventKey)) continue;

    const entryPrice = currentCandle.close;
    const tpPct  = qorbConfig.qorbTpPct  ?? 15;
    const slPct  = qorbConfig.qorbSlPct  ?? 10;

    // Percentage-based TP/SL (QORB style)
    const takePrice = round(entryPrice * (1 - tpPct / 100));
    const stopPrice = round(entryPrice * (1 + slPct / 100));

    // Size from calculateShortTrade (ATR-based risk management)
    const atr14   = signal.indicators.atr14 ?? entryPrice * 0.02;
    const planned = calculateShortTrade({
      balance,
      entryPrice,
      atr: atr14,
      config: qorbConfig,
    });

    if (planned.size > 0 && planned.positionValue > 0) {
      openPosition = {
        side:         "SHORT",
        entryTime:    currentCandle.time,
        entryIndex:   i,
        entryPrice,
        stopPrice,   // % based
        takePrice,   // % based
        size:         planned.size,
        eventKey:     signal.indicators.eventKey,
      };

      if (signal.indicators.eventKey) {
        usedEventKeys.add(signal.indicators.eventKey);
      }
    }
  }

  return calcStats(trades, equity);
}

async function resolveQorbSymbols() {
  if (QORB_SYMBOLS.length > 0) {
    return QORB_SYMBOLS;
  }

  if (QORB_PROFILE === "selected") {
    return baseConfig.qorbSelectedSymbols ?? baseConfig.qorbSymbols ?? baseConfig.symbols;
  }

  if (QORB_PROFILE === "auto") {
    const symbols = await fetchOkxUsdtSpotSymbols({ maxSymbols: QORB_MAX_SYMBOLS });
    return symbols.length > 0 ? symbols : (baseConfig.qorbSymbols ?? baseConfig.symbols);
  }

  return baseConfig.qorbSymbols ?? baseConfig.symbols;
}

function printResult(symbol, stats) {
  const pfStr  = stats.profitFactor === null ? "∞" : (stats.profitFactor ?? "N/A");
  const wrStr  = stats.winRate !== null ? `${stats.winRate}%` : "N/A";
  const cand   = isCandidate(stats);
  console.log(
    `${symbol} | trades ${stats.trades} | pnl ${stats.netPnl} USDT | ` +
    `PF ${pfStr} | win ${wrStr} | maxDD ${stats.maxDrawdown} | ` +
    `fees ${stats.fees} | candidate ${cand}`
  );
}

function writeReports(allResults) {
  fs.mkdirSync("reports", { recursive: true });

  fs.writeFileSync(
    "reports/qorb-reversal-research.json",
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        mode:        "research / paper only",
        timeframe:   "1H",
        note:        "No real trading. Research only.",
        results:     allResults,
      },
      null,
      2
    )
  );

  const csvRows = [
    "symbol,trades,wins,losses,winRate,netPnl,profitFactor,maxDrawdown,fees,candidate",
    ...allResults.map(({ symbol, stats }) =>
      [
        symbol,
        stats.trades,
        stats.wins,
        stats.losses,
        stats.winRate ?? "N/A",
        stats.netPnl,
        stats.profitFactor ?? "N/A",
        stats.maxDrawdown,
        stats.fees,
        isCandidate(stats),
      ].join(",")
    ),
  ];

  fs.writeFileSync("reports/qorb-reversal-research.csv", `${csvRows.join("\n")}\n`);
}

async function run() {
  qorbConfig.symbols = await resolveQorbSymbols();

  console.log("=== ZenBlade QORB Pump Reversal Short Research ===");
  console.log("Mode: research / paper only — no real trading");
  console.log(`Profile: ${QORB_PROFILE}`);
  if (QORB_PROFILE === "auto") {
    console.log(`Auto max symbols: ${QORB_MAX_SYMBOLS}`);
  }
  console.log(`Symbols: ${qorbConfig.symbols.join(", ")}`);
  console.log(`Timeframe: 1H | Target candles: ${TARGET_HTF_CANDLES}`);
  console.log(
    `QORB filters: pump >= ${qorbConfig.qorbMinPumpWeak}% | ` +
    `volumeSpike >= ${qorbConfig.qorbMinVolumeSpike} | ` +
    `score >= ${qorbConfig.qorbMinOpenScore} | ` +
    `minVolumeUSDT >= ${qorbConfig.qorbMinVolumeUSDT}`
  );
  console.log();

  const allResults = [];

  for (const symbol of qorbConfig.symbols) {
    const stats = await backtestSymbol(symbol);
    if (stats) {
      allResults.push({ symbol, stats });
    }
  }

  console.log("\nResults:");
  for (const { symbol, stats } of allResults) {
    printResult(symbol, stats);
  }

  if (allResults.length === 0) {
    console.log("No results — check network connectivity.");
    return;
  }

  writeReports(allResults);

  console.log("\nReports:");
  console.log("- reports/qorb-reversal-research.json");
  console.log("- reports/qorb-reversal-research.csv");
}

const isDirectRun =
  process.argv[1] && import.meta.url === "file://" + process.argv[1];

if (isDirectRun) {
  run().catch((err) => {
    console.error("QORB reversal research failed:", err);
    process.exitCode = 1;
  });
}
