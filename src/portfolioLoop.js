import { config } from "./config.js";
import { runPortfolioOnce } from "./portfolioPaperEngine.js";

const intervalMs = 60 * 1000;

console.log("ZenBlade Portfolio Paper Loop started");
console.log(`Symbols:  ${config.symbols.join(", ")}`);
console.log(`Bar:      ${config.bar}`);
console.log(`Interval: 60 seconds`);
console.log(`Mode:     ${config.mode}`);

async function tick() {
  console.log("----- Portfolio loop tick -----");
  try {
    await runPortfolioOnce();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Помилка тіку: ${err.message}`);
  }
}

await tick();
setInterval(tick, intervalMs);
