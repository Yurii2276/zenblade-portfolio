export function getSignal({ candles }) {
  if (!candles || candles.length < 20) {
    return {
      action: "HOLD",
      reason: "Недостатньо свічок",
    };
  }

  return {
    action: "HOLD",
    reason: "Дані отримано, стратегія ще не активна",
  };
}
