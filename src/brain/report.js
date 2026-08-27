import { EXPERIMENTS_FILE, loadExperiments, summarizeExperiments } from "./experimentStore.js";

function printGroup(title, values) {
  console.log(title);
  const entries = Object.entries(values).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    console.log("- none");
    return;
  }
  for (const [key, value] of entries) console.log(`- ${key}: ${value}`);
}

export function printBrainReport() {
  const experiments = loadExperiments();
  const summary = summarizeExperiments(experiments);

  console.log("=== Autonomous Trading Brain v1 ===");
  console.log("Mode: research memory only — no real orders");
  console.log(`Store: ${EXPERIMENTS_FILE}`);
  console.log(`Experiments: ${summary.total}`);
  console.log("");
  printGroup("By stage:", summary.byStage);
  console.log("");
  printGroup("By status:", summary.byStatus);
  console.log("");
  printGroup("By strategy:", summary.byStrategy);
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  try {
    printBrainReport();
  } catch (error) {
    console.error("Brain report failed:", error);
    process.exitCode = 1;
  }
}
