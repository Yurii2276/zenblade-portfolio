import fs from "fs";
import path from "path";
import { config } from "../config.js";
import { fetchHistoricalCandles } from "../okxClient.js";
import { calculateLongTrade } from "../riskManager.js";

// ─── Parameter families (same as strategySweep) + SOL-only set ───────────────

const SYMBOL_SETS = [
  ["BTC-USDT", "ETH-USDT", "SOL-USDT"],
  ["BTC-USDT", "ETH-USDT"],
  ["ETH-USDT"],
  ["BTC-USDT"],
  ["SOL-USDT"],
];

const RSI_RANGES = [
  { min: 42, max: 55 },
  { min: 45, max: 55 },
  { min: 45, max: 58 },
  { min: 48, max: 58 },
  { min: 50, max: 60 },
];

const VOLUME_RULES = [
  { min: 0.8,  max: 1.2  },
  { min: 0.8,  max: 1.5  },
  { min: 1.0,  max: 1.5  },
  { min: 1.0,  max: null },
  { min: 1.2,  max: null },
];

const ATR_RULES = [
  { stop: 1.0, take: 1.5 },
  { stop: 1.0, take: 2.0 },
  { stop: 1.2, take: 1.8 },
  { stop: 1.5, take: 2.5 },
];

const EMA_RULES = [
  { fast: 9,  slow: 21  },
  { fast: 20, slow: 50  },
  { fast: 30, slow: 100 },
];

// ─── Candle fetch targets ─────────────────────────────────────────────────────

const STABILITY_5M_LIMIT  = 6000;
const STABILITY_1H_LIMIT  = 1000;
const NUM_WINDOWS         = 4;

// ─── Stable candidate penalty amounts ────────────────────────────────────────

const PENALTY_FEW_WINDOWS_WITH_TRADES = 20; // windowsWithTrades < 3
const PENALTY_FEW_TOTAL_TRADES        = 10; // totalTrades < 20

// ─── Utility helpers ──────────────────────────────────────────────────────────

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// ─── Indicator calculations (identical to strategySweep) ──────────────────────

function calculateEmaSeries(values, period) {
  const series = Array(values.length).fill(null);
  if (values.length < period) return series;

  let emaValue = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  series[period - 1] = round(emaValue);

  const multiplier = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    emaValue = values[i] * multiplier + emaValue * (1 - multiplier);
    series[i] = round(emaValue);
  }
  return series;
}

function rsiValue(avgGain, avgLoss) {
  if (avgLoss === 0) return 100;
  return round(100 - 100 / (1 + avgGain / avgLoss));
}

function calculateRsiSeries(values, period) {
  const series = Array(values.length).fill(null);
  if (values.length < period + 1) return series;

  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gains += d; else losses += Math.abs(d);
  }

  let avgGain = gains / period, avgLoss = losses / period;
  series[period] = rsiValue(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const gain = d >= 0 ? d : 0;
    const loss = d < 0 ? Math.abs(d) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    series[i] = rsiValue(avgGain, avgLoss);
  }
  return series;
}

function calculateAtrSeries(candles, period) {
  const series = Array(candles.length).fill(null);
  if (candles.length < period + 1) return series;

  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], pc = candles[i - 1].close;
    trueRanges.push(Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc)));
  }

  let atrValue = trueRanges.slice(0, period).reduce((s, v) => s + v, 0) / period;
  series[period] = round(atrValue);

  for (let ri = period; ri < trueRanges.length; ri++) {
    atrValue = (atrValue * (period - 1) + trueRanges[ri]) / period;
    series[ri + 1] = round(atrValue);
  }
  return series;
}

function calculateVolumeSmaSeries(candles, period) {
  const series = Array(candles.length).fill(null);
  let rolling = 0;
  for (let i = 0; i < candles.length; i++) {
    rolling += candles[i].volume;
    if (i >= period) rolling -= candles[i - period].volume;
    if (i >= period - 1) series[i] = round(rolling / period);
  }
  return series;
}

function buildHtfTrendSeries(candles, htfCandles, cfg) {
  const htfCloses = htfCandles.map((c) => c.close);
  const fastSeries = calculateEmaSeries(htfCloses, cfg.htfEmaFast);
  const slowSeries = calculateEmaSeries(htfCloses, cfg.htfEmaSlow);
  const minCandles = cfg.htfEmaSlow + 5;
  const trendSeries = Array(candles.length).fill(false);
  let htfIdx = -1;

  for (let i = 0; i < candles.length; i++) {
    while (htfIdx + 1 < htfCandles.length && htfCandles[htfIdx + 1].time <= candles[i].time) {
      htfIdx++;
    }
    if (htfIdx + 1 < minCandles) continue;
    const htfFast = fastSeries[htfIdx];
    const htfSlow = slowSeries[htfIdx];
    const htfClose = htfCandles[htfIdx].close;
    trendSeries[i] = htfFast !== null && htfSlow !== null && htfFast > htfSlow && htfClose > htfFast;
  }
  return trendSeries;
}

function prepareSegment(candles, htfCandles, cfg) {
  const closes = candles.map((c) => c.close);
  const emaPeriods = [...new Set(EMA_RULES.flatMap((r) => [r.fast, r.slow]))];
  const emaSeries = Object.fromEntries(
    emaPeriods.map((p) => [p, calculateEmaSeries(closes, p)])
  );

  return {
    candles,
    emaSeries,
    rsiSeries:       calculateRsiSeries(closes, cfg.rsiPeriod),
    atrSeries:       calculateAtrSeries(candles, cfg.atrPeriod),
    volumeSmaSeries: calculateVolumeSmaSeries(candles, cfg.volumePeriod),
    htfTrendSeries:  buildHtfTrendSeries(candles, htfCandles, cfg),
  };
}

// ─── Signal detection (identical to strategySweep) ────────────────────────────

function hasEntrySignal(segment, index, cfg) {
  if (index < 60) return false;

  const candle     = segment.candles[index];
  const emaFast    = segment.emaSeries[cfg.emaFast][index];
  const emaSlow    = segment.emaSeries[cfg.emaSlow][index];
  const rsi14      = segment.rsiSeries[index];
  const atr14      = segment.atrSeries[index];
  const volumeSma  = segment.volumeSmaSeries[index];

  if (emaFast === null || emaSlow === null || rsi14 === null || atr14 === null || volumeSma === null) {
    return false;
  }

  if (cfg.useHtfFilter === true && segment.htfTrendSeries[index] !== true) return false;

  if (cfg.maxVolumeFactor != null && candle.volume > volumeSma * cfg.maxVolumeFactor) return false;

  const common =
    emaFast > emaSlow &&
    candle.close > emaFast &&
    rsi14 >= cfg.minRsiForLong &&
    rsi14 <= cfg.maxRsiForLong &&
    candle.volume >= volumeSma * cfg.minVolumeFactor &&
    atr14 > 0;

  if (!common) return false;
  if (cfg.activeStrategy === "trendMomentum") return true;

  // trendPullback
  const lookbackStart = Math.max(0, index - (cfg.pullbackLookback || 8) + 1);
  const tol = cfg.pullbackTolerancePct ?? 0.002;
  let pullbackDetected = false;
  for (let i = lookbackStart; i <= index; i++) {
    if (segment.candles[i].low <= emaFast * (1 + tol)) { pullbackDetected = true; break; }
  }
  const bullishConfirm = candle.close > candle.open && candle.close > segment.candles[index - 1].close;
  return pullbackDetected && bullishConfirm;
}

// ─── Drawdown helper ──────────────────────────────────────────────────────────

function calcMaxDrawdown(equityCurve, initialBalance) {
  let peak = equityCurve[0] ?? initialBalance;
  let maxDD = 0;
  for (const v of equityCurve) {
    if (v > peak) peak = v;
    maxDD = Math.max(maxDD, peak - v);
  }
  return round(maxDD);
}

// ─── Per-window backtest ──────────────────────────────────────────────────────

function backtestWindow(segment, cfg) {
  let balance = cfg.initialBalance;
  let openPosition = null;
  const equity = [balance];
  const tradePnls = [];
  let totalFees = 0;

  for (let i = 60; i < segment.candles.length; i++) {
    const candle = segment.candles[i];

    if (openPosition) {
      const hitStop = candle.low  <= openPosition.stopPrice;
      const hitTake = candle.high >= openPosition.takePrice;

      if (hitStop || hitTake) {
        const exitPrice = hitStop ? openPosition.stopPrice : openPosition.takePrice;
        const grossPnl  = round((exitPrice - openPosition.entryPrice) * openPosition.size);
        const fees      = round((openPosition.entryPrice + exitPrice) * openPosition.size * cfg.feeRate);
        const netPnl    = round(grossPnl - fees);
        balance         = round(balance + netPnl);
        totalFees      += fees;
        tradePnls.push(netPnl);
        equity.push(balance);
        openPosition = null;
      }
      continue;
    }

    if (!hasEntrySignal(segment, i, cfg)) continue;

    const trade = calculateLongTrade({ balance, entryPrice: candle.close, atr: segment.atrSeries[i], config: cfg });
    if (trade.size > 0 && trade.positionValue > 0) {
      openPosition = {
        entryPrice: trade.entryPrice,
        stopPrice:  trade.stopPrice,
        takePrice:  trade.takePrice,
        size:       trade.size,
      };
    }
  }

  // close any still-open position at last candle close
  if (openPosition && segment.candles.length > 0) {
    const exitPrice = segment.candles[segment.candles.length - 1].close;
    const grossPnl  = round((exitPrice - openPosition.entryPrice) * openPosition.size);
    const fees      = round((openPosition.entryPrice + exitPrice) * openPosition.size * cfg.feeRate);
    const netPnl    = round(grossPnl - fees);
    balance         = round(balance + netPnl);
    totalFees      += fees;
    tradePnls.push(netPnl);
    equity.push(balance);
  }

  const wins   = tradePnls.filter((p) => p > 0);
  const losses = tradePnls.filter((p) => p < 0);
  const totalWinPnl  = round(wins.reduce((s, p)   => s + p, 0));
  const totalLossPnl = round(Math.abs(losses.reduce((s, p) => s + p, 0)));

  return {
    trades:      tradePnls.length,
    wins:        wins.length,
    losses:      losses.length,
    netPnl:      round(tradePnls.reduce((s, p) => s + p, 0)),
    totalWinPnl,
    totalLossPnl,
    winRate:     tradePnls.length > 0 ? round((wins.length / tradePnls.length) * 100) : 0,
    profitFactor: totalLossPnl > 0 ? round(totalWinPnl / totalLossPnl) : (wins.length > 0 ? null : 0),
    maxDrawdown: calcMaxDrawdown(equity, cfg.initialBalance),
    fees:        round(totalFees),
  };
}

// ─── Aggregate window metrics across symbols ──────────────────────────────────

function aggregateWindowMetrics(perSymbolWindowMetrics) {
  const agg = perSymbolWindowMetrics.reduce((acc, m) => ({
    trades:       acc.trades       + m.trades,
    wins:         acc.wins         + m.wins,
    losses:       acc.losses       + m.losses,
    netPnl:       acc.netPnl       + m.netPnl,
    totalWinPnl:  acc.totalWinPnl  + m.totalWinPnl,
    totalLossPnl: acc.totalLossPnl + m.totalLossPnl,
    maxDrawdown:  Math.max(acc.maxDrawdown, m.maxDrawdown),
    fees:         acc.fees         + m.fees,
  }), { trades: 0, wins: 0, losses: 0, netPnl: 0, totalWinPnl: 0, totalLossPnl: 0, maxDrawdown: 0, fees: 0 });

  return {
    ...agg,
    netPnl:      round(agg.netPnl),
    fees:        round(agg.fees),
    winRate:     agg.trades > 0 ? round((agg.wins / agg.trades) * 100) : 0,
    profitFactor: agg.totalLossPnl > 0
      ? round(agg.totalWinPnl / agg.totalLossPnl)
      : (agg.wins > 0 && agg.losses === 0 ? null : 0),
  };
}

// ─── Stability metrics ────────────────────────────────────────────────────────

function calcStabilityMetrics(windowResults) {
  // windowResults: array of 4 aggregated window metrics
  const totalTrades     = windowResults.reduce((s, w) => s + w.trades, 0);
  const totalNetPnl     = round(windowResults.reduce((s, w) => s + w.netPnl, 0));
  const totalWinPnl     = windowResults.reduce((s, w) => s + w.totalWinPnl, 0);
  const totalLossPnl    = windowResults.reduce((s, w) => s + w.totalLossPnl, 0);
  const totalPF         = totalLossPnl > 0
    ? round(totalWinPnl / totalLossPnl)
    : (totalWinPnl > 0 ? null : 0);
  const windowPFs       = windowResults
    .map((w) => w.profitFactor)
    .filter((pf) => pf !== null && pf !== undefined);
  const avgWindowPF     = windowPFs.length > 0
    ? round(windowPFs.reduce((s, pf) => s + pf, 0) / windowPFs.length)
    : 0;
  const positiveWindows = windowResults.filter((w) => w.netPnl > 0).length;
  const negativeWindows = windowResults.filter((w) => w.netPnl < 0).length;
  const profitableWindowRate = round((positiveWindows / windowResults.length) * 100);
  const minWindowPnl    = round(Math.min(...windowResults.map((w) => w.netPnl)));
  const maxWindowDrawdown = Math.max(...windowResults.map((w) => w.maxDrawdown));
  const windowsWithTrades = windowResults.filter((w) => w.trades > 0).length;

  // stableScore
  const totalPFForScore = totalPF ?? 0;
  let stableScore = totalNetPnl
    + totalPFForScore * 10
    + positiveWindows * 5
    - maxWindowDrawdown;
  if (windowsWithTrades < 3) stableScore -= PENALTY_FEW_WINDOWS_WITH_TRADES;
  if (totalTrades < 20)      stableScore -= PENALTY_FEW_TOTAL_TRADES;
  stableScore = round(stableScore);

  // null totalPF means wins with zero losses — treat as perfectly qualifying PF
  const pfQualifies = totalPF === null ? true : totalPF > 1.1;
  const stableCandidate =
    totalTrades >= 20 &&
    totalNetPnl > 0 &&
    pfQualifies &&
    positiveWindows >= 3 &&
    windowsWithTrades >= 3 &&
    maxWindowDrawdown < 10;

  return {
    totalTrades,
    totalNetPnl,
    totalPF,
    avgWindowPF,
    positiveWindows,
    negativeWindows,
    profitableWindowRate,
    minWindowPnl,
    maxWindowDrawdown: round(maxWindowDrawdown),
    windowsWithTrades,
    stableScore,
    stableCandidate,
  };
}

// ─── Report writers ───────────────────────────────────────────────────────────

function csvCell(value) {
  const text = value === null || value === undefined ? "N/A" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

const CSV_COLUMNS = [
  "strategy", "symbols", "emaFast", "emaSlow", "minRsi", "maxRsi",
  "minVolumeFactor", "maxVolumeFactor", "atrStop", "atrTake",
  "totalTrades", "totalNetPnl", "totalPF", "avgWindowPF",
  "positiveWindows", "negativeWindows", "profitableWindowRate",
  "minWindowPnl", "maxWindowDrawdown", "windowsWithTrades",
  "stableScore", "stableCandidate",
];

function writeStabilityReports({ results, candidates, topResults, warnings, reportsDir = "reports" }) {
  const outputDir = path.resolve(reportsDir);
  fs.mkdirSync(outputDir, { recursive: true });

  const jsonPath = path.join(outputDir, "strategy-stability-results.json");
  const csvPath  = path.join(outputDir, "strategy-stability-summary.csv");
  const generatedAt = new Date().toISOString();

  fs.writeFileSync(jsonPath, JSON.stringify({
    generatedAt,
    numWindows: NUM_WINDOWS,
    totalCombinationsTested: results.length,
    stableCandidatesFound: candidates.length,
    bestStableCandidate: candidates[0] ?? null,
    top10ByStableScore: topResults,
    warnings,
    results,
  }, null, 2));

  const csvRows = [
    CSV_COLUMNS.join(","),
    ...results.map((r) => CSV_COLUMNS.map((col) => csvCell(r[col])).join(",")),
  ];
  fs.writeFileSync(csvPath, `${csvRows.join("\n")}\n`);

  return { jsonPath, csvPath };
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function runStrategyStability({ onProgress = () => {} } = {}) {
  const warnings = [
    "Stability research is exploratory: do not use results for real trading.",
    `Each symbol's candles are split into ${NUM_WINDOWS} sequential windows.`,
    "If OKX returns fewer candles than requested, available data is used.",
  ];

  // 1. Load candles for all unique symbols
  const allSymbols = [...new Set(SYMBOL_SETS.flat())];
  const symbolData = {};

  for (const symbol of allSymbols) {
    onProgress(`Loading ${symbol} 5m candles (target ${STABILITY_5M_LIMIT})...`);
    const candles = await fetchHistoricalCandles({
      symbol,
      bar: config.bar,           // "5m"
      targetLimit: STABILITY_5M_LIMIT,
    });

    onProgress(`Loading ${symbol} 1H candles (target ${STABILITY_1H_LIMIT})...`);
    const htfCandles = await fetchHistoricalCandles({
      symbol,
      bar: config.htfBar,        // "1H"
      targetLimit: STABILITY_1H_LIMIT,
    });

    onProgress(
      `${symbol}: loaded ${candles.length} 5m candles, ${htfCandles.length} 1H candles`
    );

    if (candles.length === 0 || htfCandles.length === 0) {
      warnings.push(`${symbol}: insufficient candles — skipping`);
      continue;
    }

    // 2. Split into NUM_WINDOWS sequential windows
    const windowSize = Math.floor(candles.length / NUM_WINDOWS);
    const windows = [];
    for (let w = 0; w < NUM_WINDOWS; w++) {
      const start = w * windowSize;
      const end   = w === NUM_WINDOWS - 1 ? candles.length : start + windowSize;
      windows.push(candles.slice(start, end));
    }

    symbolData[symbol] = {
      windows: windows.map((wCandles) => prepareSegment(wCandles, htfCandles, config)),
      windowSizes: windows.map((w) => w.length),
    };

    onProgress(
      `${symbol}: windows ${windows.map((w) => w.length).join(" | ")} candles`
    );
  }

  const loadedSymbols = Object.keys(symbolData);
  if (loadedSymbols.length === 0) {
    throw new Error("No symbol data loaded. Check network connectivity.");
  }

  // 3. Grid search
  const enabledStrategies = Object.entries(config.strategies)
    .filter(([, s]) => s.enabled === true)
    .map(([name]) => name);

  const results = [];

  for (const strategyName of enabledStrategies) {
    onProgress(`Sweeping stability for ${strategyName}...`);

    for (const rsiRange of RSI_RANGES) {
      for (const volumeRule of VOLUME_RULES) {
        for (const atrRule of ATR_RULES) {
          for (const emaRule of EMA_RULES) {
            const cfg = {
              ...config,
              activeStrategy:    strategyName,
              emaFast:           emaRule.fast,
              emaSlow:           emaRule.slow,
              minRsiForLong:     rsiRange.min,
              maxRsiForLong:     rsiRange.max,
              minVolumeFactor:   volumeRule.min,
              maxVolumeFactor:   volumeRule.max,
              atrStopMultiplier: atrRule.stop,
              atrTakeMultiplier: atrRule.take,
              useHtfFilter:      true,
            };

            // Pre-compute per-symbol per-window backtest results
            const perSymbolWindows = {};
            for (const symbol of loadedSymbols) {
              perSymbolWindows[symbol] = symbolData[symbol].windows.map((seg) =>
                backtestWindow(seg, cfg)
              );
            }

            for (const symbolSet of SYMBOL_SETS) {
              const activeSymbols = symbolSet.filter((s) => loadedSymbols.includes(s));
              // Skip entirely if no symbols loaded, or if a partial set would misrepresent the label
              if (activeSymbols.length === 0) continue;
              if (activeSymbols.length < symbolSet.length) {
                warnings.push(
                  `Symbol set [${symbolSet.join("+")}] skipped: ` +
                  `missing data for [${symbolSet.filter((s) => !loadedSymbols.includes(s)).join("+")}]`
                );
                continue;
              }

              // Aggregate per window across symbols in this set
              const windowResults = Array.from({ length: NUM_WINDOWS }, (_, wi) =>
                aggregateWindowMetrics(activeSymbols.map((s) => perSymbolWindows[s][wi]))
              );

              const stability = calcStabilityMetrics(windowResults);

              results.push({
                strategy:        strategyName,
                symbols:         activeSymbols.join("+"),
                emaFast:         emaRule.fast,
                emaSlow:         emaRule.slow,
                minRsi:          rsiRange.min,
                maxRsi:          rsiRange.max,
                minVolumeFactor: volumeRule.min,
                maxVolumeFactor: volumeRule.max,
                atrStop:         atrRule.stop,
                atrTake:         atrRule.take,
                ...stability,
                // per-window detail (in JSON only)
                windowDetail: windowResults.map((w, i) => ({
                  window:      i + 1,
                  trades:      w.trades,
                  netPnl:      w.netPnl,
                  profitFactor: w.profitFactor,
                  winRate:     w.winRate,
                  maxDrawdown: w.maxDrawdown,
                  fees:        w.fees,
                })),
              });
            }
          }
        }
      }
    }
  }

  const topResults = [...results]
    .sort((a, b) => b.stableScore - a.stableScore)
    .slice(0, 10);

  const candidates = results
    .filter((r) => r.stableCandidate)
    .sort((a, b) => b.stableScore - a.stableScore);

  if (candidates.length === 0) {
    warnings.push("No stable candidate found");
  }

  const reports = writeStabilityReports({ results, candidates, topResults, warnings });

  return {
    results,
    candidates,
    topResults,
    bestStableCandidate: candidates[0] ?? null,
    warnings,
    reports,
    symbolLoadInfo: Object.fromEntries(
      loadedSymbols.map((s) => [s, symbolData[s].windowSizes])
    ),
  };
}
