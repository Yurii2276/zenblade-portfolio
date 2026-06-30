export async function fetchCandles({ symbol, bar, limit }) {
  const url = `https://www.okx.com/api/v5/market/history-candles?instId=${symbol}&bar=${bar}&limit=${limit}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`OKX HTTP помилка: ${response.status}`);
  }

  const json = await response.json();

  if (json.code !== "0") {
    throw new Error(`OKX API помилка: ${json.msg}`);
  }

  const parsed = json.data.map(([ts, o, h, l, c, vol, , , confirm]) => ({
    time:    Number(ts),
    open:    parseFloat(o),
    high:    parseFloat(h),
    low:     parseFloat(l),
    close:   parseFloat(c),
    volume:  parseFloat(vol),
    confirm: confirm === "1" || confirm === 1 ? 1 : 0,
  }));

  parsed.sort((a, b) => a.time - b.time);

  const confirmed = parsed.filter((c) => c.confirm === 1);

  if (confirmed.length === 0) {
    console.log("Warning: no confirmed candles returned by OKX");
    return parsed;
  }

  return confirmed;
}
