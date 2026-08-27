import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  DATA_DIR,
  BRAIN_DIR,
  EXPERIMENTS_FILE,
  PAPER_MANIFEST_FILE,
  AUTONOMOUS_PAPER_STATE_FILE,
  AUTONOMOUS_PAPER_TRADES_FILE,
  ORCHESTRATOR_STATE_FILE,
  ORCHESTRATOR_RUNS_FILE,
  ORCHESTRATOR_LOCK_FILE,
  runtimePathSummary,
} from "../runtime/runtimePaths.js";

const DEFAULT_LOOP_MINUTES = 5;
const DEFAULT_RESEARCH_HOURS = 12;
const DEFAULT_RESEARCH_RETRY_MINUTES = 60;
const DEFAULT_LOCK_STALE_MINUTES = 180;

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveEnv(name, fallback) {
  const value = finiteNumber(process.env[name], fallback);
  return value > 0 ? value : fallback;
}

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJsonAtomic(filePath, value) {
  ensureParent(filePath);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return structuredClone(fallback);
  }
}

function appendNdjson(filePath, value) {
  ensureParent(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function iso(value = new Date()) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function elapsedMs(timestamp, nowMs) {
  if (!timestamp) return Infinity;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? nowMs - parsed : Infinity;
}

export function createOrchestratorState() {
  return {
    schemaVersion: 1,
    mode: "paper-only",
    liveTradingAllowed: false,
    cycles: 0,
    startedAt: new Date().toISOString(),
    lastCycleStartedAt: null,
    lastCycleCompletedAt: null,
    lastResearchAttemptAt: null,
    lastResearchSuccessAt: null,
    lastResearchStatus: null,
    lastPaperAttemptAt: null,
    lastPaperSuccessAt: null,
    lastPaperStatus: null,
    lastError: null,
  };
}

export function shouldRunResearch(
  state,
  now = new Date(),
  options = {}
) {
  if (options.forceResearch === true) return true;
  if (options.researchEnabled === false) return false;

  const nowMs = now.getTime();
  const researchIntervalMs =
    (options.researchHours ?? DEFAULT_RESEARCH_HOURS) * 60 * 60 * 1000;
  const retryIntervalMs =
    (options.researchRetryMinutes ?? DEFAULT_RESEARCH_RETRY_MINUTES) * 60 * 1000;

  if (!state.lastResearchAttemptAt) return true;

  if (state.lastResearchStatus === "failed") {
    return elapsedMs(state.lastResearchAttemptAt, nowMs) >= retryIntervalMs;
  }

  const anchor = state.lastResearchSuccessAt ?? state.lastResearchAttemptAt;
  return elapsedMs(anchor, nowMs) >= researchIntervalMs;
}

export function assertPersistenceReady(options = {}) {
  const dataDir = path.resolve(options.dataDir ?? DATA_DIR);
  const railwayDetected = options.railwayDetected ?? Boolean(
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.RAILWAY_ENVIRONMENT_ID ||
    process.env.RAILWAY_SERVICE_ID
  );
  const configured = options.zenbladeDataDirConfigured ?? Boolean(
    process.env.ZENBLADE_DATA_DIR
  );

  if (railwayDetected && !configured) {
    throw new Error(
      "railway_persistent_storage_not_configured: mount a Railway Volume and set ZENBLADE_DATA_DIR to its mount path"
    );
  }

  fs.mkdirSync(dataDir, { recursive: true });
  const probe = path.join(dataDir, ".zenblade-storage-probe");
  const token = `${Date.now()}:${process.pid}:${crypto.randomUUID()}`;
  fs.writeFileSync(probe, token, "utf8");
  const readBack = fs.readFileSync(probe, "utf8");
  fs.rmSync(probe, { force: true });

  if (readBack !== token) {
    throw new Error("persistent_storage_readback_failed");
  }

  return {
    ok: true,
    dataDir,
    railwayDetected,
    configured,
  };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function acquireOrchestratorLock(options = {}) {
  const filePath = options.filePath ?? ORCHESTRATOR_LOCK_FILE;
  const staleMinutes = options.staleMinutes ?? DEFAULT_LOCK_STALE_MINUTES;
  const now = options.now ?? new Date();
  const host = options.host ?? os.hostname();
  const pid = options.pid ?? process.pid;
  const staleMs = staleMinutes * 60 * 1000;

  ensureParent(filePath);

  const tryAcquire = () => {
    const payload = {
      pid,
      host,
      acquiredAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      railwayDeploymentId: process.env.RAILWAY_DEPLOYMENT_ID ?? null,
      mode: "paper-only",
      liveTradingAllowed: false,
    };

    const fd = fs.openSync(filePath, "wx");
    try {
      fs.writeFileSync(fd, JSON.stringify(payload, null, 2), "utf8");
    } finally {
      fs.closeSync(fd);
    }
    return payload;
  };

  try {
    const payload = tryAcquire();
    return { acquired: true, payload, filePath };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  const existing = readLock(filePath);
  const heartbeatMs = Date.parse(existing?.heartbeatAt ?? existing?.acquiredAt ?? "");
  const ageMs = Number.isFinite(heartbeatMs) ? now.getTime() - heartbeatMs : Infinity;
  const sameHostDeadPid = existing?.host === host && !pidAlive(Number(existing?.pid));
  const stale = ageMs >= staleMs;

  if (sameHostDeadPid || stale || !existing) {
    fs.rmSync(filePath, { force: true });
    const payload = tryAcquire();
    return { acquired: true, payload, filePath, recoveredStaleLock: true };
  }

  return {
    acquired: false,
    filePath,
    holder: existing,
    reason: "orchestrator_already_running",
  };
}

export function heartbeatOrchestratorLock(lock, now = new Date()) {
  if (!lock?.acquired) return;
  const existing = readLock(lock.filePath) ?? lock.payload;
  const payload = {
    ...existing,
    heartbeatAt: now.toISOString(),
  };
  writeJsonAtomic(lock.filePath, payload);
  lock.payload = payload;
}

export function releaseOrchestratorLock(lock) {
  if (!lock?.acquired) return;
  const existing = readLock(lock.filePath);
  if (!existing || (existing.pid === lock.payload.pid && existing.host === lock.payload.host)) {
    fs.rmSync(lock.filePath, { force: true });
  }
  lock.acquired = false;
}

function configurePersistentEnvironment() {
  process.env.BRAIN_DATA_DIR ??= BRAIN_DIR;
  process.env.BRAIN_EXPERIMENTS_FILE ??= EXPERIMENTS_FILE;
  process.env.PAPER_APPROVED_MANIFEST ??= PAPER_MANIFEST_FILE;
  process.env.AUTONOMOUS_PAPER_STATE ??= AUTONOMOUS_PAPER_STATE_FILE;
  process.env.AUTONOMOUS_PAPER_TRADES ??= AUTONOMOUS_PAPER_TRADES_FILE;
}

async function loadDefaultDependencies() {
  configurePersistentEnvironment();

  const [
    experimentStore,
    legacyResearch,
    seedKnowledge,
    strategyLab,
    walkForwardLab,
    paperPromotion,
    autonomousPaper,
  ] = await Promise.all([
    import("../brain/experimentStore.js"),
    import("../brain/importLegacyResearchMemory.js"),
    import("../brain/importSeedKnowledge.js"),
    import("../lab/strategyLab.js"),
    import("../lab/walkForwardLab.js"),
    import("../paper/paperPromotionGate.js"),
    import("../paper/autonomousPaperEngine.js"),
  ]);

  return {
    loadExperiments: experimentStore.loadExperiments,
    importLegacyResearchMemory: legacyResearch.importLegacyResearchMemory,
    importSeedKnowledge: seedKnowledge.importSeedKnowledge,
    runStrategyLab: strategyLab.runStrategyLab,
    runWalkForwardLab: walkForwardLab.runWalkForwardLab,
    runPaperPromotionGate: paperPromotion.runPaperPromotionGate,
    runAutonomousPaperOnce: autonomousPaper.runAutonomousPaperOnce,
  };
}

async function ensureBrainSeed(dependencies) {
  const before = dependencies.loadExperiments();
  if (before.length > 0) {
    return { seeded: false, experiments: before.length };
  }

  const research = dependencies.importLegacyResearchMemory();
  const history = dependencies.importSeedKnowledge();
  const after = dependencies.loadExperiments();

  return {
    seeded: true,
    experiments: after.length,
    research,
    history,
  };
}

function summarizeLab(results) {
  const list = Array.isArray(results) ? results : [];
  return {
    evaluated: list.length,
    candidates: list.filter((item) => item?.verdict?.status === "candidate").length,
    watch: list.filter((item) => item?.verdict?.status === "watch").length,
    rejected: list.filter((item) => item?.verdict?.status === "rejected").length,
  };
}

function summarizeWalkForward(results) {
  const list = Array.isArray(results) ? results : [];
  return {
    evaluated: list.length,
    validated: list.filter((item) => item?.result?.verdict?.status === "validated").length,
    watch: list.filter((item) => item?.result?.verdict?.status === "watch").length,
    rejected: list.filter((item) => item?.result?.verdict?.status === "rejected").length,
  };
}

function summarizePaper(result) {
  return {
    approvals: result?.approvals ?? 0,
    balanceUSDT: result?.state?.balance ?? null,
    openPositions: result?.state?.openPositions?.length ?? 0,
    closedTrades: result?.trades?.length ?? 0,
    drawdownPct: result?.riskState?.drawdownPct ?? null,
    dailyLossPct: result?.riskState?.dayLossPct ?? null,
    pausedReason: result?.state?.pausedReason ?? null,
  };
}

export async function runAutonomousCycle(options = {}) {
  const now = options.now ?? new Date();
  const stateFile = options.stateFile ?? ORCHESTRATOR_STATE_FILE;
  const runsFile = options.runsFile ?? ORCHESTRATOR_RUNS_FILE;
  const dependencies = options.dependencies ?? await loadDefaultDependencies();

  const state = readJson(stateFile, createOrchestratorState());
  if (state.mode !== "paper-only" || state.liveTradingAllowed !== false) {
    throw new Error("unsafe_orchestrator_state");
  }

  const cycleId = `${now.toISOString()}:${crypto.randomUUID()}`;
  state.cycles = Number(state.cycles ?? 0) + 1;
  state.lastCycleStartedAt = now.toISOString();
  state.lastError = null;
  writeJsonAtomic(stateFile, state);

  const record = {
    schemaVersion: 1,
    cycleId,
    startedAt: now.toISOString(),
    completedAt: null,
    mode: "paper-only",
    liveTradingAllowed: false,
    paths: runtimePathSummary(),
    seed: null,
    research: null,
    promotion: null,
    paper: null,
    errors: [],
  };

  try {
    record.seed = await ensureBrainSeed(dependencies);
  } catch (error) {
    record.errors.push({ stage: "seed", message: error.message });
  }

  const researchDue = shouldRunResearch(state, now, {
    forceResearch: options.forceResearch,
    researchEnabled: options.researchEnabled ?? true,
    researchHours: options.researchHours ?? DEFAULT_RESEARCH_HOURS,
    researchRetryMinutes:
      options.researchRetryMinutes ?? DEFAULT_RESEARCH_RETRY_MINUTES,
  });

  if (researchDue) {
    state.lastResearchAttemptAt = now.toISOString();
    record.research = { status: "running", lab: null, walkForward: null };
    writeJsonAtomic(stateFile, state);

    try {
      const labResults = await dependencies.runStrategyLab();
      record.research.lab = summarizeLab(labResults);

      const walkForwardResults = await dependencies.runWalkForwardLab();
      record.research.walkForward = summarizeWalkForward(walkForwardResults);

      const promotion = dependencies.runPaperPromotionGate();
      record.promotion = {
        approved: promotion?.approvals?.length ?? 0,
        manifestMode: promotion?.manifest?.mode ?? null,
        liveTradingAllowed: promotion?.manifest?.liveTradingAllowed ?? null,
      };

      record.research.status = "success";
      state.lastResearchStatus = "success";
      state.lastResearchSuccessAt = new Date().toISOString();
    } catch (error) {
      record.research.status = "failed";
      record.errors.push({ stage: "research", message: error.message });
      state.lastResearchStatus = "failed";
      state.lastError = `research:${error.message}`;
    }
  } else {
    record.research = { status: "not_due" };
  }

  if (!fs.existsSync(PAPER_MANIFEST_FILE) && !record.promotion) {
    try {
      const experiments = dependencies.loadExperiments();
      const hasWalkForwardEvidence = experiments.some(
        (item) => item.experimentType === "strategy_lab_walk_forward"
      );
      if (hasWalkForwardEvidence) {
        const promotion = dependencies.runPaperPromotionGate();
        record.promotion = {
          approved: promotion?.approvals?.length ?? 0,
          manifestMode: promotion?.manifest?.mode ?? null,
          liveTradingAllowed: promotion?.manifest?.liveTradingAllowed ?? null,
        };
      }
    } catch (error) {
      record.errors.push({ stage: "promotion_recovery", message: error.message });
    }
  }

  if (options.paperEnabled !== false) {
    state.lastPaperAttemptAt = new Date().toISOString();
    try {
      const paperResult = await dependencies.runAutonomousPaperOnce();
      record.paper = { status: "success", ...summarizePaper(paperResult) };
      state.lastPaperStatus = "success";
      state.lastPaperSuccessAt = new Date().toISOString();
    } catch (error) {
      record.paper = { status: "failed", message: error.message };
      record.errors.push({ stage: "paper", message: error.message });
      state.lastPaperStatus = "failed";
      state.lastError = `paper:${error.message}`;
    }
  } else {
    record.paper = { status: "disabled" };
  }

  const completedAt = new Date();
  record.completedAt = completedAt.toISOString();
  state.lastCycleCompletedAt = completedAt.toISOString();
  writeJsonAtomic(stateFile, state);
  appendNdjson(runsFile, record);

  return { state, record };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runAutonomousLoop(options = {}) {
  const loopMinutes = options.loopMinutes ?? positiveEnv(
    "AUTONOMOUS_LOOP_MINUTES",
    DEFAULT_LOOP_MINUTES
  );
  const researchHours = options.researchHours ?? positiveEnv(
    "AUTONOMOUS_RESEARCH_HOURS",
    DEFAULT_RESEARCH_HOURS
  );
  const researchRetryMinutes = options.researchRetryMinutes ?? positiveEnv(
    "AUTONOMOUS_RESEARCH_RETRY_MINUTES",
    DEFAULT_RESEARCH_RETRY_MINUTES
  );
  const staleMinutes = options.lockStaleMinutes ?? positiveEnv(
    "AUTONOMOUS_LOCK_STALE_MINUTES",
    DEFAULT_LOCK_STALE_MINUTES
  );
  const runOnce = options.runOnce ?? boolEnv("AUTONOMOUS_RUN_ONCE", false);

  const persistence = assertPersistenceReady(options.persistenceOptions);
  configurePersistentEnvironment();

  const lock = acquireOrchestratorLock({ staleMinutes });
  if (!lock.acquired) {
    throw new Error(
      `orchestrator_already_running:${JSON.stringify(lock.holder ?? {})}`
    );
  }

  const shutdown = () => {
    releaseOrchestratorLock(lock);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  process.once("exit", shutdown);

  console.log("=== Autonomous Research Orchestrator v1 ===");
  console.log("Mode: PAPER ONLY — live trading disabled");
  console.log(`Data dir: ${persistence.dataDir}`);
  console.log(`Loop: ${loopMinutes} min | research: ${researchHours} h`);
  console.log(`Run once: ${runOnce}`);

  try {
    do {
      heartbeatOrchestratorLock(lock);
      const cycle = await runAutonomousCycle({
        researchHours,
        researchRetryMinutes,
      });
      heartbeatOrchestratorLock(lock);

      const r = cycle.record;
      console.log(
        `[${r.completedAt}] cycle=${cycle.state.cycles} ` +
        `research=${r.research?.status ?? "-"} ` +
        `approved=${r.promotion?.approved ?? "-"} ` +
        `paper=${r.paper?.status ?? "-"} ` +
        `balance=${r.paper?.balanceUSDT ?? "-"} ` +
        `errors=${r.errors.length}`
      );

      if (!runOnce) await sleep(loopMinutes * 60 * 1000);
    } while (!runOnce);
  } finally {
    releaseOrchestratorLock(lock);
  }
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  runAutonomousLoop().catch((error) => {
    console.error("Autonomous orchestrator failed:", error);
    process.exitCode = 1;
  });
}
