import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recoverRailwayDeploymentLock } from "./deploymentLockHandoff.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "railway-lock-handoff-"));
const lockFile = path.join(tempDir, "orchestrator.lock");

function writeLock({ deploymentId, heartbeatAt }) {
  fs.writeFileSync(
    lockFile,
    JSON.stringify({
      pid: 25,
      host: "old-container",
      acquiredAt: "2026-08-28T09:00:00.000Z",
      heartbeatAt,
      railwayDeploymentId: deploymentId,
      mode: "paper-only",
      liveTradingAllowed: false,
    }),
    "utf8"
  );
}

try {
  const noLock = recoverRailwayDeploymentLock({
    filePath: lockFile,
    currentDeploymentId: "new-deploy",
    now: new Date("2026-08-28T10:30:00Z"),
  });
  assert.equal(noLock.recovered, false);
  assert.equal(noLock.reason, "no_lock");

  writeLock({
    deploymentId: "same-deploy",
    heartbeatAt: "2026-08-28T10:20:00.000Z",
  });
  const same = recoverRailwayDeploymentLock({
    filePath: lockFile,
    currentDeploymentId: "same-deploy",
    now: new Date("2026-08-28T10:30:00Z"),
  });
  assert.equal(same.recovered, false);
  assert.equal(same.reason, "same_deployment");
  assert.equal(fs.existsSync(lockFile), true);

  writeLock({
    deploymentId: "old-deploy",
    heartbeatAt: "2026-08-28T10:25:00.000Z",
  });
  const fresh = recoverRailwayDeploymentLock({
    filePath: lockFile,
    currentDeploymentId: "new-deploy",
    now: new Date("2026-08-28T10:30:00Z"),
    handoffGraceMinutes: 10,
  });
  assert.equal(fresh.recovered, false);
  assert.equal(fresh.reason, "previous_deployment_heartbeat_still_fresh");
  assert.equal(fs.existsSync(lockFile), true);

  writeLock({
    deploymentId: "old-deploy",
    heartbeatAt: "2026-08-28T09:40:00.000Z",
  });
  const stale = recoverRailwayDeploymentLock({
    filePath: lockFile,
    currentDeploymentId: "new-deploy",
    now: new Date("2026-08-28T10:18:00Z"),
    handoffGraceMinutes: 10,
  });
  assert.equal(stale.recovered, true);
  assert.equal(stale.reason, "previous_railway_deployment_stale");
  assert.equal(stale.previousDeploymentId, "old-deploy");
  assert.equal(stale.currentDeploymentId, "new-deploy");
  assert.equal(fs.existsSync(lockFile), false);

  console.log("Railway deployment lock handoff tests passed.");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
