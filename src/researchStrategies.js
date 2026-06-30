import { runTradeResearch } from "./research/tradeResearch.js";
import { writeResearchReports } from "./research/reportWriter.js";

function printGroups(groups) {
  if (groups.length === 0) {
    console.log("  None");
    return;
  }

  for (const group of groups.slice(0, 5)) {
    console.log(
      `  ${group.groupType}/${group.groupName}: ` +
      `${group.trades} trades | Net PnL ${group.netPnl} USDT | ` +
      `PF ${group.profitFactor ?? "N/A"}`
    );
  }
}

console.log("=== ZenBlade Strategy Research ===");

const research = await runTradeResearch({
  onProgress: (message) => console.log(message),
});
const reports = writeResearchReports(research);

console.log(`\nTrades analyzed: ${research.trades.length}`);
console.log("\nBest groups:");
printGroups(research.topWinningGroups);
console.log("\nWorst groups:");
printGroups(research.worstLosingGroups);
console.log("\nKey recommendations:");
for (const recommendation of research.recommendations) {
  console.log(`  - ${recommendation.message}`);
}
console.log("\nReports:");
console.log(`  ${reports.tradesPath}`);
console.log(`  ${reports.summaryPath}`);
console.log(`  ${reports.csvPath}`);

if (research.errors.length > 0) {
  console.error("\nResearch completed with candle-loading errors:");
  for (const error of research.errors) {
    console.error(`  ${error.symbol}: ${error.error}`);
  }
  process.exitCode = 1;
}
