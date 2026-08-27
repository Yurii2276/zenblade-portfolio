# Autonomous Orchestrator v1

This module turns the autonomous research components into one continuous, paper-only pipeline.

## Pipeline

Every short loop:

1. Check persistent storage.
2. Acquire a single-process lock.
3. Seed Brain memory only if the experiment store is empty.
4. Run autonomous paper trading from the current approved manifest.
5. On the research schedule, run:
   - Strategy Lab
   - chronological holdout evaluation
   - Walk-Forward Validator
   - Paper Promotion Gate
6. Persist cycle state and a structured NDJSON run journal.
7. Repeat.

Live trading is not part of this orchestrator. The orchestrator state, run records, paper manifest and paper engine all declare `liveTradingAllowed: false`.

## Research cadence

Defaults:

- autonomous loop: every 5 minutes
- Strategy Lab / Walk-Forward research: every 12 hours
- failed research retry: after 60 minutes
- process lock stale timeout: 180 minutes

Environment overrides:

- `AUTONOMOUS_LOOP_MINUTES`
- `AUTONOMOUS_RESEARCH_HOURS`
- `AUTONOMOUS_RESEARCH_RETRY_MINUTES`
- `AUTONOMOUS_LOCK_STALE_MINUTES`
- `AUTONOMOUS_RUN_ONCE=true`

## Continuous exploration

Strategy Lab no longer uses one permanent random seed. Unless `LAB_SEED` is explicitly provided, the default research seed changes by UTC date. This creates a new deterministic candidate batch each day while Brain retains previous experiments.

`LAB_SEED` can be set manually when exact reproducibility is needed.

## Persistent storage

All autonomous runtime files are rooted under `ZENBLADE_DATA_DIR`.

If Railway provides `RAILWAY_VOLUME_MOUNT_PATH`, ZenBlade automatically uses:

`<RAILWAY_VOLUME_MOUNT_PATH>/zenblade`

Important files include:

- `brain/experiments.ndjson`
- `brain/paper-approved.json`
- `brain/autonomous-paper-state.json`
- `brain/autonomous-paper-trades.json`
- `brain/orchestrator/state.json`
- `brain/orchestrator/runs.ndjson`
- `brain/orchestrator/orchestrator.lock`

On Railway, the orchestrator refuses to start if Railway is detected but no persistent Volume mount is present. This prevents Brain history from silently disappearing on a redeploy.

## Railway deployment

Before changing the Railway start command to the autonomous orchestrator:

1. Attach a Railway Volume to the service.
2. Use an absolute mount path such as `/data`.
3. Verify Railway exposes `RAILWAY_VOLUME_MOUNT_PATH` at runtime.
4. Then use the start command:

`npm run autonomous:loop`

The application will automatically store autonomous state under `/data/zenblade` when the volume mount is `/data`.

## Commands

Run one cycle locally:

`npm run autonomous:once`

Run continuously:

`npm run autonomous:loop`

Run tests:

`npm run test:autonomous`

## Safety model

The orchestrator does not contain exchange order submission logic. It coordinates research and the existing autonomous paper simulator only.

A future live-trading implementation must remain a separate manual gate and must not be enabled by changing an environment variable in this orchestrator.
