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

  return json.data.map(([ts, o, h, l, c, vol]) => ({
    time: Number(ts),
    open: parseFloat(o),
    high: parseFloat(h),
    low: parseFloat(l),
    close: parseFloat(c),
    volume: parseFloat(vol),
  }));
}
