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
