import fs from "node:fs";
import path from "node:path";
import { appendExperiment } from "./experimentStore.js";

const LEGACY_MEMORY_DIR = path.resolve("research/memory");

function readLegacyMemoryFiles() {
  if (!fs.existsSync(LEGACY_MEMORY_DIR)) return [];

  return fs
    .readdirSync(LEGACY_MEMORY_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const filePath = path.join(LEGACY_MEMORY_DIR, name);
      return {
        fileName: name,
        memory: JSON.parse(fs.readFileSync(filePath, "utf8")),
      };
    });
}

function legacyMetrics(memory) {
  const observation = memory.currentObservation ?? {};
  return {
    closedTrades: observation.closedTrades ?? null,
    netPnlUSDT: observation.netPnlUSDT ?? null,
    openPositions: observation.openPositions ?? null,
    sampleSize: observation.sampleSize ?? null,
  };
}

export function importLegacyResearchMemory() {
  const legacyItems = readLegacyMemoryFiles();
  let created = 0;
  let skipped = 0;

  for (const { fileName, memory } of legacyItems) {
    const result = appendExperiment({
      strategyId: memory.strategyId ?? path.basename(fileName, ".json"),
      strategyName: memory.strategyName ?? memory.strategyId ?? fileName,
      experimentType: "legacy_research_memory",
      stage: memory.mode === "paper" ? "paper" : "research",
      status: memory.status ?? "legacy",
      source: `research/memory/${fileName}`,
      metrics: legacyMetrics(memory),
      decision: memory.lastDecision ?? null,
      notes: [
        ...(memory.knownProblems ?? []).map((item) => `problem: ${item}`),
        ...(memory.blockedChanges ?? []).map((item) => `blocked: ${item}`),
        ...(memory.nextResearch ?? []).map((item) => `next: ${item}`),
      ],
      tags: ["legacy", "imported"],
      legacyLastUpdated: memory.lastUpdated ?? null,
    });

    if (result.created) created += 1;
    else skipped += 1;
  }

  return { scanned: legacyItems.length, created, skipped };
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  try {
    const result = importLegacyResearchMemory();
    console.log("=== Autonomous Brain v1: legacy memory import ===");
    console.log(`Scanned: ${result.scanned}`);
    console.log(`Created: ${result.created}`);
    console.log(`Skipped duplicates: ${result.skipped}`);
    console.log("No trading actions were executed.");
  } catch (error) {
    console.error("Brain import failed:", error);
    process.exitCode = 1;
  }
}
