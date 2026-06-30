import fs from "fs";
import path from "path";
import { config } from "./config.js";
import { scanPortfolio } from "./portfolioScanner.js";
import { PaperEngine } from "./paperEngine.js";
import { logInfo } from "./logger.js";

const DEFAULT_STATE_PATH  = path.resolve("data/state.json");
const DEFAULT_TRADES_PATH = path.resolve("data/trades.json");

const DEFAULT_STATE = { balance: 1000, openPosition: null, lastProcessedCandleTime: null };

function loadState(statePath) {
  try {
    const raw = fs.readFileSync(statePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    fs.writeFileSync(statePath, JSON.stringify(DEFAULT_STATE, null, 2));
    return DEFAULT_STATE;
  }
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

  logInfo("Best portfolio candidate:");
  logInfo(`  Symbol: ${best?.symbol ?? "N/A"}`);
  logInfo(`  Score:  ${best?.score  ?? 0}`);
  logInfo(`  Signal: ${best?.action ?? "N/A"}`);
  logInfo(`  Reason: ${best?.reason ?? "N/A"}`);

  // ── D. Strong BUY setup ───────────────────────────────────────────────
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
    return;
  }

  // ── E. No strong setup ────────────────────────────────────────────────
  logInfo("No strong portfolio setup. No paper trade opened.");
}

// CLI entry point
if (process.argv[1].endsWith("portfolioPaperEngine.js")) {
  await runPortfolioOnce();
}
