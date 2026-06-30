import { runStrategySweep } from "./research/strategySweep.js";

function printResult(result, index) {
  console.log(
    `${index + 1}. ${result.strategy} | ${result.symbols} | ` +
    `EMA ${result.emaFast}/${result.emaSlow} | ` +
    `RSI ${result.minRsi}-${result.maxRsi} | ` +
    `Vol ${result.minVolumeFactor}-${result.maxVolumeFactor ?? "∞"} | ` +
    `ATR ${result.atrStop}/${result.atrTake} | ` +
    `Train: ${result.trainNetPnl} USDT, PF ${result.trainPF ?? "N/A"}, ${result.trainTrades} trades | ` +
    `Test: ${result.testNetPnl} USDT, PF ${result.testPF ?? "N/A"}, ${result.testTrades} trades | ` +
    `Score ${result.score} | Candidate ${result.candidate}`
  );
}

console.log("=== ZenBlade Strategy Sweep ===");

const sweep = await runStrategySweep({
  onProgress: (message) => console.log(message),
});

console.log(`\nTotal combinations tested: ${sweep.results.length}`);
console.log(`Candidates found: ${sweep.candidates.length}`);
console.log("\nTop 10 by test score:");
sweep.topResults.forEach(printResult);

console.log("\nBest robust candidate:");
if (sweep.bestRobustCandidate) {
  printResult(sweep.bestRobustCandidate, 0);
} else {
  console.log("No robust candidate found");
}

console.log("\nWarnings:");
for (const warning of sweep.warnings) {
  console.log(`- ${warning}`);
}

console.log("\nReports:");
console.log(`- ${sweep.reports.jsonPath}`);
console.log(`- ${sweep.reports.csvPath}`);
