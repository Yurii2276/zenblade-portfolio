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
