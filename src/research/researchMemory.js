import fs from "node:fs";
import path from "node:path";

const MEMORY_DIR = path.resolve("research/memory");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function printMemoryItem(memory) {
  console.log("────────────────────────────────────────");
  console.log(`Strategy: ${memory.strategyName ?? memory.strategyId}`);
  console.log(`ID: ${memory.strategyId}`);
  console.log(`Status: ${memory.status}`);
  console.log(`Mode: ${memory.mode}`);
  console.log(`Last updated: ${memory.lastUpdated}`);
  console.log("");

  if (memory.lastDecision) {
    console.log("Last decision:");
    console.log(`- ${memory.lastDecision}`);
    console.log("");
  }

  if (memory.knownProblems?.length) {
    console.log("Known problems:");
    for (const item of memory.knownProblems) console.log(`- ${item}`);
    console.log("");
  }

  if (memory.blockedChanges?.length) {
    console.log("Blocked changes:");
    for (const item of memory.blockedChanges) console.log(`- ${item}`);
    console.log("");
  }

  if (memory.nextResearch?.length) {
    console.log("Next research:");
    for (const item of memory.nextResearch) console.log(`- ${item}`);
    console.log("");
  }
}

export function loadResearchMemory() {
  if (!fs.existsSync(MEMORY_DIR)) return [];

  return fs
    .readdirSync(MEMORY_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const filePath = path.join(MEMORY_DIR, name);
      return readJson(filePath);
    });
}

export function printResearchMemory() {
  console.log("=== ZenBlade Research Memory ===");
  console.log("Mode: research memory only — no real trading");
  console.log("");

  const items = loadResearchMemory();

  if (items.length === 0) {
    console.log("No research memory files found.");
    return;
  }

  for (const memory of items) {
    printMemoryItem(memory);
  }

  console.log("────────────────────────────────────────");
  console.log(`Loaded memory files: ${items.length}`);
}

const isDirectRun =
  process.argv[1] && import.meta.url === "file://" + process.argv[1];

if (isDirectRun) {
  try {
    printResearchMemory();
  } catch (err) {
    console.error("Failed to read ZenBlade research memory:", err);
    process.exitCode = 1;
  }
}
