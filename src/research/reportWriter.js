import fs from "fs";
import path from "path";

function csvCell(value) {
  const text = value === null || value === undefined ? "N/A" : String(value);
  return `"${text.replaceAll("\"", "\"\"")}"`;
}

export function writeResearchReports(research, reportsDir = "reports") {
  const outputDir = path.resolve(reportsDir);
  fs.mkdirSync(outputDir, { recursive: true });

  const generatedAt = new Date().toISOString();
  const tradesPath = path.join(outputDir, "research-trades.json");
  const summaryPath = path.join(outputDir, "research-summary.json");
  const csvPath = path.join(outputDir, "research-summary.csv");

  fs.writeFileSync(
    tradesPath,
    JSON.stringify({
      generatedAt,
      totalTrades: research.trades.length,
      trades: research.trades,
    }, null, 2)
  );

  fs.writeFileSync(
    summaryPath,
    JSON.stringify({
      generatedAt,
      totalTrades: research.trades.length,
      groupedSummaries: research.groupedSummaries,
      topWinningGroups: research.topWinningGroups,
      worstLosingGroups: research.worstLosingGroups,
      recommendations: research.recommendations,
      errors: research.errors,
    }, null, 2)
  );

  const columns = [
    "groupType",
    "groupName",
    "trades",
    "wins",
    "losses",
    "winRate",
    "netPnl",
    "avgTrade",
    "profitFactor",
    "avgMfe",
    "avgMae",
  ];
  const csvRows = [
    columns.join(","),
    ...research.groupedSummaries.map((summary) =>
      columns.map((column) => csvCell(summary[column])).join(",")
    ),
  ];
  fs.writeFileSync(csvPath, `${csvRows.join("\n")}\n`);

  return {
    outputDir,
    tradesPath,
    summaryPath,
    csvPath,
  };
}
