import { runStrategyStability } from "./research/strategyStability.js";

function printResult(result, index) {
  const maxVol = result.maxVolumeFactor ?? "∞";
  const totalPF = result.totalPF ?? "N/A";
  const avgPF   = result.avgWindowPF ?? "N/A";
  console.log(
    `${index + 1}. ${result.strategy} | ${result.symbols} | ` +
    `EMA ${result.emaFast}/${result.emaSlow} | ` +
    `RSI ${result.minRsi}-${result.maxRsi} | ` +
    `Vol ${result.minVolumeFactor}-${maxVol} | ` +
    `ATR ${result.atrStop}/${result.atrTake} | ` +
    `Trades ${result.totalTrades} | ` +
    `NetPnl ${result.totalNetPnl} USDT | ` +
    `PF ${totalPF} | AvgWinPF ${avgPF} | ` +
    `PosWins ${result.positiveWindows}/4 | ` +
    `MaxDD ${result.maxWindowDrawdown} | ` +
    `StableScore ${result.stableScore} | ` +
    `Candidate ${result.stableCandidate}`
  );
}

console.log("=== ZenBlade Strategy Stability ===\n");

const stability = await runStrategyStability({
  onProgress: (msg) => console.log(msg),
});

console.log(`\nTotal combinations tested: ${stability.results.length}`);
console.log(`Stable candidates found:   ${stability.candidates.length}`);

console.log("\nTop 10 by stable score:");
stability.topResults.forEach(printResult);

console.log("\nBest stable candidate:");
if (stability.bestStableCandidate) {
  printResult(stability.bestStableCandidate, 0);
} else {
  console.log("No stable candidate found");
}

console.log("\nWarnings:");
for (const warning of stability.warnings) {
  console.log(`- ${warning}`);
}

console.log("\nReports:");
console.log(`- ${stability.reports.jsonPath}`);
console.log(`- ${stability.reports.csvPath}`);
