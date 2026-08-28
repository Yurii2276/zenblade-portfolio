import {
  acquireOrchestratorLock,
  assertPersistenceReady,
  heartbeatOrchestratorLock,
  releaseOrchestratorLock,
  runAutonomousCycle,
} from "./orchestrator.js";
import { recoverRailwayDeploymentLock } from "./deploymentLockHandoff.js";
import { runPaperFeedback } from "../paper/paperFeedback.js";

const DEFAULT_LOOP_MINUTES = 5;
const DEFAULT_RESEARCH_HOURS = 12;
const DEFAULT_RESEARCH_RETRY_MINUTES = 60;
const DEFAULT_LOCK_STALE_MINUTES = 180;

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveEnv(name, fallback) {
  const value = finite(process.env[name], fallback);
  return value > 0 ? value : fallback;
}

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function summarizeFeedback(result) {
  return {
    status: result?.status ?? "unknown",
    watch: result?.watch ?? 0,
    proven: result?.proven ?? 0,
    demoted: result?.demoted ?? 0,
    activeApprovals: result?.activeApprovals ?? 0,
  };
}

export async function runAutonomousFeedbackLoop(options = {}) {
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
  const feedbackRunner = options.feedbackRunner ?? runPaperFeedback;
  const cycleRunner = options.cycleRunner ?? runAutonomousCycle;
  const handoffRunner = options.handoffRunner ?? recoverRailwayDeploymentLock;

  const persistence = assertPersistenceReady(options.persistenceOptions);

  const handoff = handoffRunner({
    handoffGraceMinutes: options.handoffGraceMinutes,
  });
  if (handoff?.recovered) {
    console.log(
      `Recovered stale Railway lock from deployment ${handoff.previousDeploymentId} ` +
        `for ${handoff.currentDeploymentId}.`
    );
  }

  const lock = acquireOrchestratorLock({ staleMinutes });
  if (!lock.acquired) {
    throw new Error(
      `orchestrator_already_running:${JSON.stringify(lock.holder ?? {})}`
    );
  }

  const shutdown = () => releaseOrchestratorLock(lock);
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  process.once("exit", shutdown);

  console.log("=== Autonomous Research + Paper Feedback Loop v1 ===");
  console.log("Mode: PAPER ONLY — live trading disabled");
  console.log(`Data dir: ${persistence.dataDir}`);
  console.log(`Loop: ${loopMinutes} min | research: ${researchHours} h`);
  console.log(`Run once: ${runOnce}`);

  try {
    do {
      heartbeatOrchestratorLock(lock);

      // Apply any previously known demotion before the next trading cycle.
      let preFeedback = null;
      try {
        preFeedback = summarizeFeedback(feedbackRunner());
      } catch (error) {
        console.error(`Pre-cycle paper feedback failed: ${error.message}`);
      }

      const cycle = await cycleRunner({
        researchHours,
        researchRetryMinutes,
      });

      let postFeedback;
      try {
        postFeedback = summarizeFeedback(feedbackRunner());
      } catch (error) {
        postFeedback = {
          status: "failed",
          watch: 0,
          proven: 0,
          demoted: 0,
          activeApprovals: 0,
          error: error.message,
        };
        console.error(`Post-cycle paper feedback failed: ${error.message}`);
      }

      heartbeatOrchestratorLock(lock);

      const record = cycle.record;
      console.log(
        `[${record.completedAt}] cycle=${cycle.state.cycles} ` +
        `research=${record.research?.status ?? "-"} ` +
        `approved=${record.promotion?.approved ?? "-"} ` +
        `paper=${record.paper?.status ?? "-"} ` +
        `balance=${record.paper?.balanceUSDT ?? "-"} ` +
        `feedback=${postFeedback.status} ` +
        `watch=${postFeedback.watch} proven=${postFeedback.proven} ` +
        `demoted=${postFeedback.demoted} active=${postFeedback.activeApprovals} ` +
        `errors=${record.errors.length}`
      );

      if (preFeedback?.demoted > 0) {
        console.log(`Pre-cycle safety: ${preFeedback.demoted} paper candidate(s) already demoted.`);
      }

      if (!runOnce) await sleep(loopMinutes * 60 * 1000);
    } while (!runOnce);
  } finally {
    releaseOrchestratorLock(lock);
  }
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  runAutonomousFeedbackLoop().catch((error) => {
    console.error("Autonomous feedback loop failed:", error);
    process.exitCode = 1;
  });
}
