# Autonomous Walk-Forward Validator v1

Research-only validation stage after Strategy Lab chronological holdout.

Pipeline:

1. `npm run lab:run` generates and evaluates parameter candidates on a 70/30 chronological holdout.
2. Only holdout experiments with status `candidate` are selected for walk-forward validation.
3. `npm run lab:walk-forward` downloads a longer market history and evaluates each selected candidate across expanding chronological train/test windows.
4. Every walk-forward result is written to Brain memory as `strategy_lab_walk_forward` with status `validated`, `watch`, or `rejected`.
5. `validated` means eligible for a separate future paper-promotion gate. It does not activate paper or live trading.

Default walk-forward settings:

- candles: 3000
- folds: 4
- minimum initial train window: 600 candles
- minimum test window: 150 candles
- maximum candidates per run: 20

Optional environment variables:

- `WF_CANDLES`
- `WF_FOLDS`
- `WF_MIN_TRAIN`
- `WF_MIN_TEST`
- `WF_MAX_CANDIDATES`
- `WF_SYMBOLS` (comma-separated)
- `WF_STRATEGIES` (comma-separated)

The validator rejects insufficient samples, unstable profitability across folds, weak median profit factor, excessive drawdown, and catastrophic fold losses. Fees are included through the existing Strategy Lab backtest evaluator.
