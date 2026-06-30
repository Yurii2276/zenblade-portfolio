export async function sendTelegramMessage(message) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log("Telegram disabled: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing");
    return false;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" }),
    });

    const json = await res.json();

    if (!json.ok) {
      console.error(`Telegram error: ${json.description}`);
      return false;
    }

    return true;
  } catch (err) {
    console.error(`Telegram fetch error: ${err.message}`);
    return false;
  }
}
