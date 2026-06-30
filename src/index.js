import { config } from "./config.js";
import { PaperEngine } from "./paperEngine.js";
import { logInfo } from "./logger.js";

console.log("ZenBlade Portfolio стартує в paper mode");
console.log(`Mode: ${config.mode}`);
console.log(`Symbol: ${config.symbol}`);

const engine = new PaperEngine();
engine.runOnce();
