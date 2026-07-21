# ZenBlade Strategy Bank

Цей файл зберігає стратегії-кандидати для майбутнього multi-strategy portfolio bot.

Усі результати нижче — тільки research / paper mode. Це не дозвіл для реальної торгівлі.

## Основна ідея

Ми не шукаємо одну універсальну стратегію. Ми збираємо банк маленьких стратегій, кожна з яких працює тільки у своєму ринковому режимі.

Майбутня архітектура:

Strategy Bank -> Regime Detector -> Portfolio Manager -> Paper Trade

Portfolio Manager має:

- дозволяти максимум одну активну позицію;
- не відкривати кілька стратегій на один символ одночасно;
- вибирати найсильніший сигнал;
- не торгувати у downtrend або chop;
- вести статистику по кожній стратегії окремо.

---

## Candidate 1 — ETH Breakout Retest / Strong Trend Regime

Status: research candidate  
Symbol: ETH-USDT  
Strategy: breakoutRetest  
Best profile: aggressive  
Market regime: strong clean uptrend  
Real trading: no  
Paper live: not yet  

### Логіка

Стратегія шукає пробій рівня, повернення до рівня, утримання рівня і bullish confirmation після retest.

Найкраще працювала тоді, коли ETH був у чистому uptrend:

- EMA 30/100 spread позитивний;
- RSI ближче до 60;
- ATR% контрольований;
- ціна рухалась без сильної пилки.

### Найкращий full-period результат на ETH

Період дослідження: приблизно 5999 свічок по 5 хвилин, тобто близько 20.8 дня.

Параметри:

- profile: aggressive
- breakoutLookback: 30
- breakoutRecentLookback: 10
- breakoutBufferPct: 0.001
- retestTolerancePct: 0.0025 або 0.005

Результат:

- Trades: 11
- Net PnL: +4.11 USDT
- Profit Factor: 2.97
- Win Rate: 81.8%
- Max Drawdown: 1.26 USDT

### Window validation

- W1: 1 trade, -0.83 USDT
- W2: 3 trades, -0.39 USDT
- W3: 0 trades, 0
- W4: 7 trades, +5.34 USDT

Висновок: прибуток майже повністю прийшов із W4. Це означає, що стратегія має edge тільки у конкретному strong uptrend режимі.

### Regime filter test

Тимчасово перевірені фільтри:

- breakoutMinEmaSpreadPct: 0.2
- breakoutMaxAtrPct: 0.3
- breakoutMinRsi: 55

Результат короткого backtest:

- ETH aggressive: 4 trades, +2.65 USDT, Win Rate 100%, MaxDD 0
- SOL aggressive: 3 trades, +0.53 USDT, PF 1.45, MaxDD 1.18

Висновок: regime filter покращив якість і зменшив погані SOL-угоди, але зробив ETH breakout ще рідшим.

### Рішення

Не вмикати як active/default strategy.

Залишити як candidate у Strategy Bank.

Потрібен portfolio manager, який дозволяє breakoutRetest тільки у strong uptrend regime.

---

## Candidate 2 — ETH Trend Pullback / Soft Trend Regime

Status: research candidate  
Symbol: ETH-USDT  
Strategy: trendPullback  
Market regime: soft uptrend + pullback  
Real trading: no  
Paper live: not yet  

### Найкращий stability result

- Strategy: trendPullback
- Symbol: ETH-USDT
- EMA: 9/21
- RSI: 42-55 або 45-55
- Volume: 1-1.5
- ATR: 1.5/2.5
- Trades: 9
- Net PnL: +4.36 USDT
- Profit Factor: 4.79
- Positive windows: 3/4
- MaxDD: 1.15 USDT
- Candidate: false

### Висновок

Це цікавіше по stability, ніж breakoutRetest, бо має positive windows 3/4.

Але угод лише 9, тому ще не можна вмикати як готову paper portfolio strategy.

Залишити як research candidate.

---

## Paused / Rejected

### trendMomentum

Проблема: багато угод, але загальний результат переважно мінусовий.

Status: paused.

### SOL strategies

Проблема: SOL системно дає погані результати у більшості стратегій.

Status: paused.

### BTC breakoutRetest

Проблема: мало або нуль угод, edge не підтверджено.

Status: watch mode.

---

## Наступна задача

Зробити portfolio research для ETH:

- ETH breakoutRetest для strong trend;
- ETH trendPullback для soft trend;
- максимум одна позиція;
- окрема статистика по кожній стратегії;
- перевірка по 4 windows.

---

## Portfolio Research 1 — ETH Breakout + Pullback

Status: promising research portfolio  
Symbol: ETH-USDT  
Real trading: no  
Paper live: not yet  

### Portfolio logic

Портфель обʼєднує дві стратегії:

1. breakoutStrong — ETH breakoutRetest для strong trend regime;
2. pullbackSoft — ETH trendPullback для soft trend regime.

Правило:

- максимум одна активна позиція;
- breakoutStrong має пріоритет;
- якщо breakoutStrong не дає BUY, перевіряється pullbackSoft;
- якщо жодна стратегія не дає BUY, бот не торгує.

### Result on ~5999 ETH 5m candles

Breakout only:

- Trades: 5
- Net PnL: +1.38 USDT
- PF: 2.1
- Win Rate: 80%
- MaxDD: 1.26
- Positive windows: 1/4

Pullback only:

- Trades: 9
- Net PnL: +4.38 USDT
- PF: 4.81
- Win Rate: 88.9%
- MaxDD: 1.15
- Positive windows: 3/4

Portfolio:

- Trades: 14
- Net PnL: +5.78 USDT
- PF: 3.4
- Win Rate: 85.7%
- MaxDD: 1.26
- Positive windows: 3/4
- Candidate: false

### Висновок

Перший portfolio test підтвердив ідею multi-strategy підходу.

Портфель дав більше угод і більший прибуток, ніж кожна стратегія окремо, без суттєвого погіршення drawdown.

Причина Candidate false: лише 14 угод при мінімальному порозі 15.

Рішення: залишити як promising research portfolio, але ще не запускати в paper live. Наступний крок — перевірити на більшій історії.

---

## Candidate 3 — ETH Pullback Soft Filtered / Context Regime

Status: research candidate, not live-ready.

Best current research setup:
- Symbol: ETH-USDT
- Strategy: trendPullback
- Profile: custom pullback soft
- Main context filter:
  - minRet3dPct: 1.5
  - maxRet24hPct: 5

Research summary:
- 18k candles: 6 trades, +5.28 USDT, 100% win, MaxDD 0
- 12k candles: 6 trades, +5.28 USDT, 100% win, MaxDD 0
- 6k candles: 3 trades, +3.06 USDT, 100% win, MaxDD 0

Interpretation:
- The filter removed weak/choppy pullback entries.
- The strategy has high quality but too few trades.
- Not enough evidence for real trading.
- Suitable only for paper/research mode until more statistics are collected.

Decision:
- Use ETH pullbackSoftFiltered as the main research candidate.
- Keep breakoutStrong, breakoutStrict, and breakoutStrictFiltered paused.
- Do not add breakout strategies to active portfolio yet.

---

## Candidate — QORB Pump Reversal Sniper

Status: research candidate, paper only, not live-ready.

Role in ZenBlade Portfolio:
Satellite event-driven strategy for rare overheated altcoin pump reversals.

Core idea:
The strategy scans OKX USDT swap markets and looks for altcoins that made a strong pump. After the pump becomes older and starts losing strength, the bot tests paper short entries. The goal is to catch post-pump exhaustion, not to trade every day.

Current live paper result:
- Closed trades: 3
- Current balance: 980.741 USDT
- Realized PnL: -19.259 USDT
- Open positions: 0
- Mode: PAPER ONLY

Current assessment:
The strategy is technically working, but the trading edge is not proven yet. It has low frequency, high squeeze risk, and needs more signal/outcome data before it can be considered for live use.

Strengths:
- Can catch sharp reversals after speculative altcoin pumps.
- Works as a rare-event sniper strategy.
- Low correlation with ETH trend pullback logic.
- Useful as one module inside a broader strategy portfolio.

Weaknesses:
- Low number of trades.
- High risk of short squeeze after strong pumps.
- Current sample is too small.
- Entry logic needs better reversal confirmation.
- Position management should be improved.

Portfolio role:
This strategy should not be the main ZenBlade strategy. It should be a satellite module with low allocation and strict risk control.

Research limits:
- PAPER ONLY
- maxOpenPositions: 1
- low allocation
- no real trading
- collect at least 30–50 paper trades before any promotion

Next improvements:
1. Add signal logging for WAIT / WATCH / READY / READY_LATE candidates.
2. Add rejectReason for signals that are not opened.
3. Add outcome labeling after 6h / 12h / 24h / 72h.
4. Add better reversal confirmation before short entry.
5. Add faster open-position monitoring.

Decision:
Keep QORB Pump Reversal Sniper as a ZenBlade Portfolio research candidate, not as a standalone main bot.


---

## Candidate 4 — QORB Pump Reversal Short

Status: research framework added, not live-ready.

Source idea:
- Based on the separate QORB Pump Paper Bot.
- Railway QORB bot remains separate and untouched.
- ZenBlade version is research/backtest only.

Strategy type:
- SHORT reversal after pump.
- Not a long pump strategy.

Core idea:
- Detect coins that pumped strongly over 24h.
- Confirm abnormal volume spike.
- Wait for pump event maturity / exhaustion zone.
- Open paper SHORT after the pump, expecting a reversal or cooldown.

Main default filters:
- qorbPumpLookbackHours: 24
- qorbVolumeLookbackHours: 24
- qorbMinPumpWeak: 30
- qorbMinVolumeSpike: 3
- qorbMinVolumeUSDT: 300000
- qorbMinOpenScore: 70
- qorbTpPct: 15
- qorbSlPct: 10
- qorbMaxHoldHours: 72

Current research result:
- BTC-USDT, ETH-USDT, SOL-USDT: 0 trades on recent 1H candles.
- This is expected because large caps rarely produce +30% pump conditions.
- Next step: test QORB on a wider altcoin universe.

Decision:
- Keep QORB as Candidate 4.
- Do not enable real orders.
- Use only research / paper mode.

Research update — QORB selected profile:

Profile:
- QORB_PROFILE=selected
- Symbols: NEAR-USDT, ORDI-USDT, TIA-USDT
- QORB_CANDLES=3000
- qorbMinPumpWeak: 12
- qorbMinVolumeSpike: 1.3
- qorbMinOpenScore: 35
- qorbMinVolumeUSDT: 50000

Latest result:
- NEAR-USDT: 7 trades, +55.76 USDT, PF 1.8, win 57.1%, maxDD 42.87
- ORDI-USDT: 6 trades, +35.77 USDT, PF 1.76, win 50%, maxDD 46.83
- TIA-USDT: 6 trades, +17.35 USDT, PF 1.26, win 50%, maxDD 32.97

Combined selected profile:
- 19 trades
- +108.88 USDT
- Approx win rate: 52.6%

Decision:
- QORB selected profile is promising for research.
- Still not live-ready.
- Needs longer history, walk-forward checks, and portfolio-level drawdown control.

Research update — QORB watch profile:

Profile:
- QORB_PROFILE=watch
- QORB_CANDLES=3000
- Symbols: XPL-USDT, RE-USDT, BAT-USDT, AR-USDT, BICO-USDT, BREV-USDT
- qorbMinPumpWeak: 12
- qorbMinVolumeSpike: 1.3
- qorbMinOpenScore: 35
- qorbMinVolumeUSDT: 50000

Latest result:
- XPL-USDT: 7 trades, +68.35 USDT, PF 2.81, win 71.4%, maxDD 31.22
- RE-USDT: 4 trades, +39.62 USDT, PF 3.03, win 75%, maxDD 19.49
- BAT-USDT: 5 trades, +62.57 USDT, PF 2.63, win 60%, maxDD 38.37
- AR-USDT: 5 trades, +51.37 USDT, PF 2.75, win 80%, maxDD 29.29
- BICO-USDT: 5 trades, +30.08 USDT, PF 5, win 60%, maxDD 6.44
- BREV-USDT: 5 trades, +19.63 USDT, PF 1.77, win 40%, maxDD 14.27

Combined watch profile:
- 31 trades
- +271.62 USDT
- All tested watch symbols finished positive
- Candidate true: XPL, BAT, AR, BICO, BREV
- RE remains watch-only because it has 4 trades, below the 5-trade candidate threshold

Decision:
- QORB watch profile is stronger than the first selected profile.
- Still not live-ready.
- Next step: test combined selected + watch basket and add portfolio-level drawdown controls.

Research update — QORB basket profile:

Profile:
- QORB_PROFILE=basket
- QORB_CANDLES=3000
- Symbols: NEAR-USDT, ORDI-USDT, TIA-USDT, XPL-USDT, RE-USDT, BAT-USDT, AR-USDT, BICO-USDT, BREV-USDT
- qorbMinPumpWeak: 12
- qorbMinVolumeSpike: 1.3
- qorbMinOpenScore: 35
- qorbMinVolumeUSDT: 50000

Latest result:
- NEAR-USDT: 7 trades, +55.76 USDT, PF 1.8, win 57.1%, maxDD 42.87
- ORDI-USDT: 6 trades, +35.77 USDT, PF 1.76, win 50%, maxDD 46.83
- TIA-USDT: 6 trades, +17.35 USDT, PF 1.26, win 50%, maxDD 32.97
- XPL-USDT: 7 trades, +68.35 USDT, PF 2.81, win 71.4%, maxDD 31.22
- RE-USDT: 4 trades, +39.62 USDT, PF 3.03, win 75%, maxDD 19.49
- BAT-USDT: 5 trades, +62.57 USDT, PF 2.63, win 60%, maxDD 38.37
- AR-USDT: 5 trades, +51.37 USDT, PF 2.75, win 80%, maxDD 29.29
- BICO-USDT: 5 trades, +30.08 USDT, PF 5, win 60%, maxDD 6.44
- BREV-USDT: 5 trades, +19.63 USDT, PF 1.77, win 40%, maxDD 14.27

Combined basket:
- 50 trades
- +380.50 USDT
- 8 of 9 symbols are candidate true
- RE remains watch-only because it has 4 trades, below the 5-trade candidate threshold
- No tested basket symbol finished negative

Decision:
- QORB basket is the strongest QORB research profile so far.
- Still research / paper only.
- Not live-ready yet because portfolio-level drawdown control and walk-forward validation are still missing.

---

## Research memory rule — added 2026-07-13

Before creating a new strategy or modifying an existing one, ZenBlade research memory must be reviewed first.

Required files to check:
- docs/research-journal.md
- research/memory/*.json
- reports/*.json
- reports/*.csv

Rule:
- No strategy filter should be relaxed blindly.
- No strategy should be added to the live paper loop before research/backtest.
- Every major research result must update the relevant memory JSON.

---

## Candidate 4 — ZenBlade Gold Index Strategy

Status: research completed, no standalone candidate yet.  
Mode: research only.  
Real trading: no.  
Paper live: no.

### Idea

Gold Index перевіряє macro/context гіпотезу:

- якщо gold proxy росте;
- crypto може мати risk-on вікно;
- перевіряємо BTC-USDT, ETH-USDT, SOL-USDT після сильних рухів XAUT-USDT або PAXG-USDT.

### Phase 1 — data source audit

Result:
- XAUT-USDT доступний як OKX gold proxy.
- PAXG-USDT доступний, але має коротшу історію.
- DXY source у repo поки відсутній.

Best marginal row:
- XAUT-USDT -> BTC-USDT.
- Threshold: gold 2D change >= 0.7%.
- Baseline average 2D forward return: -0.07%.
- Signal average 2D forward return: -0.03%.
- Hit rate: 52.8%.

Interpretation:
- Дані є, але edge дуже слабкий.

### Phase 2 — threshold sweep

Tested thresholds:
- 0.7%;
- 1.0%;
- 1.5%;
- 2.0%.

Best observed rows:
- XAUT-USDT -> ETH-USDT, threshold 1.5%:
  - signal average 2D return: 0.22%;
  - edge: 0.17%;
  - hit rate: 51.5%;
  - average MAE: -3.96%;
  - candidate: false.

- XAUT-USDT -> BTC-USDT, threshold 1.0%:
  - signal average 2D return: 0.07%;
  - edge: 0.14%;
  - hit rate: 52.9%;
  - average MAE: -2.60%;
  - candidate: false.

### Decision

Gold-only Index is not strong enough as a standalone paper strategy.

Blocked:
- Do not add Gold Index to Railway paper loop.
- Do not enable BTC/ETH/SOL paper entries from gold-only signal.
- Do not treat XAUT/PAXG-only movement as validated edge.

Next possible research:
- Add or choose DXY data source.
- Test combined macro condition:
  - DXY down over 2 days;
  - XAUT up over 2 days.
- Only if DXY + XAUT combination shows stronger edge, consider a future paper candidate.


---

### Research correction — QORB holdout failure, 2026-07-21

The earlier positive QORB basket and parameter-sweep findings are not sufficient for deployment.

After correcting short TIME_EXIT accounting, the recent score>=35 candidate remained strong on the recent window but failed an older chronological holdout:

- Older holdout trades: 18.
- Win rate: 38.9%.
- Estimated net: -8.96 percentage points.
- Estimated profit factor: 0.86.
- Maximum drawdown: 46.37 percentage points.

WATCH added no unique pump events; all eligible WATCH observations belonged to events already represented by READY.

Updated decision:
- QORB remains a research-only, rare event-driven strategy.
- Do not deploy QORB v2.
- Do not enable WATCH, WAIT or EXPIRED.
- Do not lower the current production threshold.
- Previous positive profile results are retained as historical research, but they are superseded for deployment decisions by the failed chronological holdout.
