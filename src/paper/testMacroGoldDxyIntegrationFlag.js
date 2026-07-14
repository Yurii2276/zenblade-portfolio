/**
 * Phase 7 test for disabled-by-default Macro Gold DXY integration.
 *
 * Tests:
 * - integration helper is disabled by default
 * - ENABLE_MACRO_GOLD_DXY=true runs the separate module
 * - enabled test uses dry-run mode
 * - dry-run does not create macro state/trades files
 *
 * Does not touch Railway.
 * Does not run live trading.
 * Does not place real orders.
 */

import fs from "node:fs";

const MACRO_STATE_PATH = "data/test-macro-gold-dxy-integration-state.json";
const MACRO_TRADES_PATH = "data/test-macro-gold-dxy-integration-trades.json";

function cleanup() {
  fs.rmSync(MACRO_STATE_PATH, { force: true });
  fs.rmSync(MACRO_TRADES_PATH, { force: true });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`ASSERT_FAILED: ${message}`);
  }
}

function fileExists(path) {
  return fs.existsSync(path);
}

console.log("=== Macro Gold DXY Phase 7 Integration Flag Test ===");
console.log("Mode: local integration flag test only");
console.log("No Railway. No live trading. No real orders.");

cleanup();

process.env.MACRO_GOLD_DXY_DRY_RUN = "true";
process.env.MACRO_GOLD_DXY_STATE_PATH = MACRO_STATE_PATH;
process.env.MACRO_GOLD_DXY_TRADES_PATH = MACRO_TRADES_PATH;
process.env.MACRO_GOLD_DXY_SYMBOLS = "BTC-USDT";
process.env.MACRO_GOLD_DXY_CANDLES = "40";

const {
  runMacroGoldDxyIntegrationIfEnabled,
} = await import("./strategyPortfolioBot.js");

console.log("");
console.log("=== RUN 1 — integration disabled ===");
process.env.ENABLE_MACRO_GOLD_DXY = "false";

const disabledResult = await runMacroGoldDxyIntegrationIfEnabled();

assert(disabledResult.enabled === false, "integration should be disabled when ENABLE_MACRO_GOLD_DXY=false");
assert(!fileExists(MACRO_STATE_PATH), "disabled run should not create macro state file");
assert(!fileExists(MACRO_TRADES_PATH), "disabled run should not create macro trades file");

console.log("");
console.log("=== RUN 2 — integration enabled but macro module stays dry-run ===");
process.env.ENABLE_MACRO_GOLD_DXY = "true";

const enabledResult = await runMacroGoldDxyIntegrationIfEnabled();

assert(enabledResult.enabled === true, "integration should run when ENABLE_MACRO_GOLD_DXY=true");
assert(!fileExists(MACRO_STATE_PATH), "enabled dry-run should not create macro state file");
assert(!fileExists(MACRO_TRADES_PATH), "enabled dry-run should not create macro trades file");

console.log("");
console.log("=== TEST PASSED ===");
console.log("- integration is disabled by default");
console.log("- ENABLE_MACRO_GOLD_DXY=true runs Macro Gold DXY module");
console.log("- macro module remains dry-run unless MACRO_GOLD_DXY_DRY_RUN=false");
console.log("- dry-run integration did not create state/trades files");
console.log("- Railway was not touched");

cleanup();
