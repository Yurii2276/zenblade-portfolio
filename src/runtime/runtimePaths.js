import path from "node:path";

if (!process.env.ZENBLADE_DATA_DIR && process.env.RAILWAY_VOLUME_MOUNT_PATH) {
  process.env.ZENBLADE_DATA_DIR = path.join(
    process.env.RAILWAY_VOLUME_MOUNT_PATH,
    "zenblade"
  );
}

function resolvePath(value, fallback) {
  return path.resolve(value || fallback);
}

function defaultDataDir() {
  if (process.env.ZENBLADE_DATA_DIR) {
    return process.env.ZENBLADE_DATA_DIR;
  }
  return "data";
}

export const DATA_DIR = resolvePath(defaultDataDir(), "data");

export const BRAIN_DIR = resolvePath(
  process.env.BRAIN_DATA_DIR,
  path.join(DATA_DIR, "brain")
);

export const EXPERIMENTS_FILE = resolvePath(
  process.env.BRAIN_EXPERIMENTS_FILE,
  path.join(BRAIN_DIR, "experiments.ndjson")
);

export const PAPER_MANIFEST_FILE = resolvePath(
  process.env.PAPER_APPROVED_MANIFEST,
  path.join(BRAIN_DIR, "paper-approved.json")
);

export const AUTONOMOUS_PAPER_STATE_FILE = resolvePath(
  process.env.AUTONOMOUS_PAPER_STATE,
  path.join(BRAIN_DIR, "autonomous-paper-state.json")
);

export const AUTONOMOUS_PAPER_TRADES_FILE = resolvePath(
  process.env.AUTONOMOUS_PAPER_TRADES,
  path.join(BRAIN_DIR, "autonomous-paper-trades.json")
);

export const ORCHESTRATOR_DIR = resolvePath(
  process.env.AUTONOMOUS_ORCHESTRATOR_DIR,
  path.join(BRAIN_DIR, "orchestrator")
);

export const ORCHESTRATOR_STATE_FILE = resolvePath(
  process.env.AUTONOMOUS_ORCHESTRATOR_STATE,
  path.join(ORCHESTRATOR_DIR, "state.json")
);

export const ORCHESTRATOR_RUNS_FILE = resolvePath(
  process.env.AUTONOMOUS_ORCHESTRATOR_RUNS,
  path.join(ORCHESTRATOR_DIR, "runs.ndjson")
);

export const ORCHESTRATOR_LOCK_FILE = resolvePath(
  process.env.AUTONOMOUS_ORCHESTRATOR_LOCK,
  path.join(ORCHESTRATOR_DIR, "orchestrator.lock")
);

export function runtimePathSummary() {
  return {
    dataDir: DATA_DIR,
    brainDir: BRAIN_DIR,
    experimentsFile: EXPERIMENTS_FILE,
    paperManifestFile: PAPER_MANIFEST_FILE,
    autonomousPaperStateFile: AUTONOMOUS_PAPER_STATE_FILE,
    autonomousPaperTradesFile: AUTONOMOUS_PAPER_TRADES_FILE,
    orchestratorStateFile: ORCHESTRATOR_STATE_FILE,
    orchestratorRunsFile: ORCHESTRATOR_RUNS_FILE,
    orchestratorLockFile: ORCHESTRATOR_LOCK_FILE,
    railwayVolumeMountPath: process.env.RAILWAY_VOLUME_MOUNT_PATH ?? null,
  };
}
