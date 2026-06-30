import { config } from "./config.js";
import { PaperEngine } from "./paperEngine.js";
import { logInfo } from "./logger.js";

const intervalMs = 60 * 1000;

console.log("ZenBlade Paper Loop started");
console.log(`Symbol:   ${config.symbol}`);
console.log(`Bar:      ${config.bar}`);
console.log(`Interval: 60 seconds`);
console.log(`Mode:     ${config.mode}`);

const engine = new PaperEngine(config);

async function tick() {
  console.log("----- Paper loop tick -----");
  try {
    await engine.runOnce();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Помилка тіку: ${err.message}`);
  }
}

await tick();
setInterval(tick, intervalMs);
