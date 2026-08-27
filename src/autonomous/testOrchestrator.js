import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquireOrchestratorLock,
  assertPersistenceReady,
  createOrchestratorState,
  releaseOrchestratorLock,
  runAutonomousCycle,
  shouldRunResearch,
} from "./orchestrator.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-v1-"));

try {
  const persistence = assertPersistenceReady({
    dataDir: tempDir,
    railwayDetected: false,
    zenbladeDataDirConfigured: false,
  });
  assert.equal(persistence.ok, true);

  assert.throws(
    () =>
      assertPersistenceReady({
        dataDir: tempDir,
        railwayDetected: true,
        zenbladeDataDirConfigured: false,
      }),
    /railway_persistent_storage_not_configured/
  );

  const lockFile = path.join(tempDir, "lock", "orchestrator.lock");
  const firstLock = acquireOrchestratorLock({
    filePath: lockFile,
    staleMinutes: 60,
  });
  assert.equal(firstLock.acquired, true);

  const secondLock = acquireOrchestratorLock({
    filePath: lockFile,
    staleMinutes: 60,
  });
  assert.equal(secondLock.acquired, false);
  assert.equal(secondLock.reason, "orchestrator_already_running");
  releaseOrchestratorLock(firstLock);
  assert.equal(fs.existsSync(lockFile), false);

  const baseState = createOrchestratorState();
  const firstResearch = shouldRunResearch(baseState, new Date("2026-08-27T12:00:00Z"), {
    researchHours: 12,
  });
  assert.equal(firstResearch, true);

  const recentSuccess = {
    ...baseState,
    lastResearchAttemptAt: "2026-08-27T10:00:00Z",
    lastResearchSuccessAt: "2026-08-27T10:00:00Z",
    lastResearchStatus: "success",
  };
  assert.equal(
    shouldRunResearch(recentSuccess, new Date("2026-08-27T12:00:00Z"), {
      researchHours: 12,
    }),
    false
  );

  const failed = {
    ...baseState,
    lastResearchAttemptAt: "2026-08-27T10:00:00Z",
    lastResearchStatus: "failed",
  };
  assert.equal(
    shouldRunResearch(failed, new Date("2026-08-27T10:30:00Z"), {
      researchRetryMinutes: 60,
    }),
    false
  );
  assert.equal(
    shouldRunResearch(failed, new Date("2026-08-27T11:01:00Z"), {
      researchRetryMinutes: 60,
    }),
    true
  );

  const stateFile = path.join(tempDir, "state.json");
  const runsFile = path.join(tempDir, "runs.ndjson");
  const calls = [];
  const experiments = [];

  const dependencies = {
    loadExperiments() {
      calls.push("loadExperiments");
      return [...experiments];
    },
    importLegacyResearchMemory() {
      calls.push("seedResearch");
      experiments.push({ experimentType: "legacy", strategyId: "seed" });
      return { created: 1 };
    },
    importSeedKnowledge() {
      calls.push("seedHistory");
      return { created: 0 };
    },
    async runStrategyLab() {
      calls.push("lab");
      return [
        { verdict: { status: "candidate" } },
        { verdict: { status: "watch" } },
        { verdict: { status: "rejected" } },
      ];
    },
    async runWalkForwardLab() {
      calls.push("walkForward");
      experiments.push({
        experimentType: "strategy_lab_walk_forward",
        strategyId: "trendMomentum",
      });
      return [
        { result: { verdict: { status: "validated" } } },
        { result: { verdict: { status: "rejected" } } },
      ];
    },
    runPaperPromotionGate() {
      calls.push("promotion");
      return {
        approvals: [{ approvalId: "paper:test" }],
        manifest: { mode: "paper-only", liveTradingAllowed: false },
      };
    },
    async runAutonomousPaperOnce() {
      calls.push("paper");
      return {
        approvals: 1,
        state: {
          balance: 1001.25,
          openPositions: [],
          pausedReason: null,
        },
        trades: [{ netPnlUSDT: 1.25 }],
        riskState: {
          drawdownPct: 0,
          dayLossPct: 0,
        },
      };
    },
  };

  const firstCycle = await runAutonomousCycle({
    now: new Date("2026-08-27T12:00:00Z"),
    stateFile,
    runsFile,
    dependencies,
    forceResearch: true,
  });

  assert.equal(firstCycle.record.research.status, "success");
  assert.equal(firstCycle.record.research.lab.candidates, 1);
  assert.equal(firstCycle.record.research.walkForward.validated, 1);
  assert.equal(firstCycle.record.promotion.approved, 1);
  assert.equal(firstCycle.record.paper.status, "success");
  assert.equal(firstCycle.record.paper.balanceUSDT, 1001.25);
  assert.deepEqual(
    calls.filter((call) => ["lab", "walkForward", "promotion", "paper"].includes(call)),
    ["lab", "walkForward", "promotion", "paper"]
  );

  calls.length = 0;
  const secondCycle = await runAutonomousCycle({
    now: new Date("2026-08-27T12:05:00Z"),
    stateFile,
    runsFile,
    dependencies,
    researchHours: 12,
  });
  assert.equal(secondCycle.record.research.status, "not_due");
  assert.equal(calls.includes("lab"), false);
  assert.equal(calls.includes("walkForward"), false);
  assert.equal(calls.includes("paper"), true);
  assert.equal(secondCycle.state.cycles, 2);

  const runLines = fs
    .readFileSync(runsFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(runLines.length, 2);
  assert.equal(runLines[0].liveTradingAllowed, false);
  assert.equal(runLines[1].mode, "paper-only");

  console.log("Autonomous orchestrator tests passed.");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
