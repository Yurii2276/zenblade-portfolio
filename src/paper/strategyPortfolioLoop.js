import { runStrategyPortfolioOnce } from "./strategyPortfolioBot.js";
import { config as baseConfig } from "../config.js";
import { sendTelegramMessage } from "../telegram.js";

const intervalMinutes = Number.parseFloat(process.env.PAPER_LOOP_MINUTES ?? "5");
const intervalMs = Math.max(1, intervalMinutes) * 60 * 1000;

console.log("ZenBlade Strategy Paper Portfolio Loop started");
console.log(`Interval: ${intervalMinutes} minute(s)`);
console.log("Mode: paper only — no real trading");

async function notifyLoopStarted() {
  if (!baseConfig.telegramEnabled || !baseConfig.notifyOnLoopStart) return;

  try {
    await sendTelegramMessage(
      `🚀 ZenBlade paper loop started\n` +
        `Mode: paper only — no real trading\n` +
        `Interval: ${intervalMinutes} minute(s)`
    );
  } catch (error) {
    console.error(`Telegram loop-start notify failed: ${error.message}`);
  }
}

await notifyLoopStarted();

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
