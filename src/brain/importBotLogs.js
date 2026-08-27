import fs from "node:fs";
import path from "node:path";
import { appendExperiment } from "./experimentStore.js";

function parseNumber(message, pattern) {
  const match = message.match(pattern);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function detectBot(messages) {
  const joined = messages.join("\n");
  if (joined.includes("QORB PAPER REVERSAL BOT")) return "qorb-paper-reversal";
  if (joined.includes("QORB LIVE MACRO BOT")) return "qorb-live-macro";
  if (joined.includes("QORB DIP LIVE")) return "qorb-dip-live";
  return null;
}

function lastNumeric(messages, pattern) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const value = parseNumber(messages[index], pattern);
    if (value !== null) return value;
  }
  return null;
}

function countMatches(messages, pattern) {
  return messages.reduce((count, message) => count + (pattern.test(message) ? 1 : 0), 0);
}

function summarizeLog(records, fileName) {
  const messages = records.map((item) => String(item?.message ?? ""));
  const botId = detectBot(messages);
  if (!botId) return null;

  const timestamps = records
    .map((item) => item?.timestamp)
    .filter(Boolean)
    .sort();

  const firstTimestamp = timestamps[0] ?? null;
  const lastTimestamp = timestamps.at(-1) ?? null;

  const metrics = {
    records: records.length,
    startingBalanceUSDT: lastNumeric(messages, /Starting balance:\s*(-?\d+(?:\.\d+)?)\s*USDT/i),
    currentBalanceUSDT: lastNumeric(messages, /Current balance:\s*(-?\d+(?:\.\d+)?)\s*USDT/i),
    realizedPnlUSDT: lastNumeric(messages, /Realized PnL:\s*(-?\d+(?:\.\d+)?)\s*USDT/i),
    closedTrades: lastNumeric(messages, /Closed trades:\s*(\d+)/i),
    openPositions: lastNumeric(messages, /Open positions:\s*(\d+)/i),
    waitCount: countMatches(messages, /\b(?:STATUS|Action):\s*WAIT\b/i),
    noSignalCount: countMatches(messages, /\b(?:Status|STATUS):\s*NO_SIGNAL\b/i),
    fatalErrorCount: countMatches(messages, /FATAL ERROR|Bad data/i),
    skippedInstrumentCount: countMatches(messages, /Skip candles .*Instrument ID.*doesn't exist/i),
  };

  const notes = [];
  if ((metrics.realizedPnlUSDT ?? 0) < 0) {
    notes.push(`negative realized PnL: ${metrics.realizedPnlUSDT} USDT`);
  }
  if (metrics.waitCount > 0 || metrics.noSignalCount > 0) {
    notes.push(`inactive decisions observed: WAIT=${metrics.waitCount}, NO_SIGNAL=${metrics.noSignalCount}`);
  }
  if (metrics.fatalErrorCount > 0 || metrics.skippedInstrumentCount > 0) {
    notes.push(`data/runtime issues observed: fatal=${metrics.fatalErrorCount}, skipped instruments=${metrics.skippedInstrumentCount}`);
  }

  return {
    strategyId: botId,
    strategyName: botId,
    experimentType: "legacy_bot_log",
    stage: "paper",
    status: "historical_observation",
    source: `legacy-log:${fileName}`,
    metrics,
    decision: "Use as historical evidence only; do not promote to live trading from log data alone.",
    notes,
    tags: ["legacy", "log-import", "paper"],
    parameters: {
      firstTimestamp,
      lastTimestamp,
    },
  };
}

export function importBotLog(filePath, options = {}) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(raw)) {
    throw new Error(`Expected JSON array in ${filePath}`);
  }

  const summary = summarizeLog(raw, path.basename(filePath));
  if (!summary) {
    return { created: false, skipped: true, reason: "unsupported_non_trading_log", experiment: null };
  }

  return appendExperiment(summary, options);
}

export function importBotLogs(filePaths, options = {}) {
  const results = [];
  for (const filePath of filePaths) {
    results.push({ filePath, ...importBotLog(filePath, options) });
  }
  return results;
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  const filePaths = process.argv.slice(2);
  if (filePaths.length === 0) {
    console.error("Usage: npm run brain:import-logs -- path/to/log1.json [path/to/log2.json ...]");
    process.exitCode = 1;
  } else {
    try {
      const results = importBotLogs(filePaths);
      console.log("=== Autonomous Brain v1: bot log import ===");
      for (const result of results) {
        const target = result.experiment?.strategyId ?? result.reason ?? "unknown";
        console.log(`${result.created ? "IMPORTED" : "SKIPPED"}: ${result.filePath} -> ${target}`);
      }
      console.log("No trading actions were executed.");
    } catch (error) {
      console.error("Bot log import failed:", error);
      process.exitCode = 1;
    }
  }
}
