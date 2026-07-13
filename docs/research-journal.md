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

## 2026-07-13 — QORB missed-opportunities audit

Command:
- QORB_PROFILE=basket QORB_CANDLES=1500 npm run research:qorb-missed

Result:
- Total audit records: 161.
- READY: 32 records, 75% simulated win rate, avgGross 6.12%.
- READY_LATE: 32 records, 65.6% simulated win rate, avgGross 5.02%.
- WATCH: 35 records, 62.9% simulated win rate, avgGross 3.66%.
- WAIT: 35 records, 65.7% simulated win rate, avgGross 4.25%.
- EXPIRED: 27 records, 40.7% simulated win rate, avgGross -0.45%.

Decision:
- Do not enable EXPIRED entries.
- Main opportunity is probably not EXPIRED Scout.
- Next research should be parameter sweep for READY / READY_LATE:
  - minOpenScore 35, 33, 30, 28;
  - changeSinceEvent lower bound -20, -25, -30;
  - compare whether WATCH or WAIT can be safely included.

Blocked change:
- Do not add QORB v2 to paper loop until parameter sweep confirms better settings.

## 2026-07-13 — QORB parameter sweep

Command sequence:
- QORB_PROFILE=basket QORB_CANDLES=1500 npm run research:qorb-missed
- npm run research:qorb-sweep

Best result:
- Config: strict_score35_change-20.
- Statuses: READY + READY_LATE.
- Score: >= 35.
- changeSinceEvent: -20..5.
- Trades: 30.
- Simulated win rate: 80%.
- TP / SL: 13 / 6.
- Average gross: 6.94%.
- Average 24h bounce: 4.99%.

Decision:
- Do not relax QORB filters now.
- Do not enable EXPIRED.
- Do not add WATCH or WAIT to live paper logic now.
- Keep current strict QORB logic in paper mode.

Interpretation:
- The problem is not that QORB is too strict.
- QORB is a rare strategy and needs a fresh READY / READY_LATE window.
- Next step is observation, not QORB v2.
