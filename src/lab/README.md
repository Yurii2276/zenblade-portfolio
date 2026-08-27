# Strategy Lab

Research-only autonomous strategy evaluation layer.

- `strategyLab.js` generates parameter candidates and performs initial chronological holdout testing.
- `walkForwardLab.js` selects only holdout candidates and validates them across multiple expanding chronological windows.
- Neither stage places real orders or automatically promotes a strategy to paper trading.
