import fs from "fs";
import path from "path";
import { config } from "./config.js";
import { scanPortfolio } from "./portfolioScanner.js";
import { PaperEngine } from "./paperEngine.js";
import { logInfo } from "./logger.js";

const DEFAULT_STATE_PATH  = path.resolve("data/state.json");
const DEFAULT_TRADES_PATH = path.resolve("data/trades.json");

const DEFAULT_STATE = {
  balance: 1000,
  openPosition: null,
  lastProcessedCandleTime: null,
  lastPortfolioScanCandleTime: null,
};

function loadState(statePath) {
  try {
    const raw = fs.readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw);
    // migrate old state without lastPortfolioScanCandleTime
    if (!("lastPortfolioScanCandleTime" in parsed)) {
      parsed.lastPortfolioScanCandleTime = null;
    }
    return parsed;
  } catch {
    fs.writeFileSync(statePath, JSON.stringify(DEFAULT_STATE, null, 2));
    return { ...DEFAULT_STATE };
  }
}

function saveState(statePath, state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export async function runPortfolioOnce(options = {}) {
  const statePath  = options.statePath  ?? DEFAULT_STATE_PATH;
  const tradesPath = options.tradesPath ?? DEFAULT_TRADES_PATH;

  const state = loadState(statePath);

  // ── B. Existing open position: monitor TP/SL ──────────────────────────
  if (state.openPosition) {
    logInfo("Portfolio mode: existing position monitored");
    const engine = new PaperEngine(
      { ...config, symbol: state.openPosition.symbol },
      { statePath, tradesPath }
    );
    await engine.runOnce();
    return;
  }

  // ── C. No open position: scan all symbols ─────────────────────────────
  const results = options.scanProvider
    ? await options.scanProvider()
    : await scanPortfolio(config);

  const best = results[0];

  // ── D. Anti-spam: check if this candle was already scanned ────────────
  const latestPortfolioCandleTime = best?.candles?.[best.candles.length - 1]?.time ?? null;

  if (
    latestPortfolioCandleTime !== null &&
    state.lastPortfolioScanCandleTime === latestPortfolioCandleTime
  ) {
    logInfo("Portfolio candle already scanned. Waiting for new 5m candle.");
    logInfo(`  Best:   ${best.symbol}`);
    logInfo(`  Score:  ${best.score}`);
    logInfo(`  Signal: ${best.action}`);
    return;
  }

  // ── E. New candle: full analysis ──────────────────────────────────────
  logInfo("Best portfolio candidate:");
  logInfo(`  Symbol: ${best?.symbol ?? "N/A"}`);
  logInfo(`  Score:  ${best?.score  ?? 0}`);
  logInfo(`  Signal: ${best?.action ?? "N/A"}`);
  logInfo(`  Reason: ${best?.reason ?? "N/A"}`);

  if (best && best.score >= 80 && best.action === "BUY") {
    const engine = new PaperEngine(
      { ...config, symbol: best.symbol },
      {
        candlesProvider: async () => best.candles,
        statePath,
        tradesPath,
      }
    );
    await engine.runOnce();
    logInfo("Portfolio paper position opened or processed");
  } else {
    logInfo("No strong portfolio setup. No paper trade opened.");
  }

  // Save scan candle time after processing
  if (latestPortfolioCandleTime !== null) {
    state.lastPortfolioScanCandleTime = latestPortfolioCandleTime;
    saveState(statePath, state);
  }
}

// CLI entry point
if (process.argv[1].endsWith("portfolioPaperEngine.js")) {
  await runPortfolioOnce();
}
