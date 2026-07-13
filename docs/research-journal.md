# ZenBlade Research Journal

This journal records decisions, failed ideas, research conclusions, and next tests.

## 2026-07-13 — Paper infrastructure stabilized

Result:
- Railway paper loop works.
- Telegram start/status notifications work.
- Paper balance and trade history are preserved via Railway volume.
- WAIT log spam was hidden behind PAPER_LOG_WAIT=true.
- Current balance: 998.96 USDT.
- Closed trades: 2.
- Open positions: 0.

Decision:
- Infrastructure is stable enough.
- Do not make more infra changes unless logs show a real issue.

## 2026-07-13 — ETH Pullback Context

Observation:
- ETH Pullback Context has 2 closed trades.
- Current total contribution: -1.04 USDT.
- Sample size is too small.

Decision:
- Keep active until at least 5–10 closed trades.
- Do not judge strategy from only 2 trades.

## 2026-07-13 — QORB Pump Reversal Basket

Observation:
- Strategy is active but did not open recent paper trades.
- Logs showed many HOLD reasons: status EXPIRED.
- The issue is not Railway or Telegram.
- The issue is strategy timing / filters.

Decision:
- Do not simply allow all EXPIRED signals.
- First run missed-opportunities audit:
  - Check what happened after EXPIRED signals.
  - Measure price after 1h / 3h / 6h / 12h / 24h.
  - Check hypothetical TP/SL.
  - Decide whether EXPIRED_BUT_REVERSING / Scout mode is justified.

Blocked change:
- Do not relax QORB status filter without historical evidence.

Next:
- Build QORB missed-opportunities report.
