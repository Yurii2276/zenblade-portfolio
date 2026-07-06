/**
 * Side-aware trade accounting helpers for research/backtest scripts.
 * Does not affect live paper trading or real orders.
 */

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Close a research trade for either LONG or SHORT position.
 *
 * LONG  pnl = (closePrice - entryPrice) * size
 * SHORT pnl = (entryPrice - closePrice) * size
 * fees       = (entryPrice + closePrice) * size * feeRate
 *
 * @param {object} params
 * @param {object} params.position  - must have entryPrice, size, side ("LONG"|"SHORT")
 * @param {number} params.closePrice
 * @param {string} params.closeReason
 * @param {number} params.balance
 * @param {number} params.feeRate
 * @returns {{ balance: number, trade: object }}
 */
export function closeResearchTrade({
  position,
  closePrice,
  closeReason,
  balance,
  feeRate,
}) {
  const { entryPrice, size, side = "LONG" } = position;

  const grossPnl =
    side === "SHORT"
      ? round((entryPrice - closePrice) * size)
      : round((closePrice - entryPrice) * size);

  const fees = round((entryPrice + closePrice) * size * feeRate);
  const netPnl = round(grossPnl - fees);
  const nextBalance = round(balance + netPnl);

  return {
    balance: nextBalance,
    trade: {
      side,
      entryTime: position.entryTime,
      closeTime: position.closeTime,
      entryPrice,
      closePrice,
      closeReason,
      size,
      grossPnl,
      fees,
      netPnl,
    },
  };
}
