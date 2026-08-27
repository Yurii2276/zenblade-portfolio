import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importBotLog } from "./importBotLogs.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-log-"));
const sourceFile = path.join(tempDir, "qorb.json");
const brainFile = path.join(tempDir, "brain", "experiments.ndjson");

const records = [
  { message: "QORB PAPER REVERSAL BOT V1", timestamp: "2026-08-26T00:00:00Z" },
  { message: "Starting balance: 1000 USDT", timestamp: "2026-08-26T00:00:01Z" },
  { message: "Current balance: 954.5062 USDT", timestamp: "2026-08-26T00:00:02Z" },
  { message: "Realized PnL: -45.4938 USDT", timestamp: "2026-08-26T00:00:03Z" },
  { message: "Closed trades: 13", timestamp: "2026-08-26T00:00:04Z" },
  { message: "No READY paper short candidates.", timestamp: "2026-08-26T00:00:05Z" }
];

try {
  fs.writeFileSync(sourceFile, JSON.stringify(records), "utf8");
  const result = importBotLog(sourceFile, { filePath: brainFile });
  assert.equal(result.created, true);
  assert.equal(result.experiment.strategyId, "qorb-paper-reversal");
  assert.equal(result.experiment.metrics.realizedPnlUSDT, -45.4938);
  assert.equal(result.experiment.metrics.closedTrades, 13);
  assert.equal(fs.existsSync(brainFile), true);
  console.log("Brain bot log import test passed.");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
