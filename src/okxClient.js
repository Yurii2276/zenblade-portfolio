const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchHistoricalCandles({ symbol, bar, targetLimit }) {
  const allCandles = new Map(); // time → candle (dedup)
  let after = undefined; // OKX `after` = return candles OLDER than this timestamp

  while (allCandles.size < targetLimit) {
    const url =
      `https://www.okx.com/api/v5/market/history-candles?instId=${symbol}&bar=${bar}&limit=100` +
      (after !== undefined ? `&after=${after}` : "");

    let json;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        console.error(`OKX HTTP помилка: ${response.status} для ${symbol}`);
        break;
      }
      json = await response.json();
    } catch (err) {
      console.error(`Помилка мережі для ${symbol}: ${err.message}`);
      break;
    }

    if (json.code !== "0") {
      console.error(`OKX API помилка для ${symbol}: ${json.msg}`);
      break;
    }

    const page = json.data ?? [];
    if (page.length === 0) break;

    let added = 0;
    for (const row of page) {
      const ts = Number(row[0]);
      if (!allCandles.has(ts)) {
        allCandles.set(ts, {
          time:    ts,
          open:    parseFloat(row[1]),
          high:    parseFloat(row[2]),
          low:     parseFloat(row[3]),
          close:   parseFloat(row[4]),
          volume:  parseFloat(row[5]),
          confirm: row[8] === "1" || row[8] === 1 ? 1 : 0,
        });
        added++;
      }
    }

    if (added === 0) break; // no new data — stop to avoid infinite loop

    // OKX history-candles: data comes newest→oldest; last item in page is the oldest
    // `after=oldestTs` on next request fetches candles older than oldestTs
    const oldestTs = Number(page[page.length - 1][0]);
    after = oldestTs;

    await sleep(250);
  }

  let sorted = Array.from(allCandles.values()).sort((a, b) => a.time - b.time);

  const confirmed = sorted.filter((c) => c.confirm === 1);
  return confirmed.length > 0 ? confirmed : sorted;
}

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


export async function fetchOkxUsdtSpotSymbols({ maxSymbols = 80 } = {}) {
  const instrumentsUrl = "https://www.okx.com/api/v5/public/instruments?instType=SPOT";
  const tickersUrl = "https://www.okx.com/api/v5/market/tickers?instType=SPOT";

  let instrumentsJson;
  let tickersJson;

  try {
    const [instrumentsResponse, tickersResponse] = await Promise.all([
      fetch(instrumentsUrl),
      fetch(tickersUrl),
    ]);

    if (!instrumentsResponse.ok) {
      throw new Error(`OKX instruments HTTP помилка: ${instrumentsResponse.status}`);
    }

    if (!tickersResponse.ok) {
      throw new Error(`OKX tickers HTTP помилка: ${tickersResponse.status}`);
    }

    instrumentsJson = await instrumentsResponse.json();
    tickersJson = await tickersResponse.json();
  } catch (err) {
    console.error(`OKX symbol discovery network error: ${err.message}`);
    return [];
  }

  if (instrumentsJson.code !== "0") {
    console.error(`OKX instruments API error: ${instrumentsJson.msg}`);
    return [];
  }

  if (tickersJson.code !== "0") {
    console.error(`OKX tickers API error: ${tickersJson.msg}`);
    return [];
  }

  const badBases = new Set([
    "USDT",
    "USDC",
    "DAI",
    "TUSD",
    "FDUSD",
    "EURT",
    "USD",
    "EUR",
    "USDE",
    "USDS",
    "PYUSD",
    "USDG",
    "XAUT",
    "BETH",
    "AUDF",
    "AUDM",
    "BRL1",
  ]);

  const tickerByInstId = new Map(
    (tickersJson.data ?? []).map((ticker) => [ticker.instId, ticker])
  );

  function quoteVolume24h(instId) {
    const ticker = tickerByInstId.get(instId);
    if (!ticker) return 0;

    const volCcy24h = Number.parseFloat(ticker.volCcy24h ?? "0");
    if (Number.isFinite(volCcy24h) && volCcy24h > 0) {
      return volCcy24h;
    }

    const last = Number.parseFloat(ticker.last ?? "0");
    const vol24h = Number.parseFloat(ticker.vol24h ?? "0");

    if (Number.isFinite(last) && Number.isFinite(vol24h)) {
      return last * vol24h;
    }

    return 0;
  }

  const symbols = (instrumentsJson.data ?? [])
    .filter((instrument) =>
      instrument.state === "live" &&
      instrument.quoteCcy === "USDT" &&
      instrument.baseCcy &&
      !badBases.has(instrument.baseCcy)
    )
    .map((instrument) => ({
      instId: instrument.instId,
      quoteVolume24h: quoteVolume24h(instrument.instId),
    }))
    .filter((item) => item.quoteVolume24h > 0)
    .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
    .map((item) => item.instId);

  if (maxSymbols > 0) {
    return symbols.slice(0, maxSymbols);
  }

  return symbols;
}
