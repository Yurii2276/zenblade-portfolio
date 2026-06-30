import fs from "fs";
import { runPortfolioOnce } from "./portfolioPaperEngine.js";
import { createBullishCandles } from "./mockScenarios.js";
import { getSignal } from "./strategy.js";
import { config } from "./config.js";

const STATE_PATH  = "data/test-portfolio-state.json";
const TRADES_PATH = "data/test-portfolio-trades.json";

// ── A. Initialise test files ───────────────────────────────────────────
fs.writeFileSync(STATE_PATH,  JSON.stringify({ balance: 1000, openPosition: null, lastProcessedCandleTime: null }, null, 2));
fs.writeFileSync(TRADES_PATH, JSON.stringify([], null, 2));

// ── B/C. Build mock candles and signal ────────────────────────────────
const candles = createBullishCandles();
const signal  = getSignal({ candles, config });

// ── D. Fake scan provider: SOL-USDT strong BUY, BTC-USDT weak HOLD ────
async function scanProvider() {
  return [
    {
      symbol:     "SOL-USDT",
      action:     signal.action,
      score:      95,
      reason:     signal.reason,
      candles,
      indicators: signal.indicators,
    },
    {
      symbol:     "BTC-USDT",
      action:     "HOLD",
      score:      40,
      reason:     "Mock weak setup",
      candles,
      indicators: signal.indicators,
    },
  ];
}

// ── E. Run portfolio engine with injected provider ─────────────────────
await runPortfolioOnce({
  scanProvider,
  statePath:  STATE_PATH,
  tradesPath: TRADES_PATH,
});

// ── F. Read back and verify ────────────────────────────────────────────
const state  = JSON.parse(fs.readFileSync(STATE_PATH,  "utf-8"));
const trades = JSON.parse(fs.readFileSync(TRADES_PATH, "utf-8"));

const pos = state.openPosition;

if (!pos)                        throw new Error("FAIL: openPosition is null after BUY signal");
if (pos.symbol !== "SOL-USDT")   throw new Error(`FAIL: expected symbol SOL-USDT, got ${pos.symbol}`);
if (pos.side   !== "LONG")       throw new Error(`FAIL: expected side LONG, got ${pos.side}`);
if (state.balance !== 1000)      throw new Error(`FAIL: expected balance 1000, got ${state.balance}`);
if (trades.length !== 0)         throw new Error(`FAIL: expected 0 trades, got ${trades.length}`);

// ── G. Print result ───────────────────────────────────────────────────
console.log("PORTFOLIO OPEN TEST: OK");
console.log(`Symbol:         ${pos.symbol}`);
console.log(`Entry:          ${pos.entryPrice}`);
console.log(`Stop:           ${pos.stopPrice}`);
console.log(`Take:           ${pos.takePrice}`);
console.log(`Size:           ${pos.size}`);
console.log(`Position Value: ${pos.positionValue}`);

// ── H. Cleanup ────────────────────────────────────────────────────────
fs.unlinkSync(STATE_PATH);
fs.unlinkSync(TRADES_PATH);
