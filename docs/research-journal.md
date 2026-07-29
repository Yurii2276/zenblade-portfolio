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

---

## 2026-07-13 — Gold Index Phase 1: data source audit

Command:
- npm run research:gold-index

Scope:
- Research only.
- No Railway paper-loop changes.
- No live trading.
- No real orders.
- No private API keys.

Data checked:
- Crypto symbols: BTC-USDT, ETH-USDT, SOL-USDT.
- Gold proxy candidates: XAUT-USDT, PAXG-USDT.
- Bar: 1D.
- Target candles: 500.
- Gold signal condition: 2D gold proxy change >= 0.7%.

Source result:
- BTC-USDT: 499 daily candles.
- ETH-USDT: 499 daily candles.
- SOL-USDT: 499 daily candles.
- XAUT-USDT: 499 daily candles.
- PAXG-USDT: 271 daily candles.
- DXY source is not implemented in the repo.

Best observed result:
- XAUT-USDT -> BTC-USDT.
- Aligned days: 497.
- Signal days: 163.
- Baseline average 2D forward return: -0.07%.
- Signal average 2D forward return: -0.03%.
- Signal hit rate 2D: 52.8%.

Interpretation:
- XAUT-USDT is usable as an OKX gold proxy for research.
- The best result is only marginal.
- Gold-only signal does not clearly confirm a tradeable edge.
- ETH and SOL are not confirmed by this test.
- PAXG results are weaker and have shorter history.

Decision:
- Do not add Gold Index to Railway paper loop.
- Do not enable Gold Index paper entries.
- Continue only as research.
- Next step is to define whether Gold Index should be BTC-only macro context, or whether DXY must be added before further testing.

Blocked change:
- No paper-loop integration until stronger backtest evidence exists.

---

## 2026-07-13 — Gold Index Phase 2: threshold sweep

Command:
- npm run research:gold-index-sweep

Scope:
- Research only.
- No Railway paper-loop changes.
- No live trading.
- No real orders.
- No private API keys.

Data:
- Crypto symbols: BTC-USDT, ETH-USDT, SOL-USDT.
- Gold proxy candidates: XAUT-USDT, PAXG-USDT.
- Bar: 1D.
- Target candles: 500.
- Thresholds tested: 0.7%, 1.0%, 1.5%, 2.0% 2D gold-proxy change.
- Forward windows tested: 1D, 2D, 3D, 5D.
- Added adverse/favorable move checks after signal.

Best observed rows:
- XAUT-USDT -> ETH-USDT, threshold 1.5%:
  - Signals: 97 / 497.
  - Baseline average 2D forward return: 0.05%.
  - Signal average 2D forward return: 0.22%.
  - Edge: 0.17%.
  - Hit rate 2D: 51.5%.
  - Average MAE 2D: -3.96%.
  - Candidate: false.

- XAUT-USDT -> BTC-USDT, threshold 1.0%:
  - Signals: 136 / 497.
  - Baseline average 2D forward return: -0.07%.
  - Signal average 2D forward return: 0.07%.
  - Edge: 0.14%.
  - Hit rate 2D: 52.9%.
  - Average MAE 2D: -2.60%.
  - Candidate: false.

Negative findings:
- XAUT 2.0% threshold worsened BTC, ETH, and SOL results.
- PAXG results were consistently weaker than XAUT.
- SOL had high adverse movement after signals.
- No tested threshold produced a validated candidate.

Decision:
- Gold-only Index is not strong enough as a standalone strategy.
- Do not add Gold Index to Railway paper loop.
- Do not enable BTC, ETH, or SOL Gold Index paper entries.
- Keep Gold Index as research only.

Next:
- Test combined macro logic only after choosing a DXY data source.
- Best next hypothesis: DXY down + XAUT up over 2 days.
- Until then, Gold Index remains a macro-context research idea, not a paper strategy.

---

## 2026-07-14 — Macro Gold + DXY Phase 3

Command:
- npm run research:macro-gold-dxy-index

Scope:
- Research only.
- No Railway paper-loop changes.
- No live trading.
- No real orders.
- No private API keys.

Data sources:
- OKX crypto candles: BTC-USDT, ETH-USDT, SOL-USDT.
- OKX gold proxies: XAUT-USDT, PAXG-USDT.
- Yahoo macro data:
  - DXY: DX-Y.NYB.
  - SPX: ^GSPC.
  - NASDAQ: ^IXIC.
  - VIX: ^VIX.
  - Gold futures: GC=F.

Data quality issue:
- Yahoo DXY returned zero-close placeholder candles.
- These records created fake -100% 2D DXY changes.
- The script was fixed to ignore Yahoo candles with close <= 0.
- The script also filters abnormal macro 2D changes with abs(change) > 5%.

Cleaned result:
- DXY changes became realistic, around -0.72% to -0.73% for the best XAUT scenarios.

Best current candidate:
- Scenario: dxy_down_gold_up_strict.
- Gold proxy: XAUT-USDT.
- Crypto: ETH-USDT.
- Signals: 43.
- Baseline average 2D forward return: 0.03%.
- Signal average 2D forward return: 1.56%.
- Edge: 1.53%.
- Hit rate 2D: 65.1%.
- Average MAE 2D: -3.09%.
- Candidate: true.

Second candidate:
- Scenario: dxy_down_gold_up_strict.
- Gold proxy: XAUT-USDT.
- Crypto: BTC-USDT.
- Signals: 43.
- Baseline average 2D forward return: -0.09%.
- Signal average 2D forward return: 0.88%.
- Edge: 0.97%.
- Hit rate 2D: 60.5%.
- Average MAE 2D: -1.88%.
- Candidate: true.

Interpretation:
- Gold-only signal was weak.
- Macro combination DXY down + XAUT up is meaningfully stronger.
- XAUT is better than PAXG.
- ETH has the strongest return edge.
- BTC has lower adverse movement.
- SOL is promising but riskier.

Decision:
- Mark Macro Gold + DXY as promising research candidate.
- Do not add to Railway paper loop yet.
- Next required step is walk-forward/window validation.

Blocked:
- No paper-loop integration until Phase 4 validation.
- No live trading.
- No real orders.

---

## 2026-07-14 — Macro Gold + DXY Phase 4 Walk-Forward Validation

Command:
- npm run research:macro-gold-dxy-walk-forward

Scope:
- Research only.
- No Railway paper-loop changes.
- No live trading.
- No real orders.
- No private API keys.

Scenario tested:
- DXY 2D change <= -0.3%.
- XAUT 2D change >= +1.0%.
- Hold windows checked: 1D, 2D, 3D, 5D.
- Main decision metric: 2D forward return.
- Validation windows: 5.

Summary:
- BTC-USDT, ETH-USDT, and SOL-USDT all returned candidate=true.
- However, stability differs by asset.

BTC-USDT:
- Signals: 45.
- Baseline average 2D return: -0.09%.
- Signal average 2D return: 1.05%.
- Edge 2D: 1.14%.
- Hit rate 2D: 62.2%.
- Average MAE 2D: -1.82%.
- Positive edge windows: 4/5.
- Interpretation: most stable first paper candidate.

ETH-USDT:
- Signals: 45.
- Baseline average 2D return: 0.03%.
- Signal average 2D return: 1.75%.
- Edge 2D: 1.72%.
- Hit rate 2D: 66.7%.
- Average MAE 2D: -3.02%.
- Positive edge windows: 3/5.
- Interpretation: strongest edge but higher regime risk than BTC.

SOL-USDT:
- Signals: 45.
- Baseline average 2D return: -0.15%.
- Signal average 2D return: 1.75%.
- Edge 2D: 1.90%.
- Hit rate 2D: 60.0%.
- Average MAE 2D: -3.52%.
- Positive edge windows: 3/5.
- Interpretation: promising but too volatile for first paper candidate.

Important caution:
- Window 4, from 2025-12-23 to 2026-03-31, was negative for all tested assets.
- BTC was the most stable across windows.
- ETH had the strongest total edge but a weaker bad-regime profile.
- SOL should remain research-only for now.

Decision:
- Mark Macro Gold + DXY as walk-forward promising.
- Do not add to Railway paper loop yet.
- Next phase should be a paper-only strategy module with dry-run tests.
- Preferred first candidate: BTC-USDT conservative.
- Optional second candidate: ETH-USDT aggressive.
- Do not enable SOL first.

Blocked:
- No live trading.
- No real orders.
- No Railway paper-loop integration.
- No SOL paper candidate until additional risk filters are tested.

---

## 2026-07-14 — Macro Gold + DXY Phase 5 Paper-Only Dry-Run Module

Command:
- npm run paper:macro-gold-dxy-dry-run

Scope:
- Paper/dry-run module only.
- Not integrated into Railway.
- Not integrated into the main paper strategy loop.
- No live trading.
- No real orders.
- No private API keys.

New module:
- src/paper/macroGoldDxyPaperModule.js

New npm script:
- paper:macro-gold-dxy-dry-run

Signal rules:
- DXY 2D change <= -0.3%.
- XAUT 2D change >= +1.0%.
- Planned hold: 48 hours.
- Signal TTL: 48 hours.

Candidates:
- BTC-USDT: conservative first candidate.
- ETH-USDT: aggressive second candidate.
- SOL-USDT: intentionally disabled for first module.

Real current signal test:
- Action: SKIP.
- DXY 2D was about +0.11%, so DXY was not down enough.
- XAUT 2D was about -2.13%, so XAUT was not up enough.
- BTC-USDT and ETH-USDT were both skipped.

Forced relaxed-threshold test:
- Command used relaxed test thresholds only for dry-run:
  - MACRO_GOLD_DXY_DXY_MAX_2D_PCT=1
  - MACRO_GOLD_DXY_XAUT_MIN_2D_PCT=-3
- Result:
  - DRY_RUN_BUY for BTC-USDT.
  - DRY_RUN_BUY for ETH-USDT.
- State/trades were not saved.
- No macro-gold-dxy state files were created.

Safety result:
- Dry-run branch works.
- SKIP branch works.
- BUY branch works only as DRY_RUN_BUY by default.
- No state persistence in dry-run mode.
- Main paper loop was not changed.
- Railway was not changed.

Decision:
- Keep module as dry-run only.
- Do not enable in Railway.
- Do not integrate into main paper loop yet.
- Next step: add focused tests for duplicate-position protection, signal TTL, and paper persistence before any loop integration.

---

## 2026-07-14 — Macro Gold + DXY Phase 6 Paper Module Tests

Command:
- npm run test:macro-gold-dxy-paper

Scope:
- Local paper persistence test only.
- No Railway changes.
- No live trading.
- No real orders.
- No private API keys.
- Main paper-loop was not touched.

Changes tested:
- Added env overrides for Macro Gold DXY state/trades paths:
  - MACRO_GOLD_DXY_STATE_PATH
  - MACRO_GOLD_DXY_TRADES_PATH
- Added focused test script:
  - src/paper/testMacroGoldDxyPaperModule.js
- Added npm script:
  - test:macro-gold-dxy-paper

Test setup:
- MACRO_GOLD_DXY_DRY_RUN=false was used only with isolated test files.
- Test state file:
  - data/test-macro-gold-dxy-paper-state.json
- Test trades file:
  - data/test-macro-gold-dxy-paper-trades.json
- Forced relaxed thresholds were used only for testing the BUY branch.
- Test symbols:
  - BTC-USDT only.

Test flow:
1. Run 1:
   - Expected: open one BTC-USDT paper position.
   - Result: passed.

2. Run 2:
   - Expected: skip duplicate entry because BTC-USDT position is already OPEN.
   - Result: passed.

3. Run 3:
   - Position openedAt was manually aged by 49 hours.
   - Expected: close old position by MAX_HOLD_48H.
   - Expected: block immediate re-entry because signal TTL is still active.
   - Result: passed.

Result:
- Paper persistence works in isolated test files.
- Duplicate open-position protection works.
- MAX_HOLD_48H close path works.
- Signal TTL blocks immediate re-entry.
- Test state/trades files were cleaned after test.
- Main paper-loop was not touched.
- Railway was not touched.

Decision:
- Mark Phase 6 as passed.
- Macro Gold DXY module remains not integrated into Railway.
- Macro Gold DXY module remains not integrated into the main paper strategy loop.
- Next step: prepare disabled-by-default integration plan.

---

## 2026-07-14 — Macro Gold + DXY Phase 7 Disabled Integration Flag

Command:
- npm run test:macro-gold-dxy-integration

Scope:
- Disabled-by-default integration only.
- No Railway changes.
- No live trading.
- No real orders.
- No private API keys.

Changes:
- Added Macro Gold DXY integration helper to:
  - src/paper/strategyPortfolioBot.js
- Added explicit integration flag:
  - ENABLE_MACRO_GOLD_DXY
- Default behavior:
  - ENABLE_MACRO_GOLD_DXY is not true, so Macro Gold DXY remains disabled.
- Added focused integration flag test:
  - src/paper/testMacroGoldDxyIntegrationFlag.js
- Added npm script:
  - test:macro-gold-dxy-integration

Test flow:
1. ENABLE_MACRO_GOLD_DXY=false:
   - Expected: Macro Gold DXY integration does not run.
   - Result: passed.

2. ENABLE_MACRO_GOLD_DXY=true with MACRO_GOLD_DXY_DRY_RUN=true:
   - Expected: Macro Gold DXY separate module runs.
   - Expected: dry-run does not create state/trades files.
   - Result: passed.

Observed current macro signal:
- Macro Gold DXY module returned SKIP.
- DXY was not down enough.
- XAUT was not up enough.

Safety result:
- Integration is disabled by default.
- Explicit ENABLE_MACRO_GOLD_DXY=true is required.
- Dry-run integration did not create macro state/trades files.
- Railway was not touched.
- No live trading.
- No real orders.

Manual smoke note:
- npm run paper:strategies was started but interrupted before reaching the final Macro Gold DXY disabled log.
- The dedicated test:macro-gold-dxy-integration script is the validation for this phase.

Decision:
- Mark Phase 7 integration flag test as passed.
- Macro Gold DXY remains not enabled in Railway.
- Macro Gold DXY remains dry-run/paper only.
- Do not use MACRO_GOLD_DXY_DRY_RUN=false in Railway.


---

## 2026-07-21 — QORB corrected audit and chronological holdout

Scope:
- Research and paper only.
- No real orders.
- Railway trading parameters were not changed.

Corrections:
- Fixed QORB short TIME_EXIT return to use entry price as the denominator.
- Added explicit STRICT_LABEL and ANY_LABEL sweep modes.
- Added per-symbol concentration statistics.
- WATCH added zero unique pump events because every eligible WATCH record followed an event already represented by READY.

Corrected recent-window result:
- Baseline: READY/READY_LATE, score >= 35, changeSinceEvent -20..5.
- Selected events: 31.
- All selected events were READY.
- Win rate: 77.4%.
- Average gross: 6.21%.
- Symbols: 9.
- Maximum single-symbol share: 22.6%.

Chronological holdout:
- Cutoff: 2026-05-22T06:00:00.000Z.
- Older holdout trades: 18.
- Win rate after estimated costs: 38.9%.
- Estimated net: -8.96 percentage points.
- Estimated profit factor: 0.86.
- Maximum drawdown: 46.37 percentage points.
- Result: failed.

Decision:
- Reject QORB v2 deployment.
- Do not lower the production score threshold.
- Do not enable WATCH, WAIT or EXPIRED.
- Keep current Railway QORB parameters unchanged.
- Revisit only with regime filtering, rolling walk-forward validation and a chronological portfolio simulation.


---

## 2026-07-21 — Session ORB VWAP v2 robustness failure

Scope:
- Research and paper only.
- No real orders.
- Railway and the active paper loop were not modified.

Leading frozen scenario:
- Scenario: eth_btc_reclaim_quality.
- Bar: 5m.
- Candles per symbol: 17999.
- Trades: 25.
- Gross PnL: +10.68 USDT.
- Fees: 8.75 USDT.
- Net PnL: +1.93 USDT.
- Profit factor: 1.21.
- Maximum drawdown: 3.75 USDT.

Robustness findings:
- Chronological windows positive: 2 of 3.
- Middle window net PnL: -3.75 USDT.
- Middle window profit factor: 0.
- Result at fee rate 0.0010: -0.32 USDT.
- ETH contribution: +3.80 USDT.
- BTC contribution: -1.87 USDT.
- Session-end exits: 15 trades, net -6.83 USDT.
- No tested scenario passed the frozen-parameter robustness gate.

Decision:
- Reject Session ORB VWAP v2 deployment.
- Do not integrate it into Railway or the paper loop.
- Do not remove BTC post-hoc and claim an ETH-only success.
- Do not optimize session-end exits or trading hours on the same sample.
- Archive the research and select a structurally different intraday hypothesis.

---

## 2026-07-29 — Cross-Asset Relative Strength 15m

Command:
- CROSS_RS_CANDLES=12000 npm run research:cross-rs-15m

Scope:
- Research only.
- Symbols: BTC-USDT, ETH-USDT, SOL-USDT.
- Bar: 15m.
- Relative-strength lookbacks: 4h, 12h, 24h.
- Forward horizons: 1h, 4h, 8h, 12h.
- Cost assumption: 0.20% per leg, 0.40% for the pair.
- No Railway integration.
- No real orders.

Data:
- Requested candles per symbol: 12000.
- Aligned candles: 11999.
- Period: 2026-03-26 to 2026-07-29.

Results:
- 1h: 2975 observations, pair net -0.3960%, median -0.3943%, hit rate 6.55%.
- 4h: 743 observations, pair net -0.3831%, median -0.4013%, hit rate 20.05%.
- 8h: 371 observations, pair net -0.3404%, median -0.4016%, hit rate 28.30%.
- 12h: 247 observations, pair net -0.2817%, median -0.3325%, hit rate 34.41%.

Gross spread before assumed pair cost:
- 1h: +0.0040%.
- 4h: +0.0169%.
- 8h: +0.0596%.
- 12h: +0.1183%.

Interpretation:
- Relative strength contains a weak gross momentum effect.
- The effect is substantially smaller than realistic two-leg costs.
- Longer horizons reduce the loss but do not create a tradeable edge.
- No horizon passed the cost, median, hit-rate or approximate t-stat gate.

Decision:
- Status: failed_cost_gate_do_not_integrate.
- Do not add to Railway.
- Do not add to the paper portfolio.
- Do not lower the cost assumption or tune regimes on the same dataset.
- Archive the current formulation and move to a structurally different hypothesis.
