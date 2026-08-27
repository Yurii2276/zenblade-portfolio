import { runAutonomousPaperOnce } from "./autonomousPaperEngine.js";

const intervalMs = Math.max(
  60_000,
  Number.parseInt(process.env.AUTO_PAPER_INTERVAL_MS ?? "300000", 10) || 300_000
);

let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const result = await runAutonomousPaperOnce();
    console.log(
      `[auto-paper] ${new Date().toISOString()} ` +
        `approvals=${result.approvals} balance=${result.state.balance} ` +
        `open=${result.state.openPositions.length} closed=${result.trades.length} ` +
        `paused=${result.state.pausedReason ?? "no"}`
    );
  } catch (error) {
    console.error(`[auto-paper] ${new Date().toISOString()} ERROR: ${error.message}`);
  } finally {
    running = false;
  }
}

console.log("=== Autonomous Paper Loop v1 ===");
console.log("PAPER ONLY — live exchange orders are not supported by this process");
console.log(`Interval: ${intervalMs} ms`);

await tick();
setInterval(tick, intervalMs);
