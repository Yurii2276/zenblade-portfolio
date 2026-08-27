import fs from "node:fs";
import path from "node:path";
import { appendExperiment } from "./experimentStore.js";

const DEFAULT_SEED_FILE = path.resolve("research/brain-seed/legacy-bots-2026-08-27.json");

export function importSeedKnowledge(seedFile = DEFAULT_SEED_FILE) {
  if (!fs.existsSync(seedFile)) {
    return { scanned: 0, created: 0, skipped: 0 };
  }

  const records = JSON.parse(fs.readFileSync(seedFile, "utf8"));
  if (!Array.isArray(records)) {
    throw new Error(`Expected seed array in ${seedFile}`);
  }

  let created = 0;
  let skipped = 0;
  for (const record of records) {
    const result = appendExperiment(record);
    if (result.created) created += 1;
    else skipped += 1;
  }

  return { scanned: records.length, created, skipped };
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  try {
    const result = importSeedKnowledge(process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_SEED_FILE);
    console.log("=== Autonomous Brain v1: historical seed import ===");
    console.log(`Scanned: ${result.scanned}`);
    console.log(`Created: ${result.created}`);
    console.log(`Skipped duplicates: ${result.skipped}`);
    console.log("No trading actions were executed.");
  } catch (error) {
    console.error("Historical seed import failed:", error);
    process.exitCode = 1;
  }
}
