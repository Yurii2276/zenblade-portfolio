# Autonomous Paper Promotion v1

This stage connects validated research to controlled paper trading. It does not enable live trading.

## Pipeline

`Strategy Lab -> chronological holdout -> walk-forward -> Paper Promotion Gate -> autonomous paper engine`

Only experiments with `experimentType=strategy_lab_walk_forward` and `status=validated` are eligible for the gate.

## Additional promotion requirements

Default gate policy requires:

- walk-forward score >= 45;
- >= 30 walk-forward trades;
- >= 75% profitable folds;
- median Profit Factor >= 1.20;
- total walk-forward return >= 1%;
- maximum walk-forward drawdown <= 10%;
- worst fold return >= -3%.

A maximum of five candidates can be approved at once.

## Hard paper risk policy

The generated approval manifest forces:

- maximum risk per trade: 0.25% of current paper balance;
- maximum position value: 10% of current paper balance;
- maximum one open position per candidate;
- maximum three total open positions;
- pause new entries after 1% daily loss;
- pause new entries after 5% paper drawdown.

The autonomous paper engine caps risk at these values even if a strategy or manifest attempts to request more.

## Live safety boundary

Every manifest, approval and state explicitly carries `liveTradingAllowed: false`. The autonomous paper engine contains market-data reads and simulated execution only; it has no exchange order submission code.

The paper graduation policy currently requires at least 50 closed paper trades and at least 21 days of observation. Meeting these numbers does not activate live trading. A future live gate must be separate and must require manual approval.

## Commands

```bash
npm run lab:promote-paper
npm run paper:auto
npm run paper:auto-loop
npm run test:auto-paper
```

`lab:promote-paper` reads Brain memory and writes `data/brain/paper-approved.json`.

`paper:auto` executes one paper cycle.

`paper:auto-loop` runs the paper cycle repeatedly (default every 5 minutes, minimum one minute). Configure with `AUTO_PAPER_INTERVAL_MS`.

## Persistence

For long-running deployment, `data/brain` must be on persistent storage. Otherwise Brain experiments, approval manifests, paper state and paper trades will be lost when the runtime filesystem is recreated.
