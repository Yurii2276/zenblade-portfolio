import { runStrategyPortfolioOnce } from "./strategyPortfolioBot.js";

const intervalMinutes = Number.parseFloat(process.env.PAPER_LOOP_MINUTES ?? "5");
const intervalMs = Math.max(1, intervalMinutes) * 60 * 1000;

console.log("ZenBlade Strategy Paper Portfolio Loop started");
console.log(`Interval: ${intervalMinutes} minute(s)`);
console.log("Mode: paper only — no real trading");

async function tick() {
  console.log();
  console.log(`----- Strategy paper tick ${new Date().toISOString()} -----`);

  try {
    await runStrategyPortfolioOnce();
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Tick error: ${error.message}`);
  }
}

await tick();
setInterval(tick, intervalMs);
