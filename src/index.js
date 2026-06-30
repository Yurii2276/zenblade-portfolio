import { config } from "./config.js";
import { PaperEngine } from "./paperEngine.js";
import { logInfo } from "./logger.js";

console.log("ZenBlade Portfolio стартує в paper mode");
console.log(`Mode: ${config.mode}`);
console.log(`Symbol: ${config.symbol}`);

async function main() {
  try {
    const engine = new PaperEngine();
    await engine.runOnce();
  } catch (err) {
    console.error("Помилка запуску:", err.message);
  }
}

main();
