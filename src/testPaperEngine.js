import fs from "fs";
import path from "path";
import { config } from "./config.js";
import { PaperEngine } from "./paperEngine.js";
import { createBullishCandles } from "./mockScenarios.js";

const TEST_STATE  = "data/test-state.json";
const TEST_TRADES = "data/test-trades.json";

const TEST_OPTS = {
  statePath:  TEST_STATE,
  tradesPath: TEST_TRADES,
  htfCandlesProvider: async () => createBullishCandles(),
};

function writeJson(filePath, data) {
  fs.writeFileSync(path.resolve(filePath), JSON.stringify(data, null, 2));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf-8"));
}

function resetFiles() {
  writeJson(TEST_STATE,  { balance: 1000, openPosition: null });
  writeJson(TEST_TRADES, []);
}

console.log("=== ZenBlade Paper Engine Test ===\n");

// ════════════════════════════════════════════════════════════
// TEST 1 — TAKE_PROFIT
// ════════════════════════════════════════════════════════════
console.log("── TAKE_PROFIT scenario ──");
resetFiles();

// Run 1: BUY → open position
const tp_engine1 = new PaperEngine(config, {
  ...TEST_OPTS,
  candlesProvider: async () => createBullishCandles(),
});
await tp_engine1.runOnce();

const tp_state1 = readJson(TEST_STATE);
if (!tp_state1.openPosition) {
  throw new Error("OPEN TEST FAILED: openPosition is null after first run");
}
const tp_pos = tp_state1.openPosition;
console.log("\nOPEN TEST: OK");
console.log(`  Entry: ${tp_pos.entryPrice}`);
console.log(`  Stop:  ${tp_pos.stopPrice}`);
console.log(`  Take:  ${tp_pos.takePrice}`);
console.log(`  Size:  ${tp_pos.size}`);

// Run 2: force TAKE_PROFIT
const tpCandles = createBullishCandles();
const tpLast = tpCandles.length - 1;
tpCandles[tpLast] = {
  ...tpCandles[tpLast],
  close:  tp_pos.takePrice + 10,
  high:   tp_pos.takePrice + 20,
  low:    tp_pos.takePrice - 20,
  volume: 300,
};

const tp_engine2 = new PaperEngine(config, {
  ...TEST_OPTS,
  candlesProvider: async () => tpCandles,
});
await tp_engine2.runOnce();

const tp_state2  = readJson(TEST_STATE);
const tp_trades  = readJson(TEST_TRADES);

if (tp_state2.openPosition !== null)
  throw new Error("CLOSE TEST FAILED: openPosition should be null after TAKE_PROFIT");
if (tp_trades.length !== 1)
  throw new Error(`CLOSE TEST FAILED: expected 1 trade, got ${tp_trades.length}`);
if (tp_trades[0].closeReason !== "TAKE_PROFIT")
  throw new Error(`CLOSE TEST FAILED: expected TAKE_PROFIT, got ${tp_trades[0].closeReason}`);
if (tp_trades[0].netPnl <= 0)
  throw new Error(`CLOSE TEST FAILED: expected netPnl > 0, got ${tp_trades[0].netPnl}`);

const tp_t = tp_trades[0];
console.log("\nCLOSE TEST: OK");
console.log(`  Exit Reason:   ${tp_t.closeReason}`);
console.log(`  Gross PnL:     ${tp_t.grossPnl} USDT`);
console.log(`  Fees:          ${tp_t.fees} USDT`);
console.log(`  Net PnL:       ${tp_t.netPnl} USDT`);
console.log(`  Final Balance: ${tp_state2.balance} USDT`);

// ════════════════════════════════════════════════════════════
// TEST 2 — STOP_LOSS
// ════════════════════════════════════════════════════════════
console.log("\n── STOP_LOSS scenario ──");
resetFiles();

// Run 1: BUY → open position
const sl_engine1 = new PaperEngine(config, {
  ...TEST_OPTS,
  candlesProvider: async () => createBullishCandles(),
});
await sl_engine1.runOnce();

const sl_state1 = readJson(TEST_STATE);
if (!sl_state1.openPosition) {
  throw new Error("STOP OPEN TEST FAILED: openPosition is null after first run");
}
const sl_pos = sl_state1.openPosition;
console.log("\nSTOP OPEN TEST: OK");

// Run 2: force STOP_LOSS
const slCandles = createBullishCandles();
const slLast = slCandles.length - 1;
slCandles[slLast] = {
  ...slCandles[slLast],
  close:  sl_pos.stopPrice - 10,
  high:   sl_pos.stopPrice + 20,
  low:    sl_pos.stopPrice - 20,
  volume: 300,
};

const sl_engine2 = new PaperEngine(config, {
  ...TEST_OPTS,
  candlesProvider: async () => slCandles,
});
await sl_engine2.runOnce();

const sl_state2 = readJson(TEST_STATE);
const sl_trades = readJson(TEST_TRADES);

if (sl_state2.openPosition !== null)
  throw new Error("STOP CLOSE TEST FAILED: openPosition should be null after STOP_LOSS");
if (sl_trades.length !== 1)
  throw new Error(`STOP CLOSE TEST FAILED: expected 1 trade, got ${sl_trades.length}`);
if (sl_trades[0].closeReason !== "STOP_LOSS")
  throw new Error(`STOP CLOSE TEST FAILED: expected STOP_LOSS, got ${sl_trades[0].closeReason}`);
if (sl_trades[0].netPnl >= 0)
  throw new Error(`STOP CLOSE TEST FAILED: expected netPnl < 0, got ${sl_trades[0].netPnl}`);
if (sl_state2.balance >= 1000)
  throw new Error(`STOP CLOSE TEST FAILED: expected balance < 1000, got ${sl_state2.balance}`);

const sl_t = sl_trades[0];
console.log("\nSTOP CLOSE TEST: OK");
console.log(`  Exit Reason:   ${sl_t.closeReason}`);
console.log(`  Gross PnL:     ${sl_t.grossPnl} USDT`);
console.log(`  Fees:          ${sl_t.fees} USDT`);
console.log(`  Net PnL:       ${sl_t.netPnl} USDT`);
console.log(`  Final Balance: ${sl_state2.balance} USDT`);

// ════════════════════════════════════════════════════════════
// Cleanup test files
// ════════════════════════════════════════════════════════════
fs.unlinkSync(path.resolve(TEST_STATE));
fs.unlinkSync(path.resolve(TEST_TRADES));
console.log("\n── Test files cleaned up ──");
