/**
 * ZenBlade Macro Gold + DXY Index Research — Phase 3.
 *
 * Research only:
 * - no live execution
 * - no paper-loop integration
 * - no real orders
 * - no private API keys
 */

import fs from "node:fs";
import { fetchHistoricalCandles } from "../okxClient.js";

const BAR = process.env.MACRO_INDEX_BAR ?? "1D";
const TARGET_CANDLES = Number.parseInt(process.env.MACRO_INDEX_CANDLES ?? "500", 10);
const LOOKBACK_DAYS = Number.parseInt(process.env.MACRO_INDEX_LOOKBACK_DAYS ?? "2", 10);
const MAX_ABS_MACRO_CHANGE_2D_PCT = Number.parseFloat(
  process.env.MACRO_INDEX_MAX_ABS_MACRO_CHANGE_2D_PCT ?? "5"
);

const CRYPTO_SYMBOLS = parseCsv(
  process.env.MACRO_INDEX_CRYPTO_SYMBOLS ?? "BTC-USDT,ETH-USDT,SOL-USDT"
);

const OKX_GOLD_PROXIES = parseCsv(
  process.env.MACRO_INDEX_OKX_GOLD_PROXIES ?? "XAUT-USDT,PAXG-USDT"
);

const YAHOO_SYMBOLS = {
  dxy: process.env.MACRO_YAHOO_DXY ?? "DX-Y.NYB",
  spx: process.env.MACRO_YAHOO_SPX ?? "^GSPC",
  nasdaq: process.env.MACRO_YAHOO_NASDAQ ?? "^IXIC",
  vix: process.env.MACRO_YAHOO_VIX ?? "^VIX",
  goldFutures: process.env.MACRO_YAHOO_GOLD_FUTURES ?? "GC=F",
};

const HOLD_DAYS = parseCsv(process.env.MACRO_INDEX_HOLD_DAYS ?? "1,2,3,5")
  .map((value) => Number.parseInt(value, 10))
  .filter(Number.isFinite);

const SCENARIOS = [
  {
    key: "dxy_down_xaut_up_basic",
    label: "DXY down + XAUT/PAXG up basic",
    dxyMax2dPct: -0.3,
    goldMin2dPct: 0.7,
  },
  {
    key: "dxy_down_gold_up_strict",
    label: "DXY down + stronger gold up",
    dxyMax2dPct: -0.3,
    goldMin2dPct: 1.0,
  },
  {
    key: "dxy_strict_gold_up",
    label: "Stronger DXY down + gold up",
    dxyMax2dPct: -0.5,
    goldMin2dPct: 0.7,
  },
  {
    key: "risk_on_confirmed",
    label: "DXY down + gold up + SPX/NASDAQ non-negative",
    dxyMax2dPct: -0.3,
    goldMin2dPct: 0.7,
    spxMin2dPct: 0,
    nasdaqMin2dPct: 0,
  },
  {
    key: "risk_on_low_vix",
    label: "DXY down + gold up + VIX not rising hard",
    dxyMax2dPct: -0.3,
    goldMin2dPct: 0.7,
    vixMax2dPct: 5,
  },
  {
    key: "full_macro_risk_on",
    label: "DXY down + gold up + SPX/NASDAQ ok + VIX ok",
    dxyMax2dPct: -0.3,
    goldMin2dPct: 0.7,
    spxMin2dPct: 0,
    nasdaqMin2dPct: 0,
    vixMax2dPct: 5,
  },
];

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

function pctChangeByIndex(candles, index, lookback) {
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
  return (valid.filter((value) => value > 0).length / valid.length) * 100;
}

async function loadOkxCandles(symbol) {
  console.log(`Loading OKX ${symbol} ${BAR} candles, target ${TARGET_CANDLES}...`);

  try {
    const candles = await fetchHistoricalCandles({
      symbol,
      bar: BAR,
      targetLimit: TARGET_CANDLES,
    });

    console.log(`${symbol}: loaded ${candles.length} candles`);
    return candles;
  } catch (error) {
    console.log(`${symbol}: failed — ${error.message}`);
    return [];
  }
}

async function loadYahooDailyCandles(label, symbol) {
  console.log(`Loading Yahoo ${label} (${symbol}) daily candles...`);

  const range = process.env.MACRO_YAHOO_RANGE ?? "2y";
  const encoded = encodeURIComponent(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?range=${range}&interval=1d`;

  try {
    const response = await fetch(url, {
      headers: { "user-agent": "ZenBladeResearch/1.0" },
    });

    if (!response.ok) {
      console.log(`${label}: Yahoo HTTP ${response.status}, skipping`);
      return [];
    }

    const json = await response.json();
    const result = json?.chart?.result?.[0];
    const quote = result?.indicators?.quote?.[0];

    if (!result?.timestamp?.length || !quote) {
      console.log(`${label}: no Yahoo quote data, skipping`);
      return [];
    }

    const candles = result.timestamp
      .map((seconds, index) => {
        const close = Number(quote.close?.[index]);

        // Yahoo can return 0 close for some non-trading placeholder days.
        // Those records create fake -100% DXY moves and must be ignored.
        if (!Number.isFinite(close) || close <= 0) return null;

        const open = Number(quote.open?.[index]);
        const high = Number(quote.high?.[index]);
        const low = Number(quote.low?.[index]);
        const volume = Number(quote.volume?.[index] ?? 0);

        return {
          time: seconds * 1000,
          open: Number.isFinite(open) ? open : close,
          high: Number.isFinite(high) ? high : close,
          low: Number.isFinite(low) ? low : close,
          close,
          volume: Number.isFinite(volume) ? volume : 0,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.time - b.time);

    console.log(`${label}: loaded ${candles.length} candles`);
    return candles;
  } catch (error) {
    console.log(`${label}: failed — ${error.message}`);
    return [];
  }
}

function buildIndicatorMap(candles, lookbackDays) {
  const map = new Map();

  for (let i = lookbackDays; i < candles.length; i++) {
    const candle = candles[i];
    const change2dPct = pctChangeByIndex(candles, i, lookbackDays);

    if (!Number.isFinite(change2dPct)) continue;

    // Macro indexes should not move by extreme amounts over 2 days.
    // This filters bad source records, for example Yahoo DXY close=0 placeholders.
    if (Math.abs(change2dPct) > MAX_ABS_MACRO_CHANGE_2D_PCT) continue;

    map.set(dateKeyFromTime(candle.time), {
      date: dateKeyFromTime(candle.time),
      close: candle.close,
      change2dPct,
    });
  }

  return map;
}

function buildCryptoForwardMap(candles) {
  const map = new Map();

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];

    const record = {
      date: dateKeyFromTime(candle.time),
      close: candle.close,
    };

    for (const holdDays of HOLD_DAYS) {
      record[`forward${holdDays}dPct`] = forwardReturnPct(candles, i, holdDays);
      record[`mae${holdDays}dPct`] = maxAdversePct(candles, i, holdDays);
      record[`mfe${holdDays}dPct`] = maxFavorablePct(candles, i, holdDays);
    }

    map.set(record.date, record);
  }

  return map;
}

function scenarioHasRequiredSources({ scenario, macroMaps }) {
  if (!macroMaps.dxy || macroMaps.dxy.size === 0) return false;
  if (scenario.spxMin2dPct != null && (!macroMaps.spx || macroMaps.spx.size === 0)) return false;
  if (scenario.nasdaqMin2dPct != null && (!macroMaps.nasdaq || macroMaps.nasdaq.size === 0)) return false;
  if (scenario.vixMax2dPct != null && (!macroMaps.vix || macroMaps.vix.size === 0)) return false;
  return true;
}

function passesScenario({ scenario, date, goldMap, macroMaps }) {
  const gold = goldMap.get(date);
  const dxy = macroMaps.dxy?.get(date);

  if (!gold || !dxy) return false;
  if (dxy.change2dPct > scenario.dxyMax2dPct) return false;
  if (gold.change2dPct < scenario.goldMin2dPct) return false;

  if (scenario.spxMin2dPct != null) {
    const spx = macroMaps.spx?.get(date);
    if (!spx || spx.change2dPct < scenario.spxMin2dPct) return false;
  }

  if (scenario.nasdaqMin2dPct != null) {
    const nasdaq = macroMaps.nasdaq?.get(date);
    if (!nasdaq || nasdaq.change2dPct < scenario.nasdaqMin2dPct) return false;
  }

  if (scenario.vixMax2dPct != null) {
    const vix = macroMaps.vix?.get(date);
    if (!vix || vix.change2dPct > scenario.vixMax2dPct) return false;
  }

  return true;
}

function makeEventRecords({ scenario, goldSymbol, goldMap, cryptoSymbol, cryptoMap, macroMaps }) {
  const rows = [];

  if (!scenarioHasRequiredSources({ scenario, macroMaps })) return rows;

  for (const [date, crypto] of cryptoMap.entries()) {
    if (!passesScenario({ scenario, date, goldMap, macroMaps })) continue;

    const gold = goldMap.get(date);
    const dxy = macroMaps.dxy?.get(date);
    const spx = macroMaps.spx?.get(date);
    const nasdaq = macroMaps.nasdaq?.get(date);
    const vix = macroMaps.vix?.get(date);

    rows.push({
      scenario: scenario.key,
      scenarioLabel: scenario.label,
      goldSymbol,
      cryptoSymbol,
      date,
      cryptoClose: crypto.close,
      goldChange2dPct: gold?.change2dPct,
      dxyChange2dPct: dxy?.change2dPct,
      spxChange2dPct: spx?.change2dPct ?? null,
      nasdaqChange2dPct: nasdaq?.change2dPct ?? null,
      vixChange2dPct: vix?.change2dPct ?? null,
      ...Object.fromEntries(
        HOLD_DAYS.flatMap((holdDays) => [
          [`forward${holdDays}dPct`, crypto[`forward${holdDays}dPct`]],
          [`mae${holdDays}dPct`, crypto[`mae${holdDays}dPct`]],
          [`mfe${holdDays}dPct`, crypto[`mfe${holdDays}dPct`]],
        ])
      ),
    });
  }

  return rows;
}

function summarizeEvents(events) {
  const summary = {
    signalDays: events.length,
    avgDxyChange2dPct: round(avg(events.map((item) => item.dxyChange2dPct))),
    avgGoldChange2dPct: round(avg(events.map((item) => item.goldChange2dPct))),
    avgSpxChange2dPct: round(avg(events.map((item) => item.spxChange2dPct))),
    avgNasdaqChange2dPct: round(avg(events.map((item) => item.nasdaqChange2dPct))),
    avgVixChange2dPct: round(avg(events.map((item) => item.vixChange2dPct))),
  };

  for (const holdDays of HOLD_DAYS) {
    summary[`avgForward${holdDays}dPct`] = round(avg(events.map((item) => item[`forward${holdDays}dPct`])));
    summary[`hitRateForward${holdDays}dPct`] = round(hitRatePositive(events.map((item) => item[`forward${holdDays}dPct`])), 1);
    summary[`avgMae${holdDays}dPct`] = round(avg(events.map((item) => item[`mae${holdDays}dPct`])));
    summary[`worstMae${holdDays}dPct`] = round(min(events.map((item) => item[`mae${holdDays}dPct`])));
    summary[`avgMfe${holdDays}dPct`] = round(avg(events.map((item) => item[`mfe${holdDays}dPct`])));
  }

  return summary;
}

function buildBaselineSummary(cryptoMap) {
  return summarizeEvents(
    Array.from(cryptoMap.values()).map((crypto) => ({
      ...crypto,
      ...Object.fromEntries(
        HOLD_DAYS.flatMap((holdDays) => [
          [`forward${holdDays}dPct`, crypto[`forward${holdDays}dPct`]],
          [`mae${holdDays}dPct`, crypto[`mae${holdDays}dPct`]],
          [`mfe${holdDays}dPct`, crypto[`mfe${holdDays}dPct`]],
        ])
      ),
    }))
  );
}

function evaluateCandidate({ baseline, signal }) {
  const sampleOk = signal.signalDays >= 15;
  const avg2d = signal.avgForward2dPct;
  const base2d = baseline.avgForward2dPct;
  const hit2d = signal.hitRateForward2dPct;
  const avgMae2d = signal.avgMae2dPct;

  const edgeOk = Number.isFinite(avg2d) && Number.isFinite(base2d) && avg2d > base2d + 0.25;
  const positiveOk = Number.isFinite(avg2d) && avg2d > 0.2;
  const hitOk = Number.isFinite(hit2d) && hit2d >= 53;
  const riskOk = !Number.isFinite(avgMae2d) || avgMae2d > -4;

  return sampleOk && edgeOk && positiveOk && hitOk && riskOk;
}

function writeReports({ sourceStatus, results }) {
  fs.mkdirSync("reports", { recursive: true });

  fs.writeFileSync(
    "reports/macro-gold-dxy-index-research.json",
    JSON.stringify(
      {
        strategyId: "macro-gold-dxy-index",
        strategyName: "ZenBlade Macro Gold + DXY Index Research",
        mode: "research_only",
        phase: "phase3_macro_basket",
        createdAt: new Date().toISOString(),
        config: {
          bar: BAR,
          targetCandles: TARGET_CANDLES,
          lookbackDays: LOOKBACK_DAYS,
          maxAbsMacroChange2dPct: MAX_ABS_MACRO_CHANGE_2D_PCT,
          cryptoSymbols: CRYPTO_SYMBOLS,
          okxGoldProxies: OKX_GOLD_PROXIES,
          yahooSymbols: YAHOO_SYMBOLS,
          holdDays: HOLD_DAYS,
          scenarios: SCENARIOS,
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
      },
      null,
      2
    )
  );

  const csvRows = [
    [
      "scenario",
      "goldSymbol",
      "cryptoSymbol",
      "signalDays",
      "baselineAvg2d",
      "signalAvg2d",
      "edge2d",
      "signalHit2d",
      "signalAvgMae2d",
      "signalWorstMae2d",
      "signalAvgMfe2d",
      "avgDxy2d",
      "avgGold2d",
      "candidate",
      "interpretation",
    ].join(","),
    ...results.map((item) =>
      [
        item.scenario,
        item.goldSymbol,
        item.cryptoSymbol,
        item.signal.signalDays,
        item.baseline.avgForward2dPct ?? "N/A",
        item.signal.avgForward2dPct ?? "N/A",
        item.edge2dPct ?? "N/A",
        item.signal.hitRateForward2dPct ?? "N/A",
        item.signal.avgMae2dPct ?? "N/A",
        item.signal.worstMae2dPct ?? "N/A",
        item.signal.avgMfe2dPct ?? "N/A",
        item.signal.avgDxyChange2dPct ?? "N/A",
        item.signal.avgGoldChange2dPct ?? "N/A",
        item.candidate,
        `"${item.interpretation}"`,
      ].join(",")
    ),
  ];

  fs.writeFileSync("reports/macro-gold-dxy-index-research.csv", `${csvRows.join("\n")}\n`);
}

export async function runMacroGoldDxyIndexResearch() {
  console.log("=== ZenBlade Macro Gold + DXY Index Research ===");
  console.log("Mode: research only — no paper loop, no live trading, no real orders");
  console.log(`OKX bar: ${BAR}`);
  console.log(`Target candles: ${TARGET_CANDLES}`);
  console.log(`Lookback days: ${LOOKBACK_DAYS}`);
  console.log(`Crypto: ${CRYPTO_SYMBOLS.join(", ")}`);
  console.log(`OKX gold proxies: ${OKX_GOLD_PROXIES.join(", ")}`);
  console.log(`Yahoo macro symbols: ${JSON.stringify(YAHOO_SYMBOLS)}`);
  console.log("");

  const cryptoData = {};
  for (const symbol of CRYPTO_SYMBOLS) cryptoData[symbol] = await loadOkxCandles(symbol);

  console.log("");

  const goldData = {};
  for (const symbol of OKX_GOLD_PROXIES) goldData[symbol] = await loadOkxCandles(symbol);

  console.log("");

  const yahooData = {};
  for (const [key, symbol] of Object.entries(YAHOO_SYMBOLS)) {
    yahooData[key] = await loadYahooDailyCandles(key, symbol);
  }

  const macroMaps = {
    dxy: buildIndicatorMap(yahooData.dxy ?? [], LOOKBACK_DAYS),
    spx: buildIndicatorMap(yahooData.spx ?? [], LOOKBACK_DAYS),
    nasdaq: buildIndicatorMap(yahooData.nasdaq ?? [], LOOKBACK_DAYS),
    vix: buildIndicatorMap(yahooData.vix ?? [], LOOKBACK_DAYS),
    goldFutures: buildIndicatorMap(yahooData.goldFutures ?? [], LOOKBACK_DAYS),
  };

  const sourceStatus = {
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
    okxGoldSources: Object.fromEntries(
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
    yahooMacroSources: Object.fromEntries(
      Object.entries(yahooData).map(([key, candles]) => [
        key,
        {
          symbol: YAHOO_SYMBOLS[key],
          available: candles.length > 0,
          candles: candles.length,
          firstDate: candles[0] ? dateKeyFromTime(candles[0].time) : null,
          lastDate: candles.at(-1) ? dateKeyFromTime(candles.at(-1).time) : null,
        },
      ])
    ),
  };

  const results = [];

  for (const [cryptoSymbol, cryptoCandles] of Object.entries(cryptoData)) {
    if (cryptoCandles.length < 30) continue;

    const cryptoMap = buildCryptoForwardMap(cryptoCandles);
    const baseline = buildBaselineSummary(cryptoMap);

    for (const [goldSymbol, goldCandles] of Object.entries(goldData)) {
      if (goldCandles.length < 30) continue;

      const goldMap = buildIndicatorMap(goldCandles, LOOKBACK_DAYS);

      for (const scenario of SCENARIOS) {
        const events = makeEventRecords({
          scenario,
          goldSymbol,
          goldMap,
          cryptoSymbol,
          cryptoMap,
          macroMaps,
        });

        const signal = summarizeEvents(events);
        const edge2dPct =
          Number.isFinite(signal.avgForward2dPct) && Number.isFinite(baseline.avgForward2dPct)
            ? round(signal.avgForward2dPct - baseline.avgForward2dPct)
            : null;

        const candidate = evaluateCandidate({ baseline, signal });

        results.push({
          scenario: scenario.key,
          scenarioLabel: scenario.label,
          goldSymbol,
          cryptoSymbol,
          baseline,
          signal,
          edge2dPct,
          candidate,
          interpretation: candidate
            ? "PROMISING_MACRO_COMBO: combined macro signal improved 2D forward result enough for deeper research."
            : "NOT_CONFIRMED: macro combo did not create enough edge or sample is too small.",
        });
      }
    }
  }

  results.sort((a, b) => {
    if (a.candidate !== b.candidate) return a.candidate ? -1 : 1;
    return (b.edge2dPct ?? -999) - (a.edge2dPct ?? -999);
  });

  console.log("");
  console.log("Top results:");
  for (const item of results.slice(0, 15)) {
    console.log(
      `${item.scenario} | ${item.goldSymbol} -> ${item.cryptoSymbol} | ` +
      `signals ${item.signal.signalDays} | base2D ${item.baseline.avgForward2dPct ?? "N/A"}% | ` +
      `sig2D ${item.signal.avgForward2dPct ?? "N/A"}% | edge ${item.edge2dPct ?? "N/A"}% | ` +
      `hit ${item.signal.hitRateForward2dPct ?? "N/A"}% | avgMAE ${item.signal.avgMae2dPct ?? "N/A"}% | ` +
      `candidate ${item.candidate}`
    );
  }

  writeReports({ sourceStatus, results });

  console.log("");
  console.log("Reports written:");
  console.log("- reports/macro-gold-dxy-index-research.json");
  console.log("- reports/macro-gold-dxy-index-research.csv");
  console.log("");
  console.log("Do not commit reports/.");
  console.log("No paper-loop changes were made.");

  return { sourceStatus, results };
}

const isDirectRun =
  process.argv[1] && import.meta.url === "file://" + process.argv[1];

if (isDirectRun) {
  runMacroGoldDxyIndexResearch().catch((error) => {
    console.error("Macro Gold + DXY Index research failed:", error);
    process.exitCode = 1;
  });
}
