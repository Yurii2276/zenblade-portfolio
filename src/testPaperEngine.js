import fs from "fs";
import path from "path";
import { config } from "./config.js";
import { PaperEngine } from "./paperEngine.js";
import { createBullishCandles } from "./mockScenarios.js";

const STATE_PATH = path.resolve("data/state.json");
const TRADES_PATH = path.resolve("data/trades.json");

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

// ── A. Reset state and trades ──────────────────────────────────────────────
writeJson(STATE_PATH, { balance: 1000, openPosition: null });
writeJson(TRADES_PATH, []);

console.log("=== ZenBlade Paper Engine Test ===\n");

// ── B/C. First run: expect BUY → openPosition ──────────────────────────────
const engine1 = new PaperEngine(config, {
  candlesProvider: async () => createBullishCandles(),
});

await engine1.runOnce();

const state1 = readJson(STATE_PATH);

if (!state1.openPosition) {
  throw new Error("OPEN TEST FAILED: openPosition is null after first run");
}

const pos = state1.openPosition;
console.log("\nOPEN TEST: OK");
console.log(`  Entry: ${pos.entryPrice}`);
console.log(`  Stop:  ${pos.stopPrice}`);
console.log(`  Take:  ${pos.takePrice}`);
console.log(`  Size:  ${pos.size}`);

// ── D. Second run: force TAKE_PROFIT ──────────────────────────────────────
const tpCandles = createBullishCandles();
const lastIdx = tpCandles.length - 1;
tpCandles[lastIdx] = {
  ...tpCandles[lastIdx],
  close: pos.takePrice + 10,
  high: pos.takePrice + 20,
  low: pos.takePrice - 20,
  volume: 300,
};

const engine2 = new PaperEngine(config, {
  candlesProvider: async () => tpCandles,
});

await engine2.runOnce();

const state2 = readJson(STATE_PATH);
const trades = readJson(TRADES_PATH);

if (state2.openPosition !== null) {
  throw new Error("CLOSE TEST FAILED: openPosition should be null after TAKE_PROFIT");
}
if (trades.length !== 1) {
  throw new Error(`CLOSE TEST FAILED: expected 1 trade, got ${trades.length}`);
}
if (trades[0].closeReason !== "TAKE_PROFIT") {
  throw new Error(`CLOSE TEST FAILED: expected closeReason TAKE_PROFIT, got ${trades[0].closeReason}`);
}
if (trades[0].netPnl <= 0) {
  throw new Error(`CLOSE TEST FAILED: expected netPnl > 0, got ${trades[0].netPnl}`);
}

const t = trades[0];
console.log("\nCLOSE TEST: OK");
console.log(`  Exit Reason:   ${t.closeReason}`);
console.log(`  Gross PnL:     ${t.grossPnl} USDT`);
console.log(`  Fees:          ${t.fees} USDT`);
console.log(`  Net PnL:       ${t.netPnl} USDT`);
console.log(`  Final Balance: ${state2.balance} USDT`);
