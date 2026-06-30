import { sendTelegramMessage } from "./telegram.js";

const sent = await sendTelegramMessage("✅ ZenBlade Telegram test message");

if (sent) {
  console.log("Telegram test sent");
} else {
  console.log("Telegram test skipped or failed");
}
