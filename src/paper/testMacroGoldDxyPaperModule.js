/**
 * Phase 6 test for Macro Gold DXY paper module.
 *
 * Tests:
 * - paper persistence with MACRO_GOLD_DXY_DRY_RUN=false
 * - duplicate-position protection
 * - used signal TTL protection
 * - max-hold close path
 *
 * Uses separate test state/trades files.
 * Does not touch Railway.
 * Does not touch the main strategy paper state.
 */

import fs from "node:fs";
import { execFileSync } from "node:child_process";

const STATE_PATH = "data/test-macro-gold-dxy-paper-state.json";
const TRADES_PATH = "data/test-macro-gold-dxy-paper-trades.json";

const baseEnv = {
  ...process.env,
  MACRO_GOLD_DXY_DRY_RUN: "false",
  MACRO_GOLD_DXY_STATE_PATH: STATE_PATH,
  MACRO_GOLD_DXY_TRADES_PATH: TRADES_PATH,

  // Forced relaxed thresholds for test only.
  // This makes the module take the BUY branch regardless of current macro regime.
  MACRO_GOLD_DXY_DXY_MAX_2D_PCT: "999",
  MACRO_GOLD_DXY_XAUT_MIN_2D_PCT: "-999",
  MACRO_GOLD_DXY_MAX_ABS_DXY_CHANGE_2D_PCT: "999",

  // This persistence test deliberately isolates the BUY/persistence path.
  // Production freshness defaults remain unchanged.
  MACRO_GOLD_DXY_MAX_DATE_GAP_DAYS: "999",
  MACRO_GOLD_DXY_MAX_DATA_AGE_DAYS: "999",

  // Keep test small and fast.
  MACRO_GOLD_DXY_SYMBOLS: "BTC-USDT",
};

function cleanup() {
  fs.rmSync(STATE_PATH, { force: true });
  fs.rmSync(TRADES_PATH, { force: true });
}

function readJson(path, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`ASSERT_FAILED: ${message}`);
  }
}

function runModule(label) {
  console.log("");
  console.log(`=== ${label} ===`);

  const output = execFileSync(
    process.execPath,
    ["src/paper/macroGoldDxyPaperModule.js"],
    {
      env: baseEnv,
      encoding: "utf8",
    }
  );

  console.log(output);
  return output;
}

console.log("=== Macro Gold DXY Paper Module Phase 6 Test ===");
console.log("Mode: local paper persistence test only");
console.log("No real trading. No private API keys. Not Railway.");
console.log(`State: ${STATE_PATH}`);
console.log(`Trades: ${TRADES_PATH}`);

cleanup();

runModule("RUN 1 — should open one BTC paper position");

let state = readJson(STATE_PATH, null);
let trades = readJson(TRADES_PATH, []);

assert(state, "state file should exist after RUN 1");
assert(Array.isArray(state.openPositions), "state.openPositions should be an array");
assert(state.openPositions.length === 1, "RUN 1 should create exactly one open position");
assert(state.openPositions[0].symbol === "BTC-USDT", "open position should be BTC-USDT");
assert(trades.length === 0, "RUN 1 should not close trades yet");

const usedSignalCountAfterRun1 = Object.keys(state.usedSignalKeys ?? {}).length;
assert(usedSignalCountAfterRun1 === 1, "RUN 1 should record exactly one used signal key");

runModule("RUN 2 — should skip duplicate because position is already open");

state = readJson(STATE_PATH, null);
trades = readJson(TRADES_PATH, []);

assert(state.openPositions.length === 1, "RUN 2 should still have exactly one open position");
assert(trades.length === 0, "RUN 2 should still have zero closed trades");

const usedSignalCountAfterRun2 = Object.keys(state.usedSignalKeys ?? {}).length;
assert(
  usedSignalCountAfterRun2 === usedSignalCountAfterRun1,
  "RUN 2 should not create a duplicate used signal key"
);

// Simulate position older than 48 hours.
// Next run should close it via MAX_HOLD_48H.
// Then it should NOT reopen because used signal TTL is still fresh.
state.openPositions[0].openedAt = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
writeJson(STATE_PATH, state);

runModule("RUN 3 — should close old position and skip re-entry due signal TTL");

state = readJson(STATE_PATH, null);
trades = readJson(TRADES_PATH, []);

assert(state.openPositions.length === 0, "RUN 3 should close the aged open position");
assert(trades.length === 1, "RUN 3 should create exactly one closed trade");
assert(trades[0].exitRule === "MAX_HOLD_48H", "closed trade should use MAX_HOLD_48H");
assert(trades[0].symbol === "BTC-USDT", "closed trade should be BTC-USDT");

const usedSignalCountAfterRun3 = Object.keys(state.usedSignalKeys ?? {}).length;
assert(
  usedSignalCountAfterRun3 === usedSignalCountAfterRun1,
  "RUN 3 should not create a new signal key because TTL should block re-entry"
);

console.log("");
console.log("=== TEST PASSED ===");
console.log("- persistence works in isolated test files");
console.log("- duplicate open position protection works");
console.log("- MAX_HOLD_48H close works");
console.log("- signal TTL blocks immediate re-entry");
console.log("- main paper-loop was not touched");

if (process.env.KEEP_MACRO_GOLD_DXY_TEST_FILES !== "true") {
  cleanup();
  console.log("- test state/trades files cleaned up");
}
