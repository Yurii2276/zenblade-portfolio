export function calculateLongTrade({ balance, entryPrice, atr, config }) {
  const riskAmount = Math.round(balance * config.riskPerTrade * 10000) / 10000;

  const stopPrice = Math.round((entryPrice - atr * config.atrStopMultiplier) * 100) / 100;
  const takePrice = Math.round((entryPrice + atr * config.atrTakeMultiplier) * 100) / 100;

  const riskPerUnit = entryPrice - stopPrice;
  let size = Math.round((riskAmount / riskPerUnit) * 10000) / 10000;
  let positionValue = Math.round(size * entryPrice * 10000) / 10000;

  const maxPositionValue = Math.round(balance * config.maxPositionValuePct * 10000) / 10000;

  if (positionValue > maxPositionValue) {
    size = Math.round((maxPositionValue / entryPrice) * 10000) / 10000;
    positionValue = maxPositionValue;
  }

  return {
    entryPrice: Math.round(entryPrice * 100) / 100,
    stopPrice,
    takePrice,
    size,
    positionValue,
    riskAmount,
  };
}
